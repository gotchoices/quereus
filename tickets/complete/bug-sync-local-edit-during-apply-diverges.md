description: A local edit made while an incoming sync change to the same row was being applied could leave the device's row and sync's records disagreeing, so the device served the wrong value and never sent its own edit. Now the local edit wins the cells it changed, and the row and the records always agree.
prereq: sync-serialize-applies
architecture: docs/sync-transactions.md#transactional-integrity-during-sync
files:
  - packages/quereus-sync/src/sync/local-write-tracker.ts # new: the tracker, plus the three NOTE limits
  - packages/quereus-sync/src/sync/change-applicator.ts # applyChanges → early clock merge + tracker; applyTrackedBatch; commitChangeMetadata / fileAtNextTick / recordsReplacedBy / columnsKeptPastDelete; drainTableGroup → drainTrackedTableGroup; rekeyAfterReplicatedKeyChange lost its re-read loop
  - packages/quereus-sync/src/sync/sync-manager-impl.ts # enqueueTransactionCommit → noteLocalWrites; trackLocalWrites; changedCellIndices / columnNameAt shared with recordColumnVersions
  - packages/quereus-sync/src/sync/store-adapter.ts # writeTableRows run inside db.ingestExternalRowWrite; withoutSupersededChanges; after-data DDL moved after the seam
  - packages/quereus-sync/src/sync/protocol.ts # ApplyToStoreOptions.supersededLocally
  - packages/quereus-sync/src/sync/sync-context.ts # SyncContext.trackLocalWrites
  - packages/quereus/src/core/database-external-changes.ts # ingestExternalRowWriteBatch; mutex hold split out (withExecMutex / ingestHoldingMutex)
  - packages/quereus/src/core/database.ts # Database.ingestExternalRowWrite
  - packages/quereus/src/core/database-internal.ts # DatabaseInternal.ingestExternalRowWrite
  - packages/quereus-sync/test/sync/concurrent-apply.spec.ts # reproduction tests
  - docs/sync-schema.md # apply-order diagram (updated in review)
  - docs/sync-transactions.md # new § Local writes during an apply; § Transactional Integrity pointer
  - docs/mv-ingestion.md # the new entry point
repro: verified
----

## What was wrong

An apply decides each incoming cell against its stored record (Phase 1), writes rows (Phase 2, store adapter), and files records (Phase 3, `fileAtNextTick` on the commit chain). A local edit committing in between raced both the row write and the record filing, and neither race was decided by timestamps. Result (measured in the fix ticket): the row said the local value while the records and everything served said the incoming one, or the local edit was dropped everywhere even when it was newer.

## What changed (the four parts of the ticket's design)

1. **Early clock merge.** `applyChanges` registers the tracker and calls `hlcManager.receive(watermark)` right after the drift check, before the pre-resolution `whenCommitsSettled()`. The merge in `fileAtNextTick` stays (idempotent; persisted there). The "on a mid-batch abort the clock does not advance" wording is gone. The old body of `applyChanges` moved verbatim into `applyTrackedBatch` so a `finally` can close the tracker.
2. **Tracker.** `LocalWriteTracker` (`local-write-tracker.ts`) holds two sets keyed by pk identity (same keying as the metadata stores; schema/table/column lowercased): changed **cells** and **replaced rows**. `SyncManagerImpl.enqueueTransactionCommit` calls `noteLocalWrites` synchronously (inside the engine commit, under the exec mutex), before chaining the capture, in a try/catch that logs so the capture is always chained. Update → cells whose values changed (`changedCellIndices`, now shared with `recordColumnVersions`); insert or delete → row replaced. Remote events and tables outside the basis are skipped. Empty registry = zero cost.
3. **Data write inside one mutex hold.** New engine entry point `Database.ingestExternalRowWrite(write, options)`: runs the caller's storage write and then the ingestion pipeline under one exec-mutex hold (`write` runs before `_ensureTransaction`, where an earlier write would have run). The store adapter's per-table loop is now `writeTableRows`, passed as that `write`; it drops what `ApplyToStoreOptions.supersededLocally` reports (`withoutSupersededChanges`) before building row ops.
4. **Filing.** `fileAtNextTick` closes the tracker as its first statement, leaves out superseded column/delete facts, and re-reads every remaining fact's stored record (`recordsReplacedBy`, parallel gets) instead of Phase 1's snapshot. It returns what it filed; the delete cleanup iterates only filed deletes. `applyChanges` reclassifies superseded applied changes as conflicts and leaves them out of `onRemoteChange` and of `bumpLastDirectlyMappedWrites`.

## Decisions the reviewer should check

