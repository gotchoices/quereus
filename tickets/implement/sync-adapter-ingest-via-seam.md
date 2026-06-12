description: Migrate quereus-sync's store adapter onto StoreTable external writes + Database.ingestExternalRowChanges so inbound sync maintains secondary indexes, covering MVs, Database.watch, and (opt-in) FK actions
prereq: store-external-row-write
files:
  - packages/quereus-sync/src/sync/store-adapter.ts                  # the rewrite target
  - packages/quereus-store/src/common/store-table.ts                 # applyExternalRowChanges / readRowByPk (landed by prereq)
  - packages/quereus-store/src/common/store-module.ts                # getTableForExternalWrite (landed by prereq)
  - packages/quereus/src/core/database.ts                            # public ingestExternalRowChanges (~line 1826)
  - packages/quereus/src/core/database-internal.ts                   # ExternalRowChange / IngestExternalChangesOptions shapes
  - packages/quereus-sync/src/sync/change-applicator.ts              # call site (phase 2); throw semantics
  - packages/quereus-sync/src/sync/snapshot.ts                       # call site (bulk apply)
  - packages/quereus-sync/src/sync/snapshot-stream.ts                # call site (100-change flushes)
  - packages/quoomb-web/src/worker/quereus.worker.ts                 # adapter construction — options change
  - packages/quereus-sync/test/sync/store-adapter-pk-collation.spec.ts  # rework to new options
  - packages/quereus-sync/test/sync/sync-protocol-e2e.spec.ts        # "correct KV store" test constructs adapter with db:null — rework
  - packages/quereus-sync/README.md                                  # quick-start snippet shows old options
  - README.md                                                        # root sync snippet shows old options
  - docs/materialized-views.md                                       # § External row-change ingestion — note the sync adapter as a live seam consumer
difficulty: hard
----

# Sync store-adapter: apply via store entry point, report via the ingestion seam

## Design decision (resolved): seam + module entry point, NOT DML replay

The seam's decision matrix (docs/materialized-views.md § DML replay vs. the
ingestion seam) nominally recommends DML replay for low-volume sync. Evaluated
and **rejected** for this adapter; the seam is correct here:

1. **CRDT convergence requires trust-the-origin.** Column-level LWW merge
   produces row states no origin ever validated — a merged row combining
   peer1's column a with peer2's column b can violate a multi-column CHECK,
   and the adapter's UPSERT deliberately creates partial rows (PK + nulls)
   when column changes arrive before the rest of the row, which NOT NULL
   re-validation would reject. DML replay turns those rejections into poison
   batches (apply throws → metadata uncommitted → identical retry forever)
   and permanent replica divergence. Verbatim application is a correctness
   requirement of the CRDT model, not a shortcut.
2. **No remote-marking for module data events.** Replayed DML makes
   `StoreTable` emit its own data events without `remote: true`, so
   `SyncManagerImpl.handleDataChange` would re-record inbound changes as
   local with fresh HLCs — an echo loop. The DDL path needed dedicated
   `expectRemoteSchemaEvent` machinery for exactly this; a data-event
   analogue (pk-keyed expectations, cascade writes outside the expectation
   set) is more new machinery than the seam path, and more fragile.
3. **FK actions always re-run under DML**, double-applying a stream that
   already carries the origin's cascade effects; suppressing them via
   `pragma foreign_keys = off` is session-global state that leaks to
   interleaved local statements.
4. **Snapshot bootstrap is bulk** — whole-database apply in arbitrary table
   order (children can precede parents, which child-side FK validation under
   DML would reject) — the regime the matrix itself routes to the seam.

