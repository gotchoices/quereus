description: Wrap multi-row UPDATE/DELETE in a statement-level savepoint (mirroring runInsert) so a mid-statement throw inside an explicit transaction rolls back the whole statement, not just the failing row. Pre-existing atomicity gap, widened by the row-time MV maintenance throw site.
prereq:
files: packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/core/database.ts, packages/quereus/test/logic/101-transaction-edge-cases.sqllogic, packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic
----

## Problem (reproduced)

A multi-row `UPDATE`/`DELETE` whose Nth row throws (constraint violation, FK
RESTRICT/action error, or the row-time MV maintenance hook) inside an **explicit**
transaction leaves rows 1..N-1 of that statement applied. SQL statements must be
atomic (SQLite's implicit-savepoint-per-statement semantics): all row effects apply
or none.

`runInsert` already guards this by opening a statement-level savepoint
(`__or_abort_*`) for non-FAIL conflict modes and rolling back to it on any throw
(`dml-executor.ts:315-394`). `runUpdate` (`dml-executor.ts:513-638`) and `runDelete`
(`dml-executor.ts:641-723`) have **no** such savepoint — they just `for await` over
rows and throw straight out of the loop.

In autocommit mode the gap is masked: `eval()` → `_finalizeImplicitTransaction(commit,
error)` rolls back the whole implicit transaction on error, so the statement looks
atomic. The defect only surfaces inside `begin; ... ` where rollback of the implicit
transaction never happens.

### Confirmed repro (minimized)

```sql
create table t (id integer primary key, x integer not null);
insert into t values (1, 10), (2, 20), (3, 30);
begin;
update t set x = case when id = 2 then null else x + 1 end where id in (1, 2);
-- error: constraint   (id=2 violates NOT NULL)
select id, x from t order by id;
-- BUG: id=1 is {x:11} — the first row's update survived the aborted statement.
-- EXPECTED: id=1 stays {x:10}.
rollback;
```

Run as a temporary `*.sqllogic` under `packages/quereus/test/logic/`, filtered with
`node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js
"packages/quereus/test/logic.spec.ts" --grep "<file-stem>"` from the repo root. The
assertion `{"id":1,"x":10}` fails with actual `{"id":1,"x":11}` on current HEAD.

Note (from ticket): `UPDATE OR REPLACE` does not parse in Quereus, so the row-time
REPLACE-on-update throw path is hard to drive from SQL — use a plain multi-row UPDATE
with a NOT NULL/CHECK/FK violation on a later row to exercise the gap (as above).

## Fix design

Mirror the `runInsert` savepoint scaffold in `runUpdate` and `runDelete`. The pattern
has two parts and **both** matter for correctness:

- **Non-FAIL modes** (ABORT default / IGNORE / REPLACE / ROLLBACK): open one
  statement-scope savepoint before the row loop, release it after the loop completes,
  and roll back to + release it on any throw escaping the loop. This is the actual
  atomicity fix.
- **OR FAIL mode**: do **not** wrap the whole statement (FAIL semantics keep prior
  rows). Instead open a per-row savepoint, release on success, roll back on throw —
  so the failing row's partial work (incl. a row-time backing write that lands before
  a later maintenance throw) is undone while earlier rows survive. `runInsert` gates
  this with `isFailMode = plan.onConflict === ConflictResolution.FAIL`; replicate.

Use the broadcast helpers (`_createSavepointBroadcast` /
`_releaseSavepointBroadcast` / `_rollbackAndReleaseSavepointBroadcast`) exactly as
`runInsert` does — never the bare non-broadcast variants. This keeps per-connection
savepoint stacks in lockstep with the TransactionManager stack.

### Lazily-registered connection concern — already handled, just preserve it

The row-time backing connection is registered mid-statement on first maintenance call
(`database-materialized-views.ts:getBackingConnection` →
`db.registerConnection`). `Database.registerConnection`
(`database.ts:1597-1631`) replays the active savepoint depth onto the new connection
(`for depth in 0..getActiveSavepointDepth()`), so a statement savepoint created
*before* the backing connection exists is replayed onto it and participates in the
subsequent rollback-to/release broadcast. Because we create the statement savepoint
*before* the row loop (before any maintenance runs), this replay path covers it — the
same reason INSERT §10 already passes. No new wiring needed; just don't create the
savepoint lazily after the first row.

