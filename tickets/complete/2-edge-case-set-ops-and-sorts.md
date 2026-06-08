description: Edge-case sqllogic tests for set operations and ORDER BY
files:
  packages/quereus/test/logic/28-set-ops-sort-edge-cases.sqllogic
  packages/quereus/src/runtime/emit/set-operation.ts
  packages/quereus/src/runtime/emit/sort.ts
  packages/quereus/src/planner/building/select-compound.ts
  packages/quereus/src/planner/nodes/set-operation-node.ts
  docs/sql.md
----

Added 28 edge-case tests in `28-set-ops-sort-edge-cases.sqllogic` covering:

**Set operations:** empty inputs (UNION/UNION ALL/INTERSECT/EXCEPT/DIFF), all-duplicate inputs,
three-way right-associative evaluation, CTE workaround for left-to-right, column count mismatch
errors, ORDER BY on combined results (ASC/DESC), type preservation across UNION, EXCEPT with
disjoint sets, DIFF identity properties (A DIFF A = empty, A DIFF empty = A, empty DIFF A = A).

**Sorting:** stability with duplicate keys, expression-based ORDER BY with NULLs (coalesce, IS NULL),
ORDER BY on aliased expressions, 5-column mixed ASC/DESC with NULLS FIRST, subquery vs outer
ORDER BY precedence.

**Doc update:** Added note in `docs/sql.md` about right-associative compound set operation evaluation.

**Validation:** All 1697 tests pass, typecheck clean. No bugs found — all edge cases behave correctly.
