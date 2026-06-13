description: Snapshot bootstrap defers MV maintenance + watch capture per flush and converges once at snapshot end, replacing O(flushes × body) full-rebuilds with a single dependency-ordered refresh
prereq: engine-converge-materialized-views
files:
  - packages/quereus-sync/src/sync/protocol.ts            # ApplyToStoreOptions: bootstrap / bootstrapFinalize / bootstrapTables
  - packages/quereus-sync/src/sync/snapshot-stream.ts     # DATA_FLUSH_SIZE flushes carry bootstrap; footer issues finalize
  - packages/quereus-sync/src/sync/snapshot.ts            # one-shot apply carries bootstrap; issues finalize
  - packages/quereus-sync/src/sync/store-adapter.ts       # skip seam on bootstrap flush; converge + coarse-notify on finalize
  - docs/materialized-views.md                            # § External row-change ingestion — bootstrap deferral note
difficulty: medium
----

# Snapshot bootstrap: defer MV maintenance to one end-of-snapshot convergence

## Context

Once the store adapter reports applied changes through
`Database.ingestExternalRowChanges` (the seam), every `applyToStore` invocation
is one seam batch. The streamed snapshot path
(`snapshot-stream.ts`) flushes data every 100 changes (`DATA_FLUSH_SIZE`), so
bootstrapping a large database over a table with a full-rebuild MV rebuilds that
MV **once per flush** — O(flushes × body) — and bounded-delta MVs pay per-change
maintenance for rows that are all brand new. The non-streamed `snapshot.ts`
applies everything in one call (already one rebuild) but still pays per-row
capture.

A snapshot bootstrap is a known-complete wholesale apply: MV maintenance and
`Database.watch` capture can be deferred for the whole load and converged once
at the end. This ticket wires that deferral on top of the engine convergence
primitive `Database.refreshAllMaterializedViews()` (prereq
`engine-converge-materialized-views`).

## Design

### Protocol signal (`protocol.ts`)

Extend `ApplyToStoreOptions`:

```ts
export interface ApplyToStoreOptions {
  readonly remote: boolean;
  /**
   * Bootstrap flush: one chunk of a known-complete wholesale snapshot load.
   * The adapter skips the engine seam (no per-flush MV maintenance, no
   * per-row watch capture) — storage rows are applied and remote module
   * events still emitted. A `bootstrapFinalize` call converges afterwards.
   */
  readonly bootstrap?: boolean;
  /**
   * Finalize a bootstrap: no data/schema changes carried. The adapter
   * converges every MV (`refreshAllMaterializedViews`) and fires a coarse
   * `notifyExternalChange` per bootstrapped table.
   */
  readonly bootstrapFinalize?: boolean;
  /** Bootstrapped base tables (for the finalize coarse watch notification). */
  readonly bootstrapTables?: ReadonlyArray<{ schema: string; table: string }>;
}
```

### Adapter behaviour (`store-adapter.ts`)

- **`bootstrap` flush:** apply schema changes and storage rows exactly as today
  (DDL via `db.exec`, `StoreTable.applyExternalRowChanges`, `emitEffectiveChanges`
  with `remote: true`) but **skip the `db.ingestExternalRowChanges` seam call
  entirely**. With MV maintenance + capture both deferred and FK actions off for
  a wholesale load, the seam would be a pure no-op that still opens a
  transaction/savepoint per flush — skipping it removes that overhead and the
  per-flush rebuild.
- **`bootstrapFinalize` call** (empty `dataChanges`/`schemaChanges`): call
  `db.refreshAllMaterializedViews()` to converge every MV in dependency order,
  then `db.notifyExternalChange(table, schema)` for each `bootstrapTables`
  entry so base-table `Database.watch` subscribers see one coarse invalidation
  instead of per-row capture. (Also notify each refreshed MV identifier
  returned by `refreshAllMaterializedViews` so MV watchers re-read.)
- **Non-bootstrap (incremental) calls:** unchanged — the seam is still called
  per invocation with capture + MV maintenance on.

### Snapshot paths

- **`snapshot-stream.ts`:** pass `bootstrap: true` on every `flushDataToStore`
  call. In the `footer` case — AFTER the final `flushDataToStore()` and the
  final metadata `batch.write()`, but BEFORE `clearSnapshotCheckpoint` and the
  `status: 'synced'` emit — issue the finalize:
  `await ctx.applyToStore([], [], { remote: true, bootstrapFinalize: true, bootstrapTables })`,
  where `bootstrapTables` is parsed from the accumulated `completedTables`
  (`schema.table` → `{ schema, table }`). Placing finalize before checkpoint
  clear means a finalize failure leaves the checkpoint in place so the transfer
  retries.
