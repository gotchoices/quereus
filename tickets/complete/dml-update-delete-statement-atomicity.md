description: Statement-level savepoint atomicity for multi-row UPDATE/DELETE — a shared runWithStatementSavepoints helper now wraps all three DML generators so a mid-statement throw inside an explicit transaction rolls back the whole statement, not just the failing row. Reviewed and confirmed correct.
files: packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/test/logic/101-transaction-edge-cases.sqllogic, packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic, docs/runtime.md
----

## Summary of work

The pre-existing atomicity gap: `runUpdate`/`runDelete` had no statement-level
savepoint (only `runInsert` did), so a multi-row UPDATE/DELETE whose Nth row
threw inside an **explicit** transaction left rows 1..N-1 applied (autocommit
masked it via implicit-transaction rollback).

The fix extracts INSERT's savepoint scaffold into a single shared higher-order
async generator **`runWithStatementSavepoints(ctx, vtab, rows, isFailMode,
processRow)`** in `runtime/emit/dml-executor.ts`. It owns the savepoint lifecycle
and the `disconnectVTable` finally; each op reduces to a `processRow` closure
(`processInsertRow` / `processUpdateRow` / `processDeleteRow`). Non-FAIL modes
open one statement-scope savepoint (`__stmt_atomic_N`) rolled back on any throw
escaping the row loop; OR FAIL keeps the per-row `__or_fail_N` savepoint and
skips the statement wrap. A small `evaluateContextRow` helper de-duplicates the
context-row eval. Broadcast savepoint helpers keep lazily-registered connections
(row-time MV backing) in lockstep. `docs/runtime.md` gained a "Statement-Level
Atomicity" subsection.

## Review findings

**Verdict: implementation is correct, well-tested, and well-documented. No code
changes were needed in this review pass; no major findings filed.**

### What was checked

- **Read the full implement diff** (`5e01480d`) with fresh eyes before the
  handoff summary: the shared helper, all three `processRow` closures, the
  `evaluateContextRow` extraction, both test files, and the docs delta.
- **Atomicity correctness (the core fix):** the non-FAIL statement savepoint is
  created before the loop, released after it, and rolled-back-and-released in the
  outer `catch` on *any* throw escaping the loop — both source-iterator throws
  (NOT NULL / CHECK / parent-side FK RESTRICT raised by the `ConstraintCheckNode`
  above the executor) and `processRow` throws (vtab-returned constraint, RESTRICT
  pre-check). Quereus's streaming pipeline (ConstraintCheck above DmlExecutor)
  guarantees rows interleave per-row, so the earlier row is genuinely mutated
  before the later row fails — the new tests exercise the fix, not a trivial path.
- **IGNORE semantics preserved:** verified IGNORE conflicts return
  `{status:'ok', row:undefined}` from the vtab (memory + store + isolation
  layers) — `processRow` returns `undefined` (skip), it does **not** throw, so the
  statement savepoint is *not* rolled back. Multi-row UPDATE/DELETE under a
  schema-level `ON CONFLICT IGNORE` still skips-and-continues correctly.
- **OR FAIL semantics preserved:** FAIL skips the statement wrap, rolls back only
  the failing row's `__or_fail_N` savepoint, then propagates the error (prior rows
  survive). Unchanged from the pre-refactor INSERT path; covered by the or-fail
  race spec.
- **Nested savepoints (FK cascade):** the shared module-scope `stmtSavepointCounter`
  prevents name collisions when a cascade child DML opens its own
  `__stmt_atomic_N` inside a parent's; LIFO rollback order is preserved.
- **Resource cleanup:** `disconnectVTable` lives in the helper's `finally`;
  `getVTable`/`disconnectVTable` are balanced (one each per generator invocation).
  The context-eval-before-try ordering (a throw there skips disconnect) is
  identical to the pre-refactor code in all three generators — **not a
  regression** introduced here.
- **Type safety:** `processRow: (Row) => Promise<Row | undefined>` and
  `evaluateContextRow → Promise<Row | undefined>` are cleanly typed; no new `any`.
