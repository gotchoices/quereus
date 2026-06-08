description: Outer DML target table now visible to correlated subqueries in UPDATE SET / WHERE / RETURNING and DELETE WHERE / RETURNING. Also fixes UPDATE assignment evaluators not awaiting async (scalar subquery) values.
prereq:
files:
  packages/quereus/src/planner/building/update.ts
  packages/quereus/src/planner/building/delete.ts
  packages/quereus/src/runtime/emit/update.ts
  packages/quereus/test/logic/07.6.1-subquery-extras.sqllogic
  packages/quereus/test/logic/01.6-update-extras.sqllogic
  packages/quereus/test/logic/01.8-delete-extras.sqllogic
----
## Summary

Two related defects fixed so correlated subqueries in DML statements behave per SQL semantics.

### 1. DML target table visible to correlated subqueries (planner/scopes)

`buildUpdateStmt` and `buildDeleteStmt` only registered **unqualified** column symbols in their scope, so qualified `tableName.column` references inside nested subqueries failed to resolve and the planner threw `<table>.<col> isn't a column`.

Fix: wrap the column-registered `RegisteredScope` in `AliasedScope(registered, tableName, tableName)` — mirrors the SELECT path's `registerColumnScope` (`select.ts:255-269`). Now `tablename.column` delegates to the unqualified resolver in the wrapped scope. Self-correlated EXISTS over the same DML target with a different alias inside the subquery also works because the inner SELECT's own `AliasedScope` handles the inner alias.

### 2. UPDATE assignment evaluators awaited (runtime/emit)

Once fix #1 enabled correlated scalar subqueries in UPDATE SET, those subqueries returned `Promise<SqlValue>` from their callback. `emitUpdate` cast the result without awaiting, so the Promise object reached `MemoryTableManager.performUpdate` → `validateAndParse`, which rejected it with `Cannot convert object to TEXT/INTEGER`.

Fix: `await` the regular-assignment evaluator (`emit/update.ts:52`). Mirrors `filter.ts`. Phase 2 (generated columns) stays synchronous — `validateDeterministicGenerated` rejects scalar subqueries, and `withRowContext`'s `finally` removes the row context synchronously.

## Key files

- `packages/quereus/src/planner/building/update.ts:74-82` — `tableScope` wrap
- `packages/quereus/src/planner/building/delete.ts:74-82` — `tableScope` wrap
- `packages/quereus/src/runtime/emit/update.ts:52` — `await` on assignment evaluator

## Testing notes

Five `-- TODO bug:` blocks uncommented and asserting concrete results:

- `packages/quereus/test/logic/07.6.1-subquery-extras.sqllogic:15` — correlated aggregate scalar subquery in UPDATE SET
- `packages/quereus/test/logic/01.6-update-extras.sqllogic:28` — correlated plain SELECT in UPDATE SET
- `packages/quereus/test/logic/01.8-delete-extras.sqllogic:15` — correlated EXISTS in DELETE WHERE
- `packages/quereus/test/logic/01.8-delete-extras.sqllogic:32` — correlated NOT EXISTS in DELETE WHERE
- `packages/quereus/test/logic/01.8-delete-extras.sqllogic:89` — self-correlated EXISTS over same DML target with different inner alias

## Validation

- `yarn build` — clean
- `yarn workspace @quereus/quereus lint` — clean
- `yarn test` — 2522 passing, 3 pending, 0 failing

## Usage examples

```sql
-- Correlated scalar subquery in UPDATE SET
update sqx_outer set val = (select coalesce(sum(amount), 0)
                            from sqx_inner
                            where sqx_inner.ref_id = sqx_outer.id);

-- Correlated EXISTS in DELETE WHERE
delete from del_parent
 where exists (select 1 from del_child where del_child.parent_id = del_parent.id);

-- Self-correlated EXISTS over the same DML target
delete from seq where exists (select 1 from seq as s2 where s2.x = seq.x + 1);
```

## Notes for future work

- UPDATE/DELETE grammar has no target-table alias today (no `alias` field on `AST.UpdateStmt`/`AST.DeleteStmt`). If/when alias support lands, `tableScope` should be constructed with the alias instead of (or in addition to) the table name, matching SELECT.
- Schema-qualified DML resolution (`main.tablename.column`) still won't resolve in DML scoping — same gap as SELECT today, out of scope.
- Reviewed UPSERT DO UPDATE path (`runtime/emit/dml-executor.ts:196-200`): assignment evaluator already runs inside `await withAsyncRowContext(...)`, so the missing-await defect does **not** apply there.