- **`snapshot.ts`:** pass `bootstrap: true` on the single `applyToStore` call
  (PHASE 2), then after the CRDT metadata is written (PHASE 3) and before the
  `status: 'synced'` emit, issue the same finalize with `bootstrapTables`
  derived from `snapshot.tables`.

Both paths keep `throwIfApplyErrors` on the data flush so a per-change storage
failure still aborts before finalize/synced.

## Edge cases & interactions

- **Failure mid-bootstrap (a flush throws):** no seam ran, so there are no
  derived effects to unwind; storage rows stay applied, CRDT metadata stays
  uncommitted, the checkpoint stays. Retry re-applies idempotently
  (value-identical upserts suppressed) and re-finalizes. Pin: a thrown flush
  leaves no MV converged and the snapshot retriable.
- **Finalize (`refreshAllMaterializedViews`) throws:** finalize runs before
  checkpoint clear / `synced`, so the checkpoint survives and the transfer
  retries; the storage rows are already correct, so the retry's finalize
  rebuilds cleanly.
- **Resumed / partial snapshot:** the sender skips already-completed tables;
  `completedTables` still accumulates the full set across the resume (seeded
  from the checkpoint in the `header` case), so finalize notifies every
  bootstrapped table and `refreshAllMaterializedViews` converges every MV (it
  re-reads complete sources regardless of which segment loaded them).
- **MV created mid-bootstrap** (via a `schema-migration` chunk → `create
  materialized view`): the create-time materialize builds against whatever
  source rows exist at that point (possibly partial) — wasteful but correct,
  since finalize refreshes it against the complete source.
- **Empty snapshot / no tables:** finalize with empty `bootstrapTables` and no
  MVs is a no-op.
- **No MVs but base-table watchers exist:** finalize still fires the coarse
  per-table `notifyExternalChange` so watchers re-read.
- **MV-over-MV:** convergence ordering is the engine primitive's
  responsibility (prereq ticket); this ticket just calls it once.
- **Incremental delta after bootstrap:** the next non-bootstrap `applyChanges`
  → `applyToStore` runs the seam normally (capture + per-row MV maintenance);
  bootstrap mode is per-call, not sticky. Pin a test that a post-bootstrap
  incremental write maintains the MV row-time (no stale plan left behind).
- **`remote` flag:** unchanged — bootstrap flushes still emit module events
  `remote: true` so the SyncManager never re-records the inbound rows.
- **Holding an explicit transaction:** the existing constraint (do not drive
  `applyToStore` while holding an open explicit transaction on `db`) still
  applies; finalize's refresh is commit-first like any refresh.

## TODO

- Extend `ApplyToStoreOptions` in `protocol.ts` with `bootstrap`,
  `bootstrapFinalize`, `bootstrapTables`.
- `store-adapter.ts`: skip the seam on `bootstrap`; on `bootstrapFinalize` call
  `db.refreshAllMaterializedViews()` then `db.notifyExternalChange` per
  bootstrapped table and per refreshed MV. Update the module-level contract
  comment (bootstrap deferral + finalize convergence).
- `snapshot-stream.ts`: pass `bootstrap: true` on each flush; issue finalize in
  the `footer` case before checkpoint clear; build `bootstrapTables` from
  `completedTables`.
- `snapshot.ts`: pass `bootstrap: true`; issue finalize before `synced`; build
  `bootstrapTables` from `snapshot.tables`.
- Tests (`packages/quereus-sync/test/sync/`):
  - Streamed bootstrap of a source with > `DATA_FLUSH_SIZE` rows feeding a
    full-rebuild MV: assert the seam (`db.ingestExternalRowChanges`) is NOT
    called during flushes (spy → 0 calls) and `refreshAllMaterializedViews` is
    called exactly once; MV contents correct after bootstrap.
  - Non-streamed `applySnapshot`: same convergence and correctness.
  - Watch capture: a `Database.watch` subscriber on a bootstrapped base table
    receives one coarse invalidation (via `notifyExternalChange`), not per-row
    capture.
  - Resumed/partial snapshot: finalize converges all MVs and notifies all
    completed tables.
  - Mid-bootstrap flush failure: no MV converged, snapshot retriable, retry
    succeeds.
  - Post-bootstrap incremental write maintains the MV (seam runs normally;
    no stale row-time plan).
- Update `docs/materialized-views.md` § External row-change ingestion with the
  bootstrap-deferral / finalize-convergence note.
- Run `yarn workspace @quereus/quereus-sync test` (and `yarn test` for the
  engine method interaction) plus `yarn lint`.
