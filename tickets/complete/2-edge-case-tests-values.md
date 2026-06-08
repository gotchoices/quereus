description: Edge-case sqllogic tests for NULL semantics, boundary values, and mixed-type expressions
files:
  - packages/quereus/test/logic/21-null-edge-cases.sqllogic
  - packages/quereus/test/logic/22-boundary-values.sqllogic
----

## Summary

Two sqllogic test files providing systematic edge-case coverage for value-level semantics. All tests pass.

### 21-null-edge-cases.sqllogic
Covers NULL behavior in every SQL position: joins, GROUP BY, ORDER BY, CASE, IN/NOT IN, aggregates,
window functions, COALESCE, all comparison operators, DISTINCT, and subqueries. Properly validates
three-valued logic (e.g., NOT IN with NULL list → empty result).

### 22-boundary-values.sqllogic
Covers boundary values for INTEGER (±MAX_SAFE_INTEGER), REAL (1e-15, 1e15, 0.1+0.2 IEEE 754),
TEXT (empty string, embedded quotes, unicode), BLOB (empty, single byte), mixed-type arithmetic
(int+real→real, string coercion), cross-type comparisons, CASE with mixed-type branches, and
UNION with different column types.

## Review notes

- All tests pass (yarn test: 0 failures)
- Well-structured: clear section separators, concise comments, proper table cleanup (DROP TABLE)
- No DRY violations or unnecessary duplication
- Minimal overlap with existing tests in 03-expressions.sqllogic (which covers basics; these go deeper)
- Engine-specific behaviors documented: typeof(1.0)→"integer", 10/3→real, NULLs-first default
- Filed separate bug ticket (fix/nulls-first-last-desc-bug.md) for DESC NULLS FIRST/LAST
  ordering being reversed — the test correctly documents actual engine behavior
