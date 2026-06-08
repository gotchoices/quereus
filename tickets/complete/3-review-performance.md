---
description: Performance review — sentinel tests, hot-path analysis, and follow-up optimization tasks
prereq: None

---

## Summary

Reviewed performance characteristics across all critical paths: parser, planner/optimizer, runtime scheduler, emitters, comparison/coercion utilities, and memory virtual table.

## Testing

Created `packages/quereus/test/performance-sentinels.spec.ts` — 12 regression sentinel tests with generous thresholds (10–50× headroom) that catch catastrophic regressions without flaking on CI. Coverage:

- **Parser** (3 tests): simple SELECT, wide SELECT (50 cols), deeply nested expressions — all complete in <500 ms for 100 iterations
- **End-to-end queries** (5 tests): full scan, filtered scan, GROUP BY, ORDER BY, self-join, correlated subquery over 1000-row table
- **Bulk mutations** (2 tests): 1000-row bulk insert, 50 PK lookups after bulk insert
- **Statement reuse** (1 test): 50 prepare+execute cycles

The self-join sentinel (50×1000 rows, nested-loop) establishes a baseline of ~3500–4200 ms with an 8000 ms threshold, documenting the need for bloom/hash join.

## Key Findings

### Hot-Path Issues (filed as follow-up tasks)

1. **`resolveAttribute` O(n) per column reference** — allocates `Array.from(...).reverse()` on every call. Filed: `tasks/plan/attribute-lookup-optimization.md`

2. **Per-row context mutations in streaming emitters** — filter.ts, project.ts, distinct.ts use `withRowContextGenerator`/`withAsyncRowContext` (Map.set/delete per row) instead of the efficient `createRowSlot` pattern used by join.ts and scan.ts. Filed: `tasks/plan/row-slot-generalization.md`

3. **Nested-loop join O(n×m)** — self-join of 50×1000 rows takes ~4 seconds. Updated existing: `tasks/plan/4-join-algorithms.md` with benchmark baseline.

### Minor Inefficiencies (not individually filed — covered by `tasks/plan/performance-scalability.md`)

- `tryCoerceToNumber` calls `value.trim()` twice (guard + body)
- `NOCASE_COLLATION` allocates `toLowerCase()` strings per comparison
- `coerceForAggregate` calls `functionName.toUpperCase()` on every invocation
- Parser creates location objects for every AST node (~4.8 KB per 100 nodes)

### Architecture Strengths

- Scheduler 3-tier execution (optimized/tracing/metrics) with tight synchronous loop
- `compareSqlValuesFast` with pre-resolved collation and branchless type ordering
- `createOrderByComparatorFast` pre-computes flags in closures
- Optimizer structural sharing (no deep cloning), triple-guarded convergence
- Parser: recursive descent, no backtracking, character-by-character lexer (no regex)

## Validation

All 12 sentinel tests pass. Run with:
```
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/performance-sentinels.spec.ts" --timeout 30000
```

