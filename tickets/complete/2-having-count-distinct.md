---
description: Support HAVING with COUNT(DISTINCT ...) and other DISTINCT aggregates
---

## Summary

Added support for `HAVING` clauses containing aggregate functions with the `DISTINCT` modifier (e.g., `HAVING COUNT(DISTINCT col) > 1`).

## Key Changes

- **`function-call.ts`**: Aggregate matching now compares `isDistinct` flag so `COUNT(DISTINCT val)` and `COUNT(val)` are correctly treated as separate aggregates.
- **`select-aggregates.ts`**: `findAggregateFunctionExprs()` walks the HAVING AST to discover aggregate calls; `collectHavingAggregates()` adds any not already in SELECT to the `AggregateNode`.
- **`select.ts`**: Forces a final `ProjectNode` with `preserveInputColumns = false` to strip HAVING-only aggregate columns from output.

## Tests

Five sqllogic tests in `07-aggregates.sqllogic`:
- HAVING-only `COUNT(DISTINCT col)`
- `COUNT(DISTINCT col)` in both SELECT and HAVING
- `SUM(DISTINCT val)` in HAVING
- Mixed: `COUNT(val)` in SELECT vs `COUNT(DISTINCT val)` in HAVING
- Multiple distinct aggregates in a HAVING expression

All 684 tests pass; build clean.
