description: Review the statement-level savepoint atomicity fix for multi-row UPDATE/DELETE — a shared runWithStatementSavepoints helper now wraps all three DML generators so a mid-statement throw inside an explicit transaction rolls back the whole statement, not just the failing row.
prereq:
files: packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/test/logic/101-transaction-edge-cases.sqllogic, packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic, docs/runtime.md
----

## What changed

The pre-existing atomicity gap was that `runUpdate`/`runDelete` had no
statement-level savepoint (only `runInsert` did), so a multi-row UPDATE/DELETE
whose Nth row threw inside an **explicit** transaction left rows 1..N-1 applied.
Autocommit masked it (implicit-transaction rollback on error).

The fix extracts the savepoint scaffold `runInsert` already had into a single
shared higher-order async generator, **`runWithStatementSavepoints(ctx, vtab,
rows, isFailMode, processRow)`** (`runtime/emit/dml-executor.ts`). It owns the
savepoint lifecycle and `disconnectVTable` finally; each operation reduces to a
`processRow` closure (`processInsertRow` / `processUpdateRow` / `processDeleteRow`).

- **non-FAIL** (ABORT default / IGNORE / REPLACE / ROLLBACK): one statement-scope
  savepoint (`__stmt_atomic_N`) opened before the row loop, released after it,
  rolled-back-and-released on **any** throw escaping the loop — the inner
  try/catch wraps the `for await (… of rows)` so it catches both source-iterator
  throws (a `ConstraintCheckNode` above the executor raising NOT NULL / CHECK /
  parent-side FK RESTRICT) **and** `processRow` throws (vtab-returned constraint,
  runtime RESTRICT pre-check). This is the atomicity fix.
- **OR FAIL**: skips the statement wrap; per-row savepoint (`__or_fail_N`) instead.

Shared module-scope `stmtSavepointCounter` (unchanged); broadcast savepoint
helpers used throughout so lazily-registered connections (row-time MV backing)
stay in lockstep. Savepoint prefix renamed `__or_abort_` → `__stmt_atomic_` (now
op-agnostic since shared). A small `evaluateContextRow` helper de-duplicates the
context-row eval across all three generators.

## Behaviors / use cases to validate

- **UPDATE atomicity (NOT NULL):** `begin; update t set x = case when id=2 then
  null else x+1 end where id in (1,2);` errors on id=2; id=1 must stay at its old
  value (not x+1). Confirmed-failing-on-HEAD repro from the source ticket.
- **DELETE atomicity (FK RESTRICT):** multi-row `delete from parent where id in
  (1,2)` where a RESTRICT child references id=2; id=1 (unreferenced, deleted
  first) must be restored.
- **UPDATE atomicity (UNIQUE collision):** a later row's UPDATE collides on a
  UNIQUE column; the earlier row's move reverts.
- **Row-time MV UPDATE atomicity:** a failed multi-row UPDATE over a
  `refresh='row-time'`-covered source reverts BOTH the source write and the MV
  backing delta (they ride the same savepoint stack).
- Existing INSERT atomicity, OR FAIL per-row behavior, and savepoint broadcast
  semantics must be unchanged (regression surface of the refactor).

## Test coverage added

- `101-transaction-edge-cases.sqllogic`: UPDATE (NOT NULL), UPDATE (UNIQUE),
  DELETE (FK RESTRICT) statement-atomicity cases, each wrapped in
  `begin; … rollback;` and asserting the earlier row's effect did not survive.
- `53-materialized-views-rowtime.sqllogic` (§2): row-time MV UPDATE atomicity —
  asserts neither source nor MV backing retains the first row's effect, mid-txn
  and after rollback.

## Validation performed

- `yarn workspace @quereus/quereus test` → **3813 passing, 9 pending, 0 failing**.
- `lint` clean, `typecheck` clean (single-quoted globs on Windows).
- Targeted: 101 + 53 pass; `or-fail-mid-row-registration-race.spec.ts` +
  `savepoint-broadcast.spec.ts` (11 tests) pass — the broadcast/race behavior the
  refactored helper relies on is intact.
- Did NOT run `test:store` (LevelDB) — per AGENTS.md the agent default is the
  memory module. See gap #4.

## Known gaps / scrutiny points for the reviewer

1. **OR FAIL per-row branch for UPDATE/DELETE is not reachable from SQL.** I
   verified `UPDATE OR FAIL` / `UPDATE OR REPLACE` do **not parse** ("Expected
   table name") and there is no `DELETE OR FAIL` syntax — per-statement OR clauses
   on UPDATE/DELETE are pinned closed (see `41-fk-cascade-conflict-and-self-ref`
   §2 comment). So `plan.onConflict === FAIL` is, as far as I found, never true for
   UPDATE/DELETE statements, making the per-row branch effectively dead-code for
   those ops. It is kept because it is correct, harmless, and keeps the helper DRY
   with INSERT (where it IS reachable and covered by the or-fail race spec). The
   reviewer should confirm whether any schema-level `ON CONFLICT FAIL` directive
   can thread `plan.onConflict = FAIL` into an UPDATE/DELETE plan; if it can, an
   explicit test is warranted; if it provably cannot, decide whether to keep the
   branch or document it as intentional parity.
2. **All new tests drive the throw from the source iterator** (ConstraintCheckNode
   above the executor: NOT NULL, FK RESTRICT). The UNIQUE-collision UPDATE case
   *may* additionally exercise the `processRow` throw path (depends on whether
   secondary UNIQUE is vtab-enforced or a ConstraintCheck above — I did not verify
   which). A pure `processRow`-throw path for UPDATE/DELETE (vtab returns
   `isConstraintViolation`) is not independently covered by a new sqllogic case;
   it shares the helper's catch with INSERT's covered path. Reviewer may want a
   targeted case if that path is considered high-risk.
3. **Savepoint name prefix changed** `__or_abort_` → `__stmt_atomic_`. No test
   asserts the literal name (the race spec asserts depths). Grep confirmed
   `__or_abort_` had no other references.
4. **Store mode unrun.** The isolation/LevelDB layer's handling of the new
   UPDATE/DELETE statement savepoints was not exercised (INSERT already drives the
   identical broadcast path through the store, so risk is low, but worth a
   `test:store` pass before a release).
5. **Test-file coupling:** the new 101 section begins with a `COMMIT; -- run`
   guard because the preceding "Savepoint without explicit BEGIN" section leaves
   an explicit transaction open (it upgrades the implicit savepoint to explicit
   and RELEASE does not auto-commit). Without the guard, the section's `BEGIN`
   errors "already in a transaction". Minor, but a reviewer reorganizing the file
   should preserve it.

## Docs

`docs/runtime.md` gained a "Statement-Level Atomicity" subsection in the DML area
describing the shared helper, the non-FAIL vs OR FAIL savepoint strategy, and the
broadcast/lazily-registered-connection rationale.
