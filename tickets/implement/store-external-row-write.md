description: StoreTable/StoreModule entry point for externally-applied row writes — committed-storage put/delete with secondary-index + stats maintenance, no events, no validation; returns effective BackingRowChanges
files:
  - packages/quereus-store/src/common/store-table.ts        # new applyExternalRowChanges + readRowByPk; reuses updateSecondaryIndexes / trackMutation / encodeDataKey / readEffectiveRowByKey
  - packages/quereus-store/src/common/store-module.ts       # new public getTableForExternalWrite (wraps private getOrReconnectTable, mirrors getBackingHostForTable's registration/wrapper check)
  - packages/quereus-store/src/common/index.ts              # export ExternalRowOp type
  - packages/quereus-store/src/common/backing-host.ts       # reference: StoreBackingHost deliberately does NOT maintain indexes — this entry point is the index-maintaining sibling for SOURCE tables
  - packages/quereus/src/vtab/backing-host.ts               # BackingRowChange (the returned effective-change shape; already consumed by ingestExternalRowChanges)
  - packages/quereus-store/README.md                        # core-exports table
difficulty: medium
----

# Store module: external row-write entry point (closes the sync secondary-index gap)

## Background

`quereus-sync`'s store adapter applies inbound replication writes directly to
the table's data `KVStore` (`kv.put`/`kv.delete`), duplicating `StoreTable`'s
key encoding (the duplication that caused the `store-pk-collate-sync-adapter-rekey`
fix) and **skipping the store module's own secondary-index maintenance and
stats tracking entirely** — the dark gap that fix ticket flagged as
out-of-scope. `StoreBackingHost` is not a usable surface for this: backing
tables carry no secondary indexes by design, so the host writes the data store
only.

