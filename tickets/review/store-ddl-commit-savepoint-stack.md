----
description: Review fix for store DDL-commits clearing savepoint stack — rollbackToSavepoint/releaseSavepoint now warn-and-return on out-of-range depth
files:
  - packages/quereus-store/src/common/transaction.ts
  - packages/quereus-store/test/transaction.spec.ts
  - packages/quereus-store/test/mv-store-backing.spec.ts
  - packages/quereus-store/test/alter-table.spec.ts
----

## What was done

**Root cause:** Store DDL-commit operations (`replaceContents` / `renameTable`) call `coordinator.commit()` mid-transaction, which runs `clearTransaction()` and empties `savepointStack`. The engine then broadcasts later savepoint ops (rollback-to, release) to the connection, which would throw NOTFOUND (`rollbackToSavepoint`) or silently pad with `undefined` slots (`releaseSavepoint`).

**Fix:** `TransactionCoordinator.rollbackToSavepoint` and `releaseSavepoint` in `packages/quereus-store/src/common/transaction.ts` now mirror the memory connection (`vtab/memory/layer/connection.ts`) — warn-and-return on out-of-range depth rather than throw/corrupt.

- `rollbackToSavepoint` (L274-292): replaced the NOTFOUND throw with `console.warn(...)` + `return` when `targetDepth >= savepointStack.length`
- `releaseSavepoint` (L269-271): added a `targetDepth > savepointStack.length` guard — `console.warn(...)` + `return` — before the truncation assignment
- Both guards updated with doc comments citing the DDL-commit rationale and memory-parity reference

**Tests added (all passing — 524 tests total):**

1. `transaction.spec.ts` — coordinator-level unit tests in `describe('savepoint ops after a commit clear')`:
   - `rollbackToSavepoint after commit does not throw`
   - `releaseSavepoint after commit does not pad the stack` (also verifies follow-up savepoint round-trip works correctly)
   - `in-transaction out-of-range rollbackToSavepoint also warns and returns` (depth-uniform guard)
   - Updated existing `'rollbackToSavepoint with invalid depth throws'` → `'warns and returns (no throw)'`

2. `mv-store-backing.spec.ts` — refresh-in-savepoint store-vs-memory parity test:
   - `refresh inside a savepoint does not throw and matches memory arm (DDL-commits parity)` — mirrors the L295-325 harness but wraps the insert+refresh in a savepoint, then `rollback to s1; commit`

3. `alter-table.spec.ts` — rename-in-savepoint DDL-commits posture test (in `RENAME TABLE` describe):
   - `rename inside a savepoint does not throw on rollback-to (DDL-commits posture)`

## Use cases for testing / validation

- **Unit regression:** `yarn workspace @quereus/store test` — 524 passing
- **Type check:** `cd packages/quereus-store && yarn tsc --noEmit` — clean
- **Key scenario:** `begin; savepoint s1; insert …; refresh materialized view mv; rollback to s1; commit` — should warn-and-return rather than throw NOTFOUND on the store-backed MV arm, and produce parity output with the memory arm
- **Corollary scenario:** `begin; savepoint s1; insert …; alter table t rename to t2; rollback to s1; commit` — should warn-and-return, t2 accessible with committed data

## Known gaps / reviewer notes

- The fix degrades to DDL-commits semantics: pending ops queued *after* the DDL-commit (between the DDL-commit and the broadcast rollback-to) would not be rolled back by the rollback-to. This residual imperfection is shared with the memory arm and explicitly out of scope per the ticket.
- The `TransactionCallbacks` type in `transaction.spec.ts` is an unused import — this was pre-existing before this change.
- `console.warn` is used (not a logger) consistent with the existing store-module.ts warning convention (`[StoreModule]` prefix pattern).
