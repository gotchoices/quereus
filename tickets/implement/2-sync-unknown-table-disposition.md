description: Let an operator choose what the sync engine does with incoming changes for a table it no longer has — drop them, or keep them for later — and always report when this happens so a straggler's writes are never silently lost.
prereq: sync-retention-horizon
files:
  - packages/quereus-sync/src/sync/change-applicator.ts   # detection + diversion in resolve phase
  - packages/quereus-sync/src/sync/sync-context.ts         # expose basis-membership oracle
  - packages/quereus-sync/src/sync/sync-manager-impl.ts    # getTableSchema field, counter, GC, ctx wiring
  - packages/quereus-sync/src/sync/protocol.ts             # SyncConfig.unknownTableDisposition, ApplyResult field
  - packages/quereus-sync/src/sync/events.ts               # onUnknownTable event
  - packages/quereus-sync/src/metadata/keys.ts             # qt: quarantine key prefix + builders
  - packages/quereus-sync/src/metadata/quarantine.ts       # NEW: QuarantineStore
  - packages/quereus-sync/src/sync/store-adapter.ts        # keep defensive throw as net
  - docs/migration.md                                      # § 4 Contract / Unknown-table disposition
  - docs/sync.md                                           # config + events docs
difficulty: hard
----

# Unknown-table disposition + telemetry

`docs/migration.md` § 4 Contract (Unknown-table disposition) is the spec. After a
legacy basis table retires everywhere, a long-offline **straggler** reconnects and
sends changes referencing a table the receiver no longer has. Detection is
structural — the table simply isn't in the local basis, no version check. Today
this surfaces as `store-adapter.ts` resolving the table to `undefined` and
throwing `Table not found for external write`, which `throwIfApplyErrors` turns
into a whole-batch abort: the batch re-resolves forever (poison batch) and the
straggler learns nothing. This ticket replaces that with a **configured
disposition + always-on telemetry**.

Scope of this ticket: the wire delta path (`SyncManagerImpl.applyChanges` →
`change-applicator.ts`) — the straggler-delta case the spec describes. Two
dispositions are implemented: **`ignore`** and **`quarantine`** (default).
`store-and-forward` (the relay half) is parked in
`tickets/backlog/sync-unknown-table-store-and-forward.md` — it needs outbound
`getChangesSince` integration and is not required for the write-loss-protection
goal. The disposition type in this ticket is `'ignore' | 'quarantine'`; the
backlog ticket extends it.

## Where detection belongs

Detect during **Phase 1 resolution** (`resolveChange`), *not* in the store
adapter. The adapter is a pure store-write seam and has no `SyncConfig`,
`syncEvents`, or durable side-store; the change-applicator runs over `SyncContext`
which has all three. Detecting at Phase 1 also keeps diverted changes out of
`dataChangesToApply`, `appliedChanges`, and `commitChangeMetadata`, so **no CRDT
metadata (column versions / tombstones / change-log) is ever written for a table
the receiver does not have** — writing it would pollute the change log and break
`collectChangesSince`'s survivor-HLC invariant.

The basis-membership oracle is the existing `getTableSchema` callback (already a
private field on `SyncManagerImpl`, passed at construction): `getTableSchema(s,t)
=== undefined` ⇒ the table is outside the local basis. Expose it on `SyncContext`
(add `isTableInBasis(schema, table): boolean`, implemented on `SyncManagerImpl`
over `getTableSchema`).

```
SyncContext (add):
  isTableInBasis(schema: string, table: string): boolean
    // SyncManagerImpl: getTableSchema ? getTableSchema(s,t) !== undefined : true
```

When `getTableSchema` is **absent**, the receiver has no basis oracle, so detection
is inert and the legacy store-adapter throw remains the fallback (documented). The
store-adapter's `if (!table) throw` stays in place as a defensive net for the
absent-oracle case and any basis/store-ownership mismatch — but with detection
active it will not fire for genuinely-retired tables, because those changes never
reach the adapter.

## Flow in `applyChanges`

