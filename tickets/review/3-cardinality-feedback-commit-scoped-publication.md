description: The planner now learns table sizes seen inside a transaction only once that transaction commits, and forgets them if it rolls back, so it never remembers a row count that included changes which were later undone.
prereq: cardinality-feedback-scan-observations
architecture: docs/progressive-optimizer.md#35-publication-and-transactions
files: packages/quereus/src/core/database-cardinality-feedback.ts, packages/quereus/src/core/database-transaction.ts, packages/quereus/src/core/database.ts, packages/quereus/test/runtime/cardinality-observations.spec.ts, docs/progressive-optimizer.md, docs/usage.md
----

# Hold in-transaction observations until commit — review

Third of the `cardinality-feedback-*` chain. Before this, a full-table count seen while a transaction was open was thrown away. That covered every writing autocommit statement and every read inside `begin … commit`. Now such counts are held and applied when the transaction commits.

## What was built

- **Manager** (`core/database-cardinality-feedback.ts`):
  - `publish` records immediately for `readCommitted` or no-transaction executions. Otherwise it stores the counts in a `pending` map, using the same lowercased `schema.table` key (`tableKey`) as the overlay, with the last count per table winning.
  - `onCommitted(changedCounts)` returns early if nothing is held, so the thunk is never called. Otherwise it records each held count whose key is **not** in the change log. It clears `pending` in a `finally`, so a throwing `record`/`onShift` cannot leak held counts into the next transaction.
  - `onRolledBack()` clears `pending`.
  - `clear()` (used when `pragma cardinality_feedback = false`) and `dispose()` (used by `close()`) now clear `pending` too. Without this, turning the option off mid-transaction would refill the overlay when the transaction commits.
- **Transaction manager** (`core/database-transaction.ts`):
  - New `TransactionManagerContext.transactionRolledBack()`, called through a private `notifyRolledBack()` that wraps it in try/catch and logs errors.
  - It is called from three places: `rollbackTransaction`'s `finally`, `commitTransaction`'s `catch` (failed commit), and `rollbackToSavepoint`.
  - The commit-side log message is now "Commit bookkeeping threw", and the comment above it covers both consumers.
- **Database** (`core/database.ts`):
  - `recordCommittedChangeCounts` memoizes the thunk. Auto-analyze is still gated on `auto_analyze`. Feedback's `onCommitted` runs in a `finally`, so it is not gated on `auto_analyze` and still runs if auto-analyze throws.
  - `transactionRolledBack()` forwards to `onRolledBack()`.

## Deviations from the ticket (reviewer: check these)

- **`getChangedRowCounts` now includes tables with count 0.** The change log merges an insert followed by a delete of the same key into nothing. The old code then skipped that table entirely. So `begin; insert into big …; select * from big; delete <those rows>; commit` would have recorded the inflated mid-transaction count, which is exactly what the ticket says must not happen. I removed the `rowMap.size === 0` skip, so every table the transaction wrote now appears as a key. The only other consumer, `AutoAnalyzeManager.recordCommit`, already skips `count <= 0`, and its existing tests ("nets an insert-then-delete…", "creates no entry for a commit that changed nothing") still pass. I added no test for this path.
- **NOTE tripwire at the implicit→explicit BEGIN upgrade** (`beginTransaction`): that path calls `clearChangeLog()`, so it forgets which tables were written before the upgrade, while held counts survive it as the ticket asks. As far as I can tell this is unreachable today, because every implicit transaction ends with its statement. I left a note rather than changing assertion-related change-log behaviour.

## Tests (`test/runtime/cardinality-observations.spec.ts`)

- `holds a full scan made inside a transaction until it commits`: absent before `commit`, 20,000 after.
- `forgets a full scan made inside a transaction that rolls back`: runs `begin; select * from big; rollback; begin; commit;`. The trailing empty commit would apply anything still held. I confirmed by mutation that the test fails when `onRolledBack` is made a no-op.
- `drops the scan of a table the committing transaction wrote`: `begin; delete … where id <= 10; select * from big; commit;` records nothing.
- `records a writing statement's scan of another table at its commit`: `insert into t2 select * from big` (autocommit) records `big` at 20,000.
- Kept from the prior ticket, renamed: `drops a writing statement's scan of its own target` (`delete from big`). It now passes because of the written-table skip instead of the old discard. It is the case where dropping is *necessary* (the count was taken before the write), while the explicit-transaction test above covers the conservative case (the count was taken after the write). A reviewer may judge one of the two redundant.
- Removed: `discards a full scan made inside an open transaction`.

## Verified by inspection only (no test)

- `rollback to savepoint` discards everything held: one call site in `TransactionManager.rollbackToSavepoint`. This also fires on the DML executor's statement-savepoint rollback on error paths, which conservatively drops counts held by earlier statements in the same transaction.
- A failed commit (deferred constraint, assertion, connection commit error) discards via the `catch`.
- `OR ROLLBACK` goes through `_finalizeImplicitTransaction` → `_rollbackTransaction` → hook. `OR FAIL` commits, so `onCommitted` runs.
- Commit-time assertion queries publish while the transaction is still open, so their counts are held and then applied in the same commit (minus written tables).
- With nothing held and auto-analyze off, the counts thunk is never called. The existing `auto-analyze-counters.spec.ts` "never builds the counts map when auto_analyze is off" still passes.

## Validation

- `yarn workspace @quereus/quereus run lint`: clean (eslint and the test tsc pass).
- `yarn test`: all workspaces pass (quereus 10832 passing, 25 pending; no failures anywhere).

## Docs

- `docs/progressive-optimizer.md` §3.5 rewritten in present tense with the interim note dropped. §3.1's internal-work sentence now says "held with that transaction". The key-files row is updated.
- `docs/usage.md`: the `cardinality_feedback` option row now says counts from inside a transaction apply once it commits, and only for tables it did not write.
