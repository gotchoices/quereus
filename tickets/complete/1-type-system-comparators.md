---
description: Pre-resolved comparators to eliminate runtime overhead in hot paths
prereq: Logical type system, Memory VTable, Sort/Join nodes
---

## Summary

Eliminated runtime overhead in comparison hot paths by pre-resolving comparators at emit time (plan compilation). Two strategies applied based on type safety guarantees:

### Strategy 1: Typed Comparators (guaranteed same-type values)
`createTypedComparator()` leverages `LogicalType.compare()` to skip `getStorageClass()` detection entirely.

- **Aggregate GROUP BY keys** (`aggregate.ts`): Per-expression comparators from `plan.groupBy[i].getType()`.
- **Aggregate DISTINCT tracking** (`aggregate.ts`): Per-argument typed comparators for each aggregate function.
- **Window ORDER BY equality** (`window.ts`): Typed equality comparators for ranking functions (`rank`, `dense_rank`).

### Strategy 2: Collation-Only Pre-Resolution (mixed-type values possible)
`createCollationRowComparator()` pre-resolves collation functions but uses `compareSqlValuesFast()` for safe cross-type comparison.

- **DISTINCT** (`distinct.ts`): Collation-aware row comparator.
- **SET OPERATIONS** (`set-operation.ts`): All BTree-based operations (UNION, INTERSECT, EXCEPT).
- **JOIN USING** (`join.ts`): Pre-resolved column indices and collation functions.

### Strategy 3: Fixed Hardcoded Collation
- **Window ORDER BY sort** (`window.ts`): Fixed hardcoded `'BINARY'` to use actual collation from expression type.

## New Utilities (internal)

- `createTypedRowComparator(types, collations)` in `comparison.ts`
- `createCollationRowComparator(collations)` in `comparison.ts`

## Review Fixes Applied

- Renamed `typedRowComparator` to `collationRowComparator` in `distinct.ts` and `set-operation.ts` (was misleading — created via collation factory, not typed factory).
- Eliminated wasteful BTree creation for non-DISTINCT aggregates (both ternary branches were identical; now uses `null` for non-DISTINCT).
- Removed unnecessary variable alias in `window.ts` `sortRows()`.
- Removed misleading "backward compatibility" comment on `CollationFunction` re-export.
- Updated `docs/runtime.md` DISTINCT guidelines to show pre-resolved comparator pattern.

## Validation

- Build clean (no TypeScript errors)
- All 639 tests passing (0 failures, 7 pending)
- Covers: SQL logic tests (aggregates, distinct, set operations, joins, windows), memory vtable tests, performance sentinels, golden plan tests