The secondary-index gap is closed module-side by the prereq ticket's
`StoreTable.applyExternalRowChanges`, not by the seam (index upkeep on direct
storage writes is store-module storage, out of the seam's contract).

## Adapter rewrite

`createStoreAdapter` options become:

```ts
export interface SyncStoreAdapterOptions {
  db: Database;                 // DDL execution + ingestExternalRowChanges (public on Database)
  storeModule: StoreModule;     // getTableForExternalWrite resolution
  events: StoreEventEmitter;    // remote:true module-event emission (unchanged ownership)
  /** Parent-side FK actions on inbound update/delete (seam facet). Default
   *  false — a replication stream usually carries origin cascade effects;
   *  opt in only when the deployment's stream does not. */
  applyForeignKeyActions?: boolean;
}
```

`getKVStore`, `getTableSchema`, and `collation` are **deleted**: table
resolution, schema access (`table.getSchema()`), and key encoding are now
owned by the resolved `StoreTable` — retiring the adapter-side
`buildDataKey`/`resolvePkKeyCollations` duplication the
`store-pk-collate-sync-adapter-rekey` fix had to patch. (No backwards-compat
shims; breaking the exported options type is fine.)

Per `applyToStore(dataChanges, schemaChanges, options)` invocation:

1. **Schema changes first** via `db.exec` — unchanged
   (`expectRemoteSchemaEvent` mechanism stays as is).
2. **Per table → per row group** (existing grouping): resolve the table via
   `storeModule.getTableForExternalWrite(db, schema, table)` (error per
   change when undefined); for an update group, pre-read the existing row via
   `table.readRowByPk(pk)` and merge column values onto it (or build the
   PK+nulls partial row when absent — preserved UPSERT semantics); a delete
   in the group wins over updates (preserved). Build one `ExternalRowOp`
   per row group.
3. **Apply** via `table.applyExternalRowChanges(ops)` → effective
   `BackingRowChange[]` with accurate before-images, no-ops suppressed
   (absent delete, value-identical upsert).
4. **Emit module events** from the effective changes with `remote: true`
   (adapter keeps owning emission; now also carries `oldRow` and
   `changedColumns` derived from the effective update). Suppressed no-ops
   emit nothing — new, deliberate behavior (today a blind delete always
   emits).
5. **Accumulate** `ExternalRowChange[]` (`{ schemaName, tableName, change }`)
   across all tables in apply order.
6. **After all storage writes**, one seam call per invocation:
   `db.ingestExternalRowChanges(batch, { applyForeignKeyActions })` —
   capture + MV facets default on. Skip when the batch is empty. A seam
   throw **propagates** out of `applyToStore`: derived effects unwound by the
   batch savepoint, storage rows stay applied, the sync layer leaves CRDT
   metadata uncommitted and re-resolves the same changes next attempt —
   re-application is idempotent (value-identical upserts suppress), then the
   seam retries. Changes recorded in `result.errors` are excluded from the
   seam batch.

Grouping collapses multiple same-row changes into ONE effective change per
row per invocation, so the seam's same-row-twice/before-image chaining rule
is satisfied trivially, with `oldRow` = the true pre-batch image.

## Edge cases & interactions

- **Covering MV over a synced table** converges after inbound insert /
  column-update / delete (the headline gap). MV-over-MV chains converge via
  the seam's flush worklist.
- **`Database.watch` on a synced table** fires post-apply with row-granular
  hits (capture facet). No double-fire: nothing bridges store module events
  into `notifyExternalChange` (verified — only core + its test reference it).
- **No CRDT echo through the seam**: capture feeds watch + assertions, never
  the sync change log (SyncManager records only from module events, which the
  adapter emits `remote: true`). Assert in a test: after apply, the local
  change log gains nothing.
- **Value-identical inbound upsert / absent delete**: fully suppressed — no
  storage write, no module event, no seam report, no MV/watch work.
- **Update for an absent row** → PK+nulls partial insert, reported to the
  seam as `op: 'insert'` (full row, column-count-correct — the seam
  shape-checks → MISUSE).
- **Delete + update for one row in one batch** → delete wins (existing
  behavior, preserved and now pinned by a test).
- **FK opt-in on**: inbound parent delete cascades to local children through
  the full DML pipeline — cascaded child writes emit module events WITHOUT
  `remote`, so they are recorded as local changes and propagate outward.
  Correct for the opt-in posture (the stream didn't carry origin cascades);
  document it on the option. Default-off: parent delete leaves local
  children untouched (test both).
- **Global-assertion failure on an inbound batch** (capture feeds commit-time
  assertions by design — delegated invariant maintenance): seam throws →
  poison-batch retry loop at the sync layer. Document on the adapter;
  detection/recovery policy is the host's.
- **Open explicit transaction on `db` while sync applies**: the seam joins
  the active transaction — derived effects then commit/roll back with it
  while the storage writes are already committed; a user rollback diverges
  MV/capture from storage (recoverable via MV refresh). Document: hosts
  should not drive `applyToStore` while holding an open explicit transaction.
  Likewise the seam must never be driven from within statement execution
  (exec-mutex deadlock) — `applyToStore` is host-driven today; state the
  constraint in the adapter doc comment.
- **Snapshot apply paths** (`snapshot.ts` whole-table batches,
  `snapshot-stream.ts` 100-change flushes): each flush is one seam batch —
  bounded-delta MV arms per change, full-rebuild MVs once per flush. Known
  bootstrap cost O(flushes × body); tracked separately in backlog
  (`snapshot-bootstrap-defer-mv-maintenance`), not solved here.
- **Mid-invocation partial failure** (table resolution fails after earlier
  tables applied): earlier tables' changes still go to the seam; failed
  changes land in `result.errors` and are excluded. (That the sync layer
  then commits metadata for errored changes is a pre-existing wart tracked
  in backlog `sync-apply-per-change-errors-ignored`.)
- **IndexedDB per-table stores**: `getTableForExternalWrite` →
  `StoreTable.ensureStore` resolves each table's own store — the job the
  deleted `getKVStore` option used to do.

## TODO

- [ ] Rewrite `store-adapter.ts` per the design: new options, table-resolved apply via `applyExternalRowChanges`, effective-change event emission, batched seam call with `applyForeignKeyActions` pass-through, seam-throw propagation
- [ ] Update `quoomb-web/src/worker/quereus.worker.ts` adapter construction (it already holds the `StoreModule`)
- [ ] Rework `store-adapter-pk-collation.spec.ts` to the new options (scenarios stay — they now pin table-owned keying)
- [ ] Rework the `sync-protocol-e2e.spec.ts` "correct KV store" test (constructs the adapter with `db: null` and a raw KV fake — needs a real `Database` + `StoreModule`, or retarget to the resolution path)
- [ ] New tests: covering-MV convergence over inbound insert/update/delete; `Database.watch` row-granular hits; secondary-index maintenance on inbound apply (query via the index returns the row); no-op suppression (no event, no seam report); delete-wins grouping; FK opt-in on/off; seam-throw propagation leaves CRDT metadata uncommitted and retry converges; no CRDT echo (change log unchanged after apply)
- [ ] Docs: quereus-sync README + root README snippets (new options); `docs/materialized-views.md` § External row-change ingestion — add the sync adapter as the live committed-KV consumer and cross-link the rejected-DML-replay rationale
- [ ] `yarn build` + `yarn test` green (sync package tests via `yarn workspace @quereus/sync run test`)
