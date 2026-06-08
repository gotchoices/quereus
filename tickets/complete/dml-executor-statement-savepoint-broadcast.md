---
description: DML statement-scope savepoint broadcast for non-FAIL INSERT (ABORT default / IGNORE / REPLACE / ROLLBACK) plus the matching lazy-snapshot fix in `MemoryTableConnection.createSavepoint`. Together these unblock `95-assertions.sqllogic:202` (savepoint stack alignment) and `01.5-insert-select.sqllogic:7` (autocommit self-referential INSERT...SELECT halloween). Review applied a small defensive bounds check in `releaseSavepoint`; a new fix ticket has been opened for the mid-transaction halloween case that this change does not cover.
files:
  - packages/quereus/src/runtime/emit/dml-executor.ts
  - packages/quereus/src/vtab/memory/layer/connection.ts
---

# DML statement-scope savepoint broadcast

## What landed

### A. `packages/quereus/src/runtime/emit/dml-executor.ts`

Two related changes inside `emitDmlExecutor`:

1. **Module-scope counter** `stmtSavepointCounter`. Module-scope is
   required so any nested or sequential `runInsert` emissions produce
   unique savepoint names within the same TransactionManager savepoint
   stack — a function-local counter would reset to 0 in the inner
   `runInsert` and collide on `__or_abort_0`.

