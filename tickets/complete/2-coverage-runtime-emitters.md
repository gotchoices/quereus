description: Edge-case sqllogic tests for under-covered runtime emitters and DDL paths
prereq: none
files:
  packages/quereus/test/logic/91-merge-join-edge-cases.sqllogic
  packages/quereus/test/logic/92-hash-aggregate-edge-cases.sqllogic
  packages/quereus/test/logic/93-ddl-view-edge-cases.sqllogic
  packages/quereus/test/logic/94-tvf-edge-cases.sqllogic
  packages/quereus/test/logic/94.1-limit-offset-edge-cases.sqllogic
  packages/quereus/test/logic/96-subquery-edge-cases.sqllogic
----
## What was built

Six sqllogic test files targeting under-covered runtime emitter branches:

- **91-merge-join-edge-cases** — Self-joins, residual conditions, NULL keys, many-to-many, empty sides, multi-column keys
- **92-hash-aggregate-edge-cases** — Empty GROUP BY, NULL groups, DISTINCT aggregates, expression keys, HAVING, group_concat(DISTINCT)
- **93-ddl-view-edge-cases** — CREATE/DROP VIEW IF [NOT] EXISTS, error paths, drop-and-recreate cycle, ALTER TABLE ADD CONSTRAINT with CHECK
- **94-tvf-edge-cases** — json_each on empty/single/null/nested inputs, subquery context, filtering, aggregation, LIMIT
- **94.1-limit-offset-edge-cases** — LIMIT 0, negative LIMIT/OFFSET, OFFSET beyond count, MySQL syntax, subquery usage, CAST fallback paths
- **96-subquery-edge-cases** — IN with NULLs (three-valued logic), EXISTS, scalar subquery edge cases, 3-level correlated subqueries, NOT IN with NULLs

## Coverage improvements

| File | Before | After | Delta |
|------|--------|-------|-------|
| create-view.ts | 28% | 90% | +62% |
| drop-view.ts | 22% | 77% | +55% |
| limit-offset.ts | 50% | 62% | +12% |
| cast.ts | — | 69% | new |
| Overall emit/ | 82% | 83.3% | +1.3% |

Remaining uncovered branches are documented in the ticket (optimizer preferences, TODO stubs, unreachable parser paths).

## Testing

- 1697 tests passing, 0 failures
- Lint: pre-existing issues only
- All test files follow conventions (table prefix per file, cleanup via DROP TABLE)