### Savepoint naming

`runInsert` uses module-scope `stmtSavepointCounter` with prefix `__or_abort_`. Reuse
the **same** `stmtSavepointCounter` (it already guarantees uniqueness across
concurrent/nested emissions — e.g. an FK cascade UPDATE during a parent UPDATE). A
distinct prefix per op is fine for readability (`__or_abort_` is generic enough to
share), but the counter MUST be shared so a cascade-nested savepoint name can't
collide with the parent's.

### DRY consideration

The savepoint scaffold (create-or-not by FAIL mode, per-row vs statement savepoint,
release-on-success, rollback-on-throw, `disconnectVTable` in `finally`) is now
identical across all three generators except the per-row body. Strongly prefer
extracting a shared higher-order wrapper — e.g. a `runWithStatementSavepoints(ctx,
vtab, rows, isFailMode, processRow)` async-generator helper that owns the savepoint
lifecycle and calls back a per-row `processRow(flatRow) => Promise<Row | undefined>`.
`runInsert`/`runUpdate`/`runDelete` then reduce to context-evaluator setup + a
per-row closure. This avoids triplicating the subtle savepoint logic (AGENTS.md: stay
DRY, small single-purpose functions). If the refactor proves too invasive given
`runInsert`'s extra UPSERT/REPLACE branching, fall back to copying the scaffold into
`runUpdate`/`runDelete` verbatim — but document the duplication.

## Validation

- New sqllogic coverage asserting statement atomicity inside an explicit transaction
  for both UPDATE and DELETE (the autocommit path is already atomic, so the test
  MUST wrap in `begin; ... rollback;` and assert the earlier row's effect did not
  survive the failing statement). Put the plain-table cases in
  `101-transaction-edge-cases.sqllogic` (or `90.4-dml-errors.sqllogic`).
  - UPDATE: the confirmed repro above.
  - DELETE: drive a mid-statement throw via an FK RESTRICT (a child row referencing
    the 2nd target) or a deferred-constraint/maintenance throw on a later row;
    assert the 1st row was not deleted. If a clean SQL-level DELETE throw on a
    later-but-not-first row is awkward to construct, document the chosen mechanism.
- Add a row-time MV atomicity case to `53-materialized-views-rowtime.sqllogic`
  alongside §2 (the existing INSERT §10/§2 atomicity check): inside `begin; ...
  rollback;`, run a multi-row UPDATE over a row-time-covered source where a later row
  violates a source constraint; assert neither the source nor the MV backing table
  retains the first row's effect. (Source + backing already commit/rollback in
  lockstep, so this mainly locks the statement-savepoint behavior end-to-end.)
- `yarn workspace @quereus/quereus test` green; `yarn workspace @quereus/quereus run
  lint` clean (single-quote globs on Windows). `yarn workspace @quereus/quereus run
  typecheck` clean.

## TODO

- Extract or replicate the `runInsert` statement-/row-savepoint scaffold into
  `runUpdate` and `runDelete` in `dml-executor.ts`, sharing `stmtSavepointCounter`
  and using the broadcast helpers. Prefer a shared `runWithStatementSavepoints`
  higher-order generator; document if you instead duplicate.
- Confirm OR FAIL on UPDATE/DELETE keeps prior rows while undoing the failing row
  (per-row savepoint path), and non-FAIL rolls back the whole statement.
- Add UPDATE + DELETE atomicity sqllogic cases (explicit-transaction wrapped) to
  `101-transaction-edge-cases.sqllogic` (and/or `90.4-dml-errors.sqllogic`).
- Add a row-time MV UPDATE atomicity case to `53-materialized-views-rowtime.sqllogic`.
- Run test + lint + typecheck for `@quereus/quereus`; verify the repro now passes.
- If touching transaction/atomicity semantics, update `docs/runtime.md` (or the DML
  section of the relevant doc) noting statement-level savepoint atomicity now covers
  UPDATE/DELETE, not just INSERT.