2. **Statement-scope savepoint wrap in `runInsert`** for non-FAIL
   modes (ABORT default / IGNORE / REPLACE / ROLLBACK). When
   `plan.onConflict !== FAIL`:
   - calls `ctx.db._createSavepoint('__or_abort_N')` and broadcasts
     `connection.createSavepoint(depth)` to every connection from
     `ctx.db.getAllConnections()` before iterating rows;
   - on success, broadcasts `_releaseSavepoint` + per-connection
     `releaseSavepoint(depth)`;
   - on exception, broadcasts `_rollbackToSavepoint` +
     `_releaseSavepoint` pair (each in its own try/catch that swallows
     — mirrors `transaction.ts`'s defensive structure) then re-throws.

   The wrap is added by introducing a second
   `try { try { ... } catch { ... } } finally { disconnect }`. The
   existing FAIL-mode per-row `__or_fail_N` savepoint stays nested
   unchanged.

### B. `packages/quereus/src/vtab/memory/layer/connection.ts`

Lazy-snapshot behavior in `MemoryTableConnection`:

- `savepointStack` is now `Array<TransactionLayer | null>`.
- `createSavepoint(depth)` no longer auto-creates a pending layer; if
  none exists, it pushes `null` onto the stack as a "no-pending-at-create"
  marker. Avoids triggering the halloween problem in self-referential
  `INSERT ... SELECT` (`MemoryTable.query` selects
  `pendingTransactionLayer ?? readLayer`).
- `rollbackToSavepoint(targetDepth)`: when the stack entry is `null`,
  restores `pendingTransactionLayer = null`. The
  `if (!pendingTransactionLayer) return` guard at the top was dropped
  — rollback must still truncate the savepoint stack to
  `targetDepth + 1` even on idle connections.
- `releaseSavepoint(targetDepth)`: dropped its early-out so a stmt-
  savepoint release on a connection with no pending layer still pops
  its placeholder. **Review added a defensive bounds check** that
  `targetDepth <= this.savepointStack.length` before assigning
  `Array.length` (setting `Array.length` to a larger value pads with
  undefined slots and corrupts subsequent rollback-to / release
  lookups). Mirrors the existing bounds check in
  `rollbackToSavepoint`.

## Why both changes are required together

- **Broadcast alone** → halloween regression on
  `01.5-insert-select.sqllogic:7` (self-referential
  `INSERT ... SELECT`).
- **Lazy-snapshot alone** → `95-assertions.sqllogic:202` mismatch
  remains: release isn't broadcast, so the `registerConnection`-
  replay placeholder stays at depth 0 and a later user
  `SAVEPOINT sp1` lands at depth 1, leaving the empty placeholder for
  `ROLLBACK TO sp1`.

## Validation

| command | result |
|---------|--------|
| `yarn workspace @quereus/quereus run lint` | clean (exit 0) |
| `yarn workspace @quereus/quereus run build` | clean (exit 0) |
| `yarn workspace @quereus/quereus run test` | **3175 passing** |
| `yarn workspace @quereus/isolation run test` | **68 passing** |

The 68 isolation tests all pass — the `DROP INDEX inside an active
transaction` failure flagged by the prior fix-stage notes did not
reproduce. Plausibly fixed incidentally by the lazy-snapshot change,
or test-config-dependent; either way it's no longer failing.

## Review findings

### Scrutiny performed

- Re-read the implement diff (`cd6205f8edd1c4c7a3d123eb6009596bfbe270b6`)
  against `runtime/emit/transaction.ts` to verify the broadcast pattern
  is consistent: create → release / rollback-to + release, each through
  `getAllConnections()`. Confirmed: identical shape, except the DML
  wrap also has to handle the FAIL-mode per-row nested savepoint and a
  generator-resource-cleanup `finally { disconnectVTable }`.
- Verified module-scope counter is the right scope: a function-local
  counter would collide for parallel/nested runInsert emissions
  (e.g. recursive triggers, FK action paths that themselves go through
  runInsert). Module-scope across Databases is also harmless because
  each Database has its own TxnMgr savepoint stack — names only need
  to be unique within one stack.
- Walked through the savepoint-stack-alignment scenario for the
  `95-assertions` failure (registerConnection replay → stmt savepoint
  release missing without broadcast → user SAVEPOINT lands at wrong
  depth). The added release broadcast resolves this.
- Walked through every `null`-marker code path in
  `connection.ts`: lazy push, rollback to null marker (clears
  pendingLayer), release of null marker (pops placeholder). All paths
  are symmetric and the SAVEPOINT-preservation semantics in
  `rollbackToSavepoint` still hold (saved at `targetDepth + 1`).
- Verified `wasExplicitTransaction` capture in
  `manager.ts:performMutation` (line 481). The broadcast sets
  `connection.explicitTransaction = true` before the first
  `performMutation` call inside the row loop, so the per-mutation
  auto-commit branch at lines 504-508 stays off. Confirmed implicit-
  transaction commit still happens via `Statement` →
  `_finalizeImplicitTransaction` → `commitTransaction` →
  `connection.commit()` → `clearTransactionState()` which resets
  `explicitTransaction = false`.
- Reviewed bounds-safety in `connection.ts`: `rollbackToSavepoint`
  already has a defensive bounds check; `releaseSavepoint` did not.
  Setting `Array.length` to a value greater than the current length
  pads with undefined entries that corrupt later lookups. Fix applied
  inline (see "What landed" §B).
- `getAllConnections()` is re-resolved for the broadcast at create
  vs. release vs. rollback. A connection registered mid-`runInsert`
  (e.g. by a `getVTable` triggered inside `processInsertRow`) is
  caught up by `Database.registerConnection`'s savepoint-stack replay,
  then participates in the subsequent release/rollback. Verified.
- Verified the `clearTransactionState()` path on commit and the
  full-transaction `rollback()` path: both reset
  `savepointStack = []` and the lazy-marker change does not affect
  these terminal paths.
- Read every file the change touches and the docs nearest to them —
  `runtime/emit/transaction.ts`, `runtime/emit/dml-executor.ts`,
  `vtab/memory/layer/connection.ts`,
  `vtab/memory/layer/manager.ts`, `vtab/memory/table.ts`,
  `core/database.ts:registerConnection`,
  `core/database-transaction.ts` savepoint section. The lazy-snapshot
  change has no doc footprint (no public-API doc references the
  eager-creation behavior); the broadcast pattern is uniform with the
  one already documented by precedent in `transaction.ts`.

### Findings

**Major (new fix ticket filed):**

- **Mid-transaction self-referential INSERT...SELECT still hits
  halloween.** When the connection has a non-null
  `pendingTransactionLayer` at savepoint time (prior writes in the
  same explicit transaction), `createSavepoint` takes the eager branch
  — it builds a snapshot for the savepoint stack but
  `pendingTransactionLayer` itself is not replaced. Then
  `MemoryTable.query` walks the live mutable pending layer that the
  INSERT also writes into, and the halloween cascade resumes. Verified
  by reproduction script: same `Type mismatch ... Number.isSafeInteger`
  error as the original autocommit bug. The
  `dml-executor-statement-savepoint-broadcast` review handoff describes
  this case under "Known gaps" #3 as a perf concern; it is in fact a
  correctness concern. Filed as
  [`fix/insert-select-halloween-mid-transaction.md`](../fix/insert-select-halloween-mid-transaction.md).

**Minor (fixed inline):**

- `releaseSavepoint(targetDepth)` had no bounds check after the
  early-out was removed. If `targetDepth > savepointStack.length`,
  `Array.length = targetDepth` pads with undefined slots that corrupt
  later lookups. Added a guard with a warning, mirroring the existing
  defensive shape of `rollbackToSavepoint`. Pre-existing close cousin
  of `rollbackToSavepoint`'s guard; the lazy-snapshot work removed the
  accidental protection of the early-out, so the guard belongs here
  now explicitly.

**Minor (flagged, not changed):**

- `runUpdate` / `runDelete` did not get the same wrap. No failing
  test currently surfaces this; documented in the implement handoff
  as out-of-scope. The asymmetry with `runInsert` is worth a follow-up
  if a multi-row UPDATE with mid-statement ABORT-class conflict ever
  needs the same unwind guarantee.
- FAIL mode still uses `await ctx.db._createSavepoint(savepointName)`
  in `dml-executor.ts:326`. The `_createSavepoint` method is
  synchronous and returns `number`, so the `await` is harmless but
  semantically misleading. Pre-existing, not introduced by this
  change.
- FAIL-mode per-row savepoints still don't broadcast to connections.
  Per the implement notes this is left "nested unchanged"; per-row
  scope makes the registerConnection-replay race practically
  unreachable, but it's the first place to look if FAIL mode misbehaves
  around concurrent connection registration.
- The module-scope `stmtSavepointCounter` is unbounded across the
  process lifetime. Practically a non-issue (`Number.isSafeInteger`
  ≈ 9.0e15), but a per-database counter would be tidier.

**Documentation:**

- The implement handoff's "Known gaps" §3 categorizes the
  mid-transaction case as perf-only. Reclassified in the new fix
  ticket as correctness, with three sketch directions noted (snapshot
  replacement, query-time freeze, scan-time path snapshot) for
  whoever picks the ticket up.
- No public docs (`docs/architecture.md`, `docs/runtime.md`,
  `docs/sql.md`) reference the eager-creation behavior that the lazy
  fix changes; the public-API surface is unchanged. The comment on
  `savepointStack` and the new branches in `rollbackToSavepoint` /
  `releaseSavepoint` are self-explanatory in-source.

**Empty categories:** No security issues found (the change is purely
mechanical re-ordering of trusted internal calls; no new user input
surface). No resource-cleanup gaps (the existing
`finally { disconnectVTable }` still runs after the new wrap).

### Conclusion

The implementation correctly addresses the two target test failures
and is safe to merge as-is plus the inline bounds-check fix. The
mid-transaction halloween regression that the implementation does NOT
address is filed as a separate fix ticket so it can be planned and
implemented with its own scrutiny — it requires a different shape of
fix (snapshot replacement, query freezing, or scan-time path
snapshot) than the savepoint-broadcast work.