- **Sibling engine method, not an overload.** `ingestExternalRowWrite` sits next to `ingestExternalRowChanges` (also added to `DatabaseInternal`). The snapshot-bootstrap spy now counts both entry points as a seam call.
- **Row-validating DDL moved after the seam call.** It used to run between the row writes and the seam call; `db.exec` takes the mutex the seam now holds across the writes. These alterations (`set not null`, `add constraint`, unique index) change no row's shape, so the seam reports the same rows. One visible difference: with `applyForeignKeyActions` on, an FK constraint added by the same batch's `add constraint` is no longer in place when the seam's FK actions run. Arguably more faithful (the origin recorded those rows before the constraint existed), but it is a change.
- **Bootstrap flush keeps its current path** (row writes outside any hold, seam skipped); snapshots carry no tracker.
- **A local insert marks the row as replaced, not just every cell.** The ticket said "insert: every column". Marking the row also makes an incoming *delete* of that key lose, which closes a gap: a local insert landing after the data write applied an incoming delete would otherwise have its records swept by the delete's cleanup (row present, no records). An incoming delete still beats local *cell edits*, as the ticket specifies.
- **`ResolvedChange.oldColumnVersion` / `oldTombstone` removed.** Filing always re-reads, so Phase 1's snapshot was dead, and so was `rekeyAfterReplicatedKeyChange`'s re-read loop after the re-key pass. That loop's job is now done by the filing's re-read.
- **Delete cleanup's `keepColumns` minus superseded columns** (`columnsKeptPastDelete`). Under `allowResurrection`, a resurrecting write the adapter skipped never reached the row, so its cell record must go with the delete. This matches what a non-racing apply produces.
- **The held-change drain uses the tracker too** (`drainTableGroup` → `drainTrackedTableGroup`). Same race, same shared filing. Held changes' clocks were merged when they first arrived, so no early merge is needed there. Superseded entries count as `skipped` in `onHeldChangesDrained`.
- **The NOTE at `isFirstEditOfUnrecordedRow`** that described this race was replaced with a plain description of how it is now handled.

## Tests added (all in `test/sync/concurrent-apply.spec.ts`)

One table-driven block over the ticket's cases: three windows (new row edited after the data write; existing row edited before it; existing row edited after it) × two sender clocks (5 s behind, 5 s ahead). Each asserts that the row's `qty` is 2, that the stored `qty` record is 2 with this site's id and an HLC above the incoming change's (so it also wins on the sender), that `getChangesToPush` carries exactly `qty = 2`, and that `repairChangeLog() === 0`. The new-row case also checks that `note` is `'one'` in both the row and its record.

Plus one case: a local delete before the data write against an incoming `qty` edit leaves no row, a tombstone, no `qty` record, and `repairChangeLog() === 0`.

I checked that each part is load-bearing by disabling it temporarily:
- tracker answers `false` → all 7 fail;
- early merge removed → the 3 "ahead" cases fail (on the HLC assertion);
- adapter ignores the predicate → the 2 "before" cases and the delete case fail.

Existing tests adjusted: `sync-manager.spec.ts` (apply options now `include({ remote: true })`, since `supersededLocally` is passed), and `snapshot-bootstrap.spec.ts` (the spy counts the new entry point too).

## Validation run

`yarn build` passed. `yarn workspace @quereus/sync typecheck` was clean. `yarn workspace @quereus/sync test`: 876 passing. `yarn workspace @quereus/quereus lint` was clean. `yarn workspace @quereus/quereus test`: 11103 passing, 26 pending. `@quereus/sync-coordinator`: 141 passing; `@quereus/sync-client`: 118 passing.

## Known gaps (honest list)

