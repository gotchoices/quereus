description: Edge-case sqllogic tests for join subsystem
files:
  packages/quereus/test/logic/26-join-edge-cases.sqllogic
----

## Summary

Added `test/logic/26-join-edge-cases.sqllogic` with 8 sections of edge-case tests targeting the
join subsystem. All 1697 quereus tests pass.

## Test sections

1. **Complex residual predicates** — equality + inequality ON conditions, expression residuals,
   LEFT JOIN with residuals preserving unmatched rows
2. **Cross joins with filters** — arithmetic WHERE on cross product, full cartesian, empty result
3. **All-NULL join columns** — inner join zero rows, LEFT JOIN null-padding, mixed null/non-null
4. **Multi-condition keys with partial NULLs** — two-column ON with partial NULL preventing match
5. **Self-join with duplicate keys** — combinatorial explosion (3x3, 2x2), self-exclusion, unique pairs
6. **Semi/anti join with empty subquery** — correlated/uncorrelated EXISTS/NOT EXISTS/IN on empty table
7. **Join reordering correctness** — three-way join with different FROM orderings producing identical
   results, cross-table predicate filtering, three-way LEFT JOIN
8. **Outer join + aggregate interaction** — count(col) vs count(*), sum/avg/max/min on nullable side,
   coalesce pattern, HAVING on outer-join aggregates

## Review notes

- Sections 1, 2, 7 provide unique coverage not found in other test files
- Sections 3-6, 8 have some overlap with existing files (23, 91, 21, 12, 08.1) but serve as
  cohesive integration-level regression tests
- All table names use `je_` prefix to avoid collisions
- Proper cleanup with DROP TABLE at section and file end
- Deterministic ordering via ORDER BY on all multi-row queries
