---
description: Materialize IN-subquery results to eliminate per-row re-execution in filter predicates
prereq: CacheNode infrastructure, characteristics framework, correlation detector
---

## Summary

Added `ruleInSubqueryCache` optimizer rule that wraps uncorrelated, deterministic IN-subquery sources in a `CacheNode` during planning. This eliminates per-row re-execution of IN subqueries (including recursive CTEs) in filter predicates, reducing O(N * K) CTE evaluations to O(K + N * K_cached).

## Implementation

### New rule: `src/planner/rules/cache/rule-in-subquery-cache.ts`

Registered in PostOptimization pass (priority 25, between CTE optimization at 20 and materialization advisory at 30). Guards:
1. InNode with subquery source (skip value-list IN)
2. Source not already cached
3. Source not correlated
4. Source is functional (deterministic, read-only)

### Registration: `src/planner/optimizer.ts`

Standard pass registration targeting `PlanNodeType.In`, phase `'rewrite'`.

## Testing

- **Test file**: `test/logic/07.7-in-subquery-caching.sqllogic`
- **Coverage**: basic uncorrelated IN, NULLs (3-valued logic), NOT IN with NULLs, empty set, correlated gate, recursive CTE patterns, nested CTE+join
- **All 667 tests pass** including the new test and all existing tests

## Documentation

- Updated `docs/optimizer.md`: added `ruleInSubqueryCache` to the caching rules list and Post-Optimization pass description.
