description: Edge-case sqllogic tests for empty tables, single-row tables, and empty set operations
files:
  - packages/quereus/test/logic/20-empty-single-row.sqllogic
----

## What was built

Added `packages/quereus/test/logic/20-empty-single-row.sqllogic` — comprehensive edge-case tests covering table cardinality boundaries (0 rows and 1 row).

### Empty table (0 rows):
- SELECT, aggregates (count/sum/avg/min/max/group_concat), JOINs (INNER/LEFT/CROSS), subqueries (IN/EXISTS/NOT EXISTS/scalar), CTEs, set operations (UNION/INTERSECT/EXCEPT/UNION ALL), DML (UPDATE/DELETE), INSERT...SELECT, window functions

### Single-row table:
- All join types with match/non-match, CROSS JOIN single×multi, GROUP BY with HAVING match/no-match, window functions (row_number/rank/sum/lag/lead)

## Testing
- All 1161 quereus tests pass
- Build succeeds
- Follows established sqllogic conventions (lowercase SQL, `→ [json]`, `:1` column disambiguation, cleanup via DROP)
