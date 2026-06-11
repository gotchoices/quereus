description: Store DDL-commit operations (replaceContents/renameTable) commit the coordinator mid-transaction and clear the savepoint stack; later rollback-to/release savepoint broadcasts threw NOTFOUND or padded the stack with undefined. Fixed by warn-and-return guards mirroring the memory connection.
files:
  - packages/quereus-store/src/common/transaction.ts
  - packages/quereus-store/README.md
  - packages/quereus-store/test/transaction.spec.ts
  - packages/quereus-store/test/mv-store-backing.spec.ts
  - packages/quereus-store/test/alter-table.spec.ts

## Summary

`TransactionCoordinator.rollbackToSavepoint` and `releaseSavepoint` now warn-and-return
on out-of-range depth instead of throwing (`rollbackToSavepoint`) or padding the stack
with `undefined` slots (`releaseSavepoint`). This makes the store backing tolerate a
DDL-commit (`replaceContents` / `renameTable`, e.g. `refresh materialized view` /
`alter table … rename`) that commits the coordinator mid-transaction and clears the
savepoint stack while the engine still broadcasts later savepoint ops. The guards mirror
`vtab/memory/layer/connection.ts` exactly, so the store and memory arms observe the same
DDL-commits semantics.

## Review findings

**Stage:** review (adversarial pass over implement commit `e14bd9a4`).

### Checked — correctness / parity
- **Guard asymmetry is correct and matches memory parity.** `releaseSavepoint` guards on
  `targetDepth > stack.length` (release-to-current-depth is a valid no-op truncation);
  `rollbackToSavepoint` guards on `targetDepth >= stack.length` (there is no snapshot at
  `stack.length`). Both predicates are byte-for-byte the same as the cited reference
  `packages/quereus/src/vtab/memory/layer/connection.ts`. ✓
- **Single chokepoint.** `store-connection.ts` delegates `releaseSavepoint`/`rollbackToSavepoint`
  straight to the coordinator; there is no parallel store-side savepoint path that could still
  throw. Fix is at the right level. ✓
- **No state corruption after a clear.** Post-commit the stack is empty; a `release(0)` hits
  `0 > 0` (false) → `length = 0` no-op; `release(1)` / `rollback-to(0)` trip the guard. The
  follow-up round-trip test confirms the coordinator remains usable for a fresh
  savepoint/rollback cycle after the guard fires. ✓

### Checked — logging / style
- `console.warn` with a `[TransactionCoordinator]` prefix is consistent with the existing
  `[StoreModule]` convention in this package (store-module.ts). The memory arm uses `warnLog`
  because that package has a logger; quereus-store has none. Acceptable. ✓

### Checked — tests
- Ran `yarn workspace @quereus/store test` → **524 passing**. The expected
  `[TransactionCoordinator] … out of range` warnings appear in output (guards firing, as
  designed). ✓
- Ran `tsc --noEmit` in the package → **clean**. ✓
- Coverage is adequate: coordinator-level units (rollback-to/release after commit, in-txn
  out-of-range, follow-up round-trip) plus two end-to-end paths (MV refresh-in-savepoint with
  store-vs-memory parity assertion; rename-in-savepoint). Both DDL-commit triggers
  (`replaceContents`, `renameTable`) are exercised end-to-end.

### Found — minor (fixed in this pass)
- **Doc drift.** `packages/quereus-store/README.md` savepoint bullet stated savepoints "work
  within a transaction" with no mention of the DDL-commit caveat the fix introduces. Added a
  sub-bullet documenting that a DDL-commit clears the savepoint stack and that a subsequent
  `rollback to` / `release` degrades to a warn-and-return no-op. (Committed with this ticket.)

### Noted — out of scope (no action)
- **Unused `TransactionCallbacks` import** in `transaction.spec.ts`: confirmed pre-existing
  (present in the fix-stage version `30ed915d`, untouched by the implement commit). Harmless;
  not introduced here.
- **Residual semantics gap** (documented by implementer): ops queued *after* the DDL-commit but
  *before* the broadcast rollback-to are not undone by that rollback-to. This is inherent to the
  DDL-commits posture and is shared identically with the memory arm — verified by the parity
  assertion in the refresh-in-savepoint test. Correct to leave as-is.
- **Negative / NaN depth**: would throw (negative `Array.length`) or mis-index, but the engine
  never broadcasts such depths and this behavior is identical to the memory arm. Not in scope.

### Major findings
- None. No new fix/plan/backlog tickets filed.