```
for each ChangeSet:
  compute in-batch table delta from schemaMigrations (create_table adds,
    drop_table removes) → batchCreated / batchDropped sets
  for each change (after the existing self-origin echo skip):
    known = (isTableInBasis(schema,table) || batchCreated.has) && !batchDropped.has
    if !known:
      divert raw Change into unknownByTable[(schema,table)]   // NOT resolved/applied
      continue
    ... existing resolveChange path ...

after admitGroup data+metadata land, but BEFORE the watermark would strand them:
  disposition = config.unknownTableDisposition (default 'quarantine')
  for each (schema,table) group in unknownByTable:
    if disposition === 'quarantine': quarantine.put(batch, changes)   // durable, idempotent
    increment counter; (ignore writes nothing durable)
  // fire telemetry AFTER successful admission
  emit onUnknownTable per (schema,table) group regardless of disposition
```

Durability ordering: the quarantine write must be **part of the admission unit**
(fold it into the `commitMetadata` batch in `change-applicator.ts`, which runs
after data apply and before `watermarkHLC` advances). Otherwise a crash after the
watermark advances but before quarantine is durable would lose the straggler's
change with no re-delivery. `ignore` writes nothing, so it is trivially safe.

## QuarantineStore (`metadata/quarantine.ts`, prefix `qt:`)

Durable hold for raw inbound `Change`s referencing an out-of-basis table, for
manual/late processing. Keyed so re-applying the same batch is idempotent (the
batch re-resolves on any unrelated abort) and so GC can prune by horizon.

```
qt:{schema}.{table}:{hlc_bytes}:{type}:{pk_json}[:{column}]
  value: serialized Change (verbatim wire change) + receivedAt (ms, for GC)
```

- HLC-in-key makes the entry idempotent: the same straggler change (same HLC)
  overwrites itself rather than accumulating. Reuse `serializeHLCForKey` /
  `encodePK` from `keys.ts` for parity with the change-log encoding.
- API: `put(batch, change, receivedAt)`, `list(schema?, table?)` (operator
  inspection), `pruneOlderThan(horizonCutoff): Promise<number>`.
- **GC at the retention horizon.** A quarantined change older than
  `config.retentionHorizonMs` was already outside the delivery guarantee — prune
  it. Add quarantine pruning alongside `pruneTombstones` (either inside it or a
  sibling `pruneQuarantine`, called from the same maintenance entry point), using
  the same `now - receivedAt > config.retentionHorizonMs` test.

## Telemetry (`events.ts`)

Always-on, regardless of disposition. Add to `SyncEventEmitter`:

```ts
interface UnknownTableEvent {
  readonly schema: string;
  readonly table: string;
  readonly disposition: 'ignore' | 'quarantine';
  readonly changeCount: number;     // changes diverted for this table this apply
  readonly siteId: SiteId;          // straggler origin (from the changeset)
  readonly latestHLC: HLC;          // max HLC among the diverted changes
}
onUnknownTable(listener: (e: UnknownTableEvent) => void): Unsubscribe;
```

Plus a cumulative counter on `SyncManager`, mirroring the engine's
`getMaterializedViewCollisionStats()` pattern:

```ts
getUnknownTableStats(): { ignored: number; quarantined: number;
                          byTable: Map<string /* schema.table */, number> };
```

`ApplyResult` (protocol.ts) gains `unknownTable?: number` (count of diverted
changes this apply) so callers see it without subscribing.

## Default disposition: `quarantine` (argued)

The spec's stated failure mode is "silent write loss the straggler never learns
about." Among the implemented options:

- **`ignore`** drops the changes (telemetry still fires) — the explicit opt-in for
  deployments that genuinely do not want to retain post-retirement straggler
  traffic. Write loss is intentional and observable, not silent.
- **`quarantine`** durably retains the changes for manual/late processing — no
  write loss, operator-inspectable, and **bounded**: quarantine entries GC at the
  retention horizon, so cost is zero in the common (no-straggler) case and bounded
  by the horizon otherwise.

`quarantine` is the safe out-of-box default: it is the minimal disposition that
prevents write loss while bounding storage via the same horizon tombstones use.
`ignore` is the deliberate opt-out. Document this tradeoff in `docs/migration.md`.

## Edge cases & interactions

- **In-batch DDL.** A `create_table` migration earlier in the batch makes a
  referenced table known even though `getTableSchema` (read at Phase 1, before the
  DDL executes in Phase 2) still returns `undefined`; a `drop_table` makes a
  currently-present table unknown. Detection must union the current basis with the
  batch's net created set and subtract its dropped set. **Test:** a changeset
  carrying `create_table Foo` + DML for `Foo` applies normally and quarantines
  nothing.