- **Atomicity inside the hold is reasoned, not tested.** The test hook can place a commit before the adapter call or after it, but not between the predicate check and the row write inside the mutex hold. No test can show that window is closed; it rests on the mutex.
- **No engine-level test for `ingestExternalRowWrite`.** It is covered end to end through the adapter (every incremental sync test now goes through it). Its branching is small: an empty write result means no ingestion.
- **No `onConflictResolved` event for superseded facts.** They are counted as conflicts in `ApplyResult` but emit no conflict event, which would need the local value and HLC at that point.
- **Three limits recorded as `NOTE:`s at the top of `local-write-tracker.ts`:**
  - an explicit local transaction open across the data write (the ticket's limit);
  - capture stamping every column on an unrecorded row (the ticket's limit);
  - under `allowResurrection`, a batch carrying a delete plus a resurrecting write, with a local edit of a resurrected cell landing *after* the data write: the delete cleanup runs after filing, off the commit chain, and can sweep that edit's record. It needs telling a mark taken before the data write from one taken after it.
- **One extra KV read per filed fact** inside the filing entry (`NOTE:` at `recordsReplacedBy`).
- **A host-supplied `applyToStore` that ignores `supersededLocally` is now worse than before in window A:** filing drops the fact while the row gets the incoming value. This is documented on the option.
- Related, not addressed: `bug-sync-local-create-during-replicated-drop-loses-bookkeeping` (backlog) is the same kind of race for table identity.

## Review findings

Read the `ticket(implement): bug-sync-local-edit-during-apply-diverges` diff before the handoff. Ran `yarn workspace @quereus/sync typecheck` (clean) and `yarn workspace @quereus/sync test` (878 passing, up from 876 with the two tests below). Did not re-run the engine, coordinator or client suites: review changes touched only a sync test, a sync comment and a doc; the implementer's runs of those suites stand.

**Checked, no defect found:**
- Timing of the marks: `enqueueTransactionCommit` is called synchronously from the engine's commit flush (`database-events.ts` `emitTransactionCommit`), which runs inside the committing statement under the exec mutex, so every commit that lands before the data write's mutex hold is in the tracker when `supersededLocally` is asked.
- The "relocating key change is a delete plus an insert" claim in `noteLocalWrites`: confirmed in `store-table.ts` (the `pkChanged` branch) and pinned by existing tests in `alter-events.spec.ts` / `alter-table-events.spec.ts`.
- Trackers are registered inside the apply queue (`enqueueApply`), so only the running apply or drain holds one; the `Set` of trackers is never longer than one in practice.
- Counting: `appliedChanges` holds only data changes (`Change = ColumnChange | RowDeletion`), so subtracting superseded entries from `applied` and adding them to `conflicts` is exact; the drain's `applied`/`skipped` adjustment likewise.
- Error paths: tracker closed in `finally` in both `applyChanges` and `drainTableGroup`; the engine's `withExecMutex` releases on a throwing `write`; `noteLocalWrites` failures are logged, and the capture is still chained.
- Filing re-read (`recordsReplacedBy`): walked the unrecorded-row case (a capture stamps every column with an HLC newer than the batch, then the filing files the incoming unchanged cells over those stamps). The values agree and the stamp's change-log entry goes with it, so nothing stale is pushed. The record's HLC moves backwards for those cells, but the value is the same, and the sender already holds that fact.
- `allowResurrection` with a superseded resurrecting column (`columnsKeptPastDelete`): matches the outcome of a local edit made before the apply began.
- Removal of `ResolvedChange.oldColumnVersion` / `oldTombstone` and of the re-key re-read loop: no remaining readers; `commitColumnMetadata`/`commitDeleteMetadata` parameters of the same names now receive the re-read record.
- Type safety, `any`, resource cleanup, and the new engine entry point (`ingestExternalRowWrite` on `Database` and `DatabaseInternal`): no issues.

**Found and fixed in this pass (minor):**
- `docs/sync-schema.md` § Apply order still showed `row writes → row-validating DDL → engine ingestion seam`. Updated the diagram to the new order (row writes and seam in one mutex hold, then row-validating DDL), and documented why plus the one visible consequence (a foreign key added by the batch's own `add constraint` is not yet in place when opt-in FK actions run).
- Two contracts in the spec (docs/sync-transactions.md § Local writes during an apply) had no test, so added them to `concurrent-apply.spec.ts`:
  - an incoming delete beats a local cell edit made before the data write (row gone, tombstone filed, no cell record, no stale change-log entries);
  - a local insert after the data write applied an incoming delete keeps the row and its records, with no tombstone. I confirmed this test depends on inserts marking the row as replaced: with inserts marked as cells only, it fails, because the tombstone is filed under a live row.

**Tripwires parked:**
- No `onConflictResolved` event for facts a local write superseded: `NOTE:` added at the counting site in `applyChanges` (`change-applicator.ts`).
- The three limits the implementer recorded at the top of `local-write-tracker.ts` (explicit transaction open across the data write; capture stamping every column; `allowResurrection` delete cleanup after filing) and the extra read per filed fact (`recordsReplacedBy`): reviewed. They are genuinely conditional and already parked as `NOTE:`s, so I left them.

**Not filed:**
- Atomicity between the `supersededLocally` check and the row write inside the mutex hold is reasoned, not tested. No test hook can reach that window, and the mutex is the guarantee, so I did not add a test.
- `change-applicator.ts` is 1803 lines (`wc -l`). Its existing `NOTE:` already names the drain block as the split point, and the implementer updated it, so no ticket.
- Empty categories: no performance findings (the tracker costs nothing when no apply is running; the per-fact re-read is parked as above), and no tests cut (the implementer's table-driven block is the reproduction and each case is load-bearing, per their disable-and-rerun check).
