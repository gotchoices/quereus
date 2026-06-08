description: Tests for under-covered planner analysis, optimizer rules, stats, and plan nodes
files:
  packages/quereus/test/optimizer/predicate-normalizer.spec.ts
  packages/quereus/test/optimizer/statistics-edge-cases.spec.ts
  packages/quereus/test/optimizer/cache-rules.spec.ts
  packages/quereus/test/optimizer/plan-shape-decisions.spec.ts
  packages/quereus/test/logic/100-predicate-normalization-edge-cases.sqllogic
----

## What was built

83 new tests across 5 files covering planner/optimizer code paths that were previously under-covered.

### Test suites

1. **Predicate normalizer** (16 tests) — De Morgan's law, double negation elimination, NOT pushdown on all comparison operators, OR flattening, OR-to-IN collapse, AND flattening, NOT BETWEEN, NULL handling, tautology/contradiction edge cases.

2. **Statistics edge cases** (38 tests) — Histogram: single-value, all-duplicate, string values, boundary, out-of-range, zero totalRows, <=/>=/== operators. CatalogStatsProvider: zero rowCount, no column ref, unknown node type, IN selectivity (normal + clamped), BETWEEN with/without histogram, <> alias, IS NULL/NOT NULL, all-null column, join selectivity fallback, index selectivity delegation.

3. **Cache & optimizer rules** (15 tests) — Distinct elimination (PK, non-unique, unique index, multi-column, correctness). Streaming vs hash aggregate. IN-subquery caching (uncorrelated, correlated, value-list). Mutating subquery correctness.

4. **Plan shape decisions** (14 tests) — Predicate pushdown (join filter, view pushdown). CTE materialization (single-use inline, multi-use, recursive). Limit/Offset (ordering, offset, LIMIT 0, offset beyond rows). Delete node. Table function call (query_plan, schema).

5. **SQLLogic normalization** (18 SQL tests) — End-to-end correctness for all normalization transformations.

## Validation

- All 83 new tests pass
- Full suite: 1697 passing, 2 pending (pre-existing)
- TypeScript type check: clean
- No regressions

## Review notes

- Resource cleanup properly handled (db.close in afterEach)
- Tests verify both correctness (result values) and plan structure (operator nodes)
- Statistics mocks align with actual CatalogStatsProvider interfaces
- Docs in docs/optimizer.md already cover all tested features
- Helper duplication (allRows, queryPlanOps) matches established codebase pattern