- **No CRDT-metadata pollution.** Diverted changes must never reach
  `commitChangeMetadata` / `columnVersions` / `tombstones` / `changeLog`. **Test:**
  after applying a straggler batch, `getChangesSince` for the unknown table yields
  nothing and the change log has no entry for it.
- **Self-origin first.** Detection runs *after* the existing
  `siteIdEquals(change.hlc.siteId, ctx.getSiteId())` echo skip, so a self-change is
  never quarantined.
- **Deletes and column changes alike.** Both `RowDeletion` and `ColumnChange` to an
  unknown table are diverted; quarantine stores the raw `Change` verbatim so a late
  replay has full fidelity.
- **Watermark atomicity / crash safety.** Quarantine durability lands inside the
  admission unit before `watermarkHLC` advances. **Test:** simulate a crash (skip
  watermark advance) → re-applying the batch re-quarantines idempotently (one entry
  per HLC, not duplicated).
- **Idempotent re-apply.** The same straggler batch applied twice yields exactly
  one quarantine entry per change (HLC-keyed). **Test asserts single entry.**
- **Telemetry fires for both dispositions.** `onUnknownTable` and the counter
  increment under `ignore` too (the operator must see straggler traffic even when
  dropping). **Test:** `ignore` fires the event and bumps `ignored`, writes no
  `qt:` entry.
- **GC at horizon.** A quarantine entry older than `retentionHorizonMs` is pruned;
  a fresh one survives. **Test** with a short horizon, mirroring the existing
  tombstone-TTL prune tests.
- **Absent `getTableSchema`.** Detection inert; legacy adapter throw remains.
  Documented; a relay-only coordinator without a basis oracle is unaffected.
- **Snapshot paths out of scope.** `applySnapshot` / `applySnapshotStream` bootstrap
  a peer's whole basis; an unknown table there is a different scenario (the offering
  peer's basis, not a straggler delta). This ticket scopes to the delta
  `applyChanges` path; the adapter's defensive throw still governs snapshots. Note
  the deferral in the ticket's doc update.
- **Mixed batch.** A batch with both known-table changes and unknown-table changes
  applies the known ones normally and diverts only the unknown ones — the unknown
  diversion must not abort or skip the known apply. **Test** a mixed changeset.

## TODO

- Add `unknownTableDisposition: 'ignore' | 'quarantine'` to `SyncConfig` (default
  `'quarantine'` in `DEFAULT_SYNC_CONFIG`) and `unknownTable?: number` to
  `ApplyResult`.
- Add `isTableInBasis(schema, table)` to `SyncContext`; implement on
  `SyncManagerImpl` over `getTableSchema`.
- Add `qt:` to `SYNC_KEY_PREFIX` + key builder / parser / scan-bounds in `keys.ts`;
  create `metadata/quarantine.ts` (`QuarantineStore` with `put` / `list` /
  `pruneOlderThan`, serializing the raw `Change` + `receivedAt`).
- In `change-applicator.ts`: compute the in-batch created/dropped table delta;
  divert unknown-table changes during resolution; fold quarantine writes into the
  `commitMetadata` batch; emit `onUnknownTable` and increment the counter after
  successful admission; populate `ApplyResult.unknownTable`.
- Add `UnknownTableEvent` + `onUnknownTable` to `events.ts`
  (`SyncEventEmitter` / `SyncEventEmitterImpl`); add `getUnknownTableStats()` to the
  `SyncManager` interface + impl (counter persisted in-memory on the manager).
- Add quarantine pruning to the maintenance path next to `pruneTombstones`, keyed
  off `config.retentionHorizonMs`.
- Keep the store-adapter `if (!table) throw` as the documented defensive net.
- Update `docs/migration.md` § 4 Contract (Unknown-table disposition: enumerate
  `ignore`/`quarantine`, default `quarantine` + rationale, note `store-and-forward`
  is the backlog relay ticket) and `docs/sync.md` (config field + `onUnknownTable`
  event + `getUnknownTableStats`).
- Tests (new spec, e.g. `test/sync/unknown-table-disposition.spec.ts`): cover every
  case in § Edge cases & interactions. Run `yarn build`, `yarn test`, and
  `packages/quereus` lint.