- **Stale references:** grep confirmed the old `__or_abort_` prefix has zero
  remaining references after the `__stmt_atomic_` rename.
- **Docs:** read `docs/runtime.md` "Statement-Level Atomicity" subsection — it
  accurately reflects the shared helper, non-FAIL vs OR FAIL strategy, and the
  broadcast/lazily-registered-connection rationale.
- **Lint + typecheck:** both clean (exit 0).
- **Tests:** full memory suite **3813 passing, 9 pending, 0 failing**; targeted
  memory run of 101 + 53 + or-fail race + savepoint broadcast specs = 26 passing;
  targeted **store-mode** run of 53 + or-fail + broadcast specs = 26 passing.

### Disposition of the implementer's documented gaps

- **Gap #1 (dead OR FAIL branch for UPDATE/DELETE) — confirmed, accepted.**
  Verified the parser AST: `UpdateStmt`/`DeleteStmt` carry no `onConflict` field
  (only `InsertStmt` does), and `UPDATE/DELETE OR <action>` does not parse. So
  `plan.onConflict === FAIL` is genuinely unreachable for UPDATE/DELETE; the
  per-row FAIL branch is dead **but correct and harmless**, kept for DRY parity
  with INSERT (where it is reachable and covered). No change warranted — it is now
  documented as intentional.
- **Gap #2 (pure `processRow`-throw path coverage) — actually covered; concern
  resolved.** The new UNIQUE-collision UPDATE case (`atom_uq`, non-PK `UNIQUE`)
  drives a vtab-returned `isConstraintViolation` → `processUpdateRow` throws →
  the helper's catch handles it: that **is** the `processRow`-throw path. The
  DELETE FK RESTRICT case fires from the `assertTransitiveRestrictsForParentMutation`
  pre-check inside `processDeleteRow`, also a `processRow` throw. Both throw paths
  (source-iterator and processRow) are exercised. No new test needed.
- **Gap #3 (savepoint prefix rename) — confirmed safe.** No test asserts the
  literal name; no stale `__or_abort_` references.
- **Gap #4 (store mode unrun) — substantially closed.** Ran the store/isolation-
  touching subset under `QUEREUS_TEST_STORE=true`: 53 (row-time MV UPDATE
  atomicity — the riskiest store-path interaction), the or-fail mid-row
  registration race spec, and the savepoint broadcast specs all pass against the
  LevelDB backend. The 101 UPDATE/DELETE atomicity cases are on the store-mode
  skip list (line 44 of `logic.spec.ts`) for a **separate pre-existing** reason
  (ROLLBACK TO SAVEPOINT through the overlay memory connection hits an undefined
  schema in `TransactionLayer`), unrelated to this change. A full `test:store`
  before release remains advisable but is out of agent scope (slower, not the
  agent default per AGENTS.md).
- **Gap #5 (101 file-coupling `COMMIT; -- run` guard) — verified.** The guard is
  necessary because the preceding section leaves an explicit transaction open;
  the comment documents it for future editors. Fine.

### Minor observations (no action — out of scope / pre-existing)

- In the helper, if `_releaseSavepointBroadcast` at the end of a *successful* loop
  were to throw, the outer `catch` would attempt a second rollback-and-release of
  the same savepoint. This is pre-existing INSERT structure (not new to this
  ticket), the scenario (release of a valid top savepoint after success failing)
  is extremely unlikely, and `_rollbackAndReleaseSavepointBroadcast` is explicitly
  tolerant of missing-name errors (covered by a broadcast spec). Negligible risk;
  noted only for completeness.

### Categories with nothing found

- **Bugs / correctness:** none.
- **DRY / modularity:** the refactor *improves* DRY (three near-identical
  savepoint scaffolds collapsed to one); nothing further to extract.
- **Performance:** a no-op UPDATE/DELETE (zero matched rows) now creates+releases
  one extra savepoint; identical to pre-existing INSERT behavior and negligible.
- **Error handling / type safety:** clean; covered above.
