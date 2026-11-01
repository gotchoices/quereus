description: The planner now learns table sizes seen inside a transaction only once that transaction commits, and forgets them if it rolls back, so it never remembers a row count that included changes which were later undone.
prereq: cardinality-feedback-scan-observations
architecture: docs/progressive-optimizer.md#35-publication-and-transactions
files: packages/quereus/src/core/database-cardinality-feedback.ts, packages/quereus/src/core/database-transaction.ts, packages/quereus/src/core/database.ts, packages/quereus/src/runtime/cardinality-observations.ts, packages/quereus/test/runtime/cardinality-observations.spec.ts, docs/progressive-optimizer.md, docs/usage.md
----

# Hold in-transaction observations until commit — complete

Third of the `cardinality-feedback-*` chain. Before this, a full-table count seen while a transaction was open was thrown away. That covered every writing autocommit statement and every read inside `begin … commit`. Now such counts are held, then applied when the transaction commits, except for tables the transaction wrote. A rollback, a failed commit, or a `rollback to savepoint` discards them.

## What landed

- `CardinalityFeedbackManager` (`core/database-cardinality-feedback.ts`):
  - `publish` records immediately for `readCommitted` executions and for executions that end with no transaction open. Otherwise it holds the counts in `pending`, keyed by lowercased `schema.table`, with the last count per table winning.
  - `onCommitted(changedCounts)` applies the held counts, skipping every table in the change log, and clears `pending` in a `finally`. `onRolledBack()` clears `pending`. `clear()` and `dispose()` clear it too.
  - Added in review: a rollback counter. Each execution's sink is created through `beginObservations()` and stamped with the counter. `publish` discards a non-`readCommitted` sink whose stamp no longer matches.
- `TransactionManager` (`core/database-transaction.ts`): the new `TransactionManagerContext.transactionRolledBack()` hook is called, isolated in a try/catch, after a rollback, a failed commit, and `rollbackToSavepoint`. `getChangedRowCounts` now includes tables whose writes cancelled out, with a count of 0.
- `Database` (`core/database.ts`): `recordCommittedChangeCounts` builds the counts map at most once for auto-analyze and feedback, and runs feedback's `onCommitted` in a `finally`.

## Review findings

Read the implement diff (`ticket(implement): cardinality-feedback-commit-scoped-publication`) first, then traced the publish/commit/rollback ordering through `Statement._iterateRowsRawInternal`, `Database._executeSingleStatement`, `_finalizeImplicitTransaction`, the DML executor's savepoint paths and external-change ingestion.

- **Defect, fixed (repro: verified).** A failing statement inside an explicit transaction rolls back its own statement savepoint *before* its run site publishes. The rollback cleared `pending`, but the failing statement's own observations were still in its sink, so they were held afterwards. If one of its completed scans had counted its own now-undone writes, the next `commit` recorded that inflated count. Reproduced: a five-row `insert into big select …` with a correlated `count(*)` over `big` fails on row five, and after `commit` the overlay holds 20,004 for a 20,000-row table. Fix: the rollback-counter stamp described above. Test: `discards a failed statement's scans that saw its rolled-back writes`. It fails when the check is disabled.
- **Untested deviation, now covered.** The implementer changed `getChangedRowCounts` to keep tables whose writes cancelled out, with no test. I replaced `drops the scan of a table the committing transaction wrote` (delete, then scan) with `… even net-unchanged` (insert, scan, then delete the same key). It still covers the drop branch, and it fails if the `rowMap.size === 0` skip comes back. I checked `AutoAnalyzeManager.recordCommit`, the only other consumer of `getChangedRowCounts`: it skips counts ≤ 0.
- **Doc error, fixed.** §3.5 said an `OR FAIL` conflict "commits … what was held". In fact the failing row's per-row savepoint rollback fires `onRolledBack`, so held counts are discarded. Corrected. The §3.5 text also now describes the rollback-during-execution rule. The document's **Status** line still said scan observation and publication were "next", and is updated.
- **Tripwire.** External-change ingestion with `captureChanges: false` writes rows the change log never sees. A count held from before such a batch is then applied, so the estimate lags. Parked as a `NOTE:` in `onCommitted`.
- **Tripwire, kept from implement.** At the implicit→explicit `BEGIN` upgrade, `clearChangeLog()` forgets which tables were written before the upgrade. The `NOTE:` in `beginTransaction` stays. The only other upgrade path (`SAVEPOINT` → `upgradeToExplicitTransaction`) does not clear the log, so it is unaffected.
- **Checked, no issue:**
  - Ordering: every serialized run site publishes in the inner generator's `finally`, before the wrapper's implicit commit or rollback. That covers `eval`, `iterateRows`, `run`, `get`, `all` and `exec`.
  - Committed reads (`readCommitted`) skip the rollback stamp on purpose. They run without the mutex alongside a writer and read committed state.
  - Key convention: the change log lowercases `schema.table` exactly as `tableKey` does.
  - A held count from a superseded `TableSchema` is rejected by `record`'s identity check.
  - A failed commit discards held counts through the `catch`. `onCommitted` clears `pending` even if `record` throws.
  - `pending` is bounded by the distinct tables one transaction observes.
- **Tests:** kept `drops a writing statement's scan of its own target` (the case where dropping is necessary) and dropped the redundant explicit-delete variant, as described above. Nothing else was cut: each remaining test pins a distinct branch. The rollback test passes the empty trailing commit that would expose leftover held counts.
- **Docs:** read `docs/progressive-optimizer.md` §3.1, §3.5, status and key files, and the `cardinality_feedback` row in `docs/usage.md`. The usage row is accurate. Corrections are listed above.
- **Validation:** `yarn workspace @quereus/quereus run lint` is clean (exit 0). The quereus test suite has 10,833 passing, 25 pending, no failures. Other workspaces were not re-run: the change is internal to `packages/quereus`, and no other package references `CardinalityObservations`. The implement stage ran `yarn test` across all workspaces green.