This ticket adds the module-side entry point for externally-applied writes to
**source** tables. The follow-up ticket `sync-adapter-ingest-via-seam`
(prereq'd on this one) migrates the sync adapter onto it.

## Design

New op vocabulary (exported from `@quereus/store`):

```ts
/** One externally-applied row op against a source table's committed storage. */
export type ExternalRowOp =
	| { op: 'upsert'; row: Row }        // full table row in schema column order
	| { op: 'delete'; pk: SqlValue[] }; // PK values in PK-definition order
```

New public methods on `StoreTable`:

```ts
/** Effective (pending-over-committed) point read by PK values. Thin public
 *  wrapper over encodeDataKey + readEffectiveRowByKey (readLiveRowByPk is
 *  private today; expose rather than duplicate). */
readRowByPk(pk: SqlValue[]): Promise<Row | null>;

/**
 * Apply externally-originated row ops directly to COMMITTED storage:
 * data-key put/delete (table-owned key encoding), secondary-index
 * maintenance, and stats tracking. Deliberately NO module data events
 * (the external writer owns emission and the `remote` flag), NO
 * coordinator transaction, NO constraint validation (origin trusted).
 * Returns the EFFECTIVE per-op changes with accurate before-images,
 * suppressing no-ops: a delete of an absent key and a value-identical
 * upsert (rowsValueIdentical — byte-faithful, mirroring the backing-host
 * suppression contract) write nothing and report nothing.
 */
applyExternalRowChanges(ops: readonly ExternalRowOp[]): Promise<BackingRowChange[]>;
```

New public accessor on `StoreModule` (and on the `StoreTableModule` interface
if the sync adapter should stay typeable against the interface — implementer's
call; `StoreModule` concrete is acceptable since `quereus-sync` already
constructs it):

```ts
/** Resolve the live StoreTable for an externally-applied write. Mirrors
 *  getBackingHostForTable's resolution: registration check (including the
 *  IsolationModule wrapper's `underlying`), then getOrReconnectTable so a
 *  rehydrated-but-untouched table reconnects. Undefined when the table is
 *  not this module's. */
getTableForExternalWrite(db: Database, schemaName: string, tableName: string): StoreTable | undefined;
```

Implementation notes:

- Per op: pre-read the before-image via `readEffectiveRowByKey` (one point
  read — the same posture `StoreBackingHost.applyMaintenance` takes), then
  write the committed store directly (`store.put`/`store.delete`, NOT the
  coordinator), then `updateSecondaryIndexes(false, oldRow, newRow, oldPk, newPk)`
  — the existing non-transactional index path — then `trackMutation(±1, false)`.
- An upsert whose row changes no bytes (`rowsValueIdentical` against the
  effective existing row) is skipped wholesale: no storage write, no index
  touch, no stats delta, no reported change. This is the echo-prevention seam
  for the sync caller and matches the normative upsert-suppression contract in
  `vtab/backing-host.ts`.
- `upsert` key identity comes from `encodeDataKey(extract PK from row)` — the
  per-column key collations are therefore owned by the table, retiring the
  adapter-side `resolvePkKeyCollations` duplication.
- Route the data store through the lazy `ensureStore`/`openDataStore` path so
  the first external write to a freshly created table persists its DDL exactly
  like a first vtab write would.
- Document on the method that the writes are last-writer-wins against any
  concurrently pending local transaction on the same table (the pending
  coordinator batch may overwrite at its commit) — identical to the current
  raw-KV adapter posture, not a regression, but now stated.

## Edge cases & interactions

- **Delete of an absent key** → no storage op, no index op, no stats delta,
  empty contribution to the returned changes.
- **Value-identical upsert** → suppressed entirely (see above). A
  collation-equal / byte-different upsert (case-only rewrite under a NOCASE
  PK) IS a real update that replaces stored bytes at the same key and reports
  `update` — key identity via collation, skip via byte fidelity, exactly the
  backing-host split.
- **Upsert over an existing row with secondary indexes**: old index entries
  (keyed off the before-image) must be removed and new ones added — including
  when an indexed column changes while the PK doesn't, and the divergent-PK
  case cannot arise (key derived from row).
- **Partial indexes**: a row transitioning into/out of the predicate scope on
  upsert must add-without-stale-delete / delete-without-add — already handled
  by `updateSecondaryIndexes`'s two-halves guard; cover with a test.
- **PK collation divergence** (`collate binary` PK on a NOCASE store):
  keying must byte-match what `StoreTable` reads — the
  `store-pk-collate-sync-adapter-rekey` scenarios, now table-owned.
- **Table with no secondary indexes** → pure data write (fast path intact).
- **Concurrent pending local transaction on the same coordinator**: the
  external write lands in committed state immediately; the pending local batch
  may overwrite at commit (LWW). Documented, not prevented.
- **Stats**: deltas only for effective inserts/deletes (an update is net 0);
  the non-transactional `trackMutation` path flushes on its existing interval.
- **No events**: assert in tests that a subscribed `StoreEventEmitter` sees
  nothing from this entry point.

## TODO

- [ ] Add `ExternalRowOp` type and `StoreTable.applyExternalRowChanges` (pre-read → committed write → index maintenance → stats; no events; no-op suppression; returns effective `BackingRowChange[]`)
- [ ] Expose `StoreTable.readRowByPk` (public wrapper over the existing private `readLiveRowByPk`)
- [ ] Add `StoreModule.getTableForExternalWrite` mirroring `getBackingHostForTable` resolution (registration + isolation-wrapper check, `getOrReconnectTable`)
- [ ] Export the new type/surfaces from `packages/quereus-store/src/common/index.ts` and list them in the README core-exports table
- [ ] Tests (`packages/quereus-store/test/external-row-write.spec.ts`): index-store contents after external upsert/update/delete byte-match the engine-DML-written equivalent; no-op suppression (absent delete, identical upsert); partial-index scope transitions; divergent PK collation keying; no events emitted; stats delta
- [ ] `yarn workspace @quereus/store run test` + `yarn build` green
