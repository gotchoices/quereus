description: Edge-case sqllogic tests for self-joins, duplicates, correlated subqueries, and CTE edge cases
prereq: none
files:
  - packages/quereus/test/logic/23-self-joins-duplicates.sqllogic
  - packages/quereus/test/logic/07.8-correlated-subquery-edges.sqllogic
  - packages/quereus/test/logic/13.3-cte-edge-cases.sqllogic
  - packages/quereus/test/logic/README.md
----

## Summary

Three sqllogic test files covering query-structure edge cases. All tests pass. README updated with entries for the new files.

### 23-self-joins-duplicates.sqllogic
- Self-joins: basic with aliases, LEFT join for null manager, aggregation (count direct reports), correlated subquery on same table, multi-level (grandparent) join
- Duplicates: GROUP BY with all-duplicate keys, GROUP BY on single-value column, DISTINCT on all-duplicate column, ORDER BY with ties, many-to-many join cartesian products, IN subquery returning duplicates, multi-column DISTINCT

### 07.8-correlated-subquery-edges.sqllogic
- Empty correlation (outer row with no inner match → NULL aggregation)
- Multi-level correlation (subquery-of-subquery referencing outermost table)
- EXISTS vs IN equivalence verification
- Correlated subqueries in SELECT list, WHERE, HAVING positions
- COALESCE over NULL-returning correlated subquery
- NOT IN with NULLs in subquery (classic SQL gotcha — returns empty)

### 13.3-cte-edge-cases.sqllogic
- CTE referenced multiple times in same query (cross join with self)
- CTE referencing another CTE, chain of 3 CTEs
- Recursive CTE with 0 iterations (empty base case)
- Recursive CTE with 1 iteration (base only, no recursion)
- CTE with EXISTS checks (true and false cases)
- CTE in UPDATE/DELETE (documented as not yet supported — expect errors)
- CTE with set operations (UNION, INTERSECT)

## Review notes
- All expected values verified correct
- Proper table setup and cleanup (CREATE/DROP) in each file
- Deterministic ordering with ORDER BY on all multi-row queries
- File numbering follows existing conventions (07.8, 13.3, 23)
- No overlap with existing test coverage
