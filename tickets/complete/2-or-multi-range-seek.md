description: OR disjunctions with range predicates on same index → multiple range scans
files:
  - packages/quereus/src/planner/analysis/constraint-extractor.ts
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts
  - packages/quereus/src/vtab/memory/layer/scan-plan.ts
  - packages/quereus/src/vtab/memory/layer/base-cursor.ts
  - packages/quereus/src/vtab/memory/layer/transaction-cursor.ts
  - packages/quereus/src/vtab/memory/module.ts
  - packages/quereus/src/vtab/best-access-plan.ts
  - packages/quereus/test/optimizer/or-multi-range-seek.spec.ts
----

## Summary

OR disjunctions with range predicates on the same indexed column (e.g., `WHERE price > 1000 OR price < 10`) now produce multi-range index seeks instead of falling back to full table scans with residual filters.

### Pipeline

```
SQL: WHERE price > 1000 OR price < 10
  → constraint-extractor: tryExtractOrBranches → OR_RANGE constraint with ranges[]
  → module.evaluateIndexAccess: recognize OR_RANGE → multi-range access plan
  → rule-select-access-path: build IndexSeekNode with plan=6;rangeCount=N;rangeOps=...
  → scan-plan.buildScanPlanFromFilterInfo: plan=6 → populate ranges[]
  → base-cursor / transaction-cursor: decompose into sequential single-range scans
```

### Key Changes

- `ConstraintOp`: Added `'OR_RANGE'`
- `RangeSpec` interface + `ranges?: RangeSpec[]` on `PredicateConstraint`
- `tryCollapseToOrRange()`: detects all-range-same-column OR branches
- `findOrRangeMatch()` in module
- `plan=6` handling in scan-plan, access path rule, and cursors

## Testing

10 tests in `test/optimizer/or-multi-range-seek.spec.ts`: disjoint ranges, bounded ranges, mixed equality+range, three branches, plan verification, PK OR-range, empty results, single-row ranges, regression for single-range and IN-list.

## Review Notes

- Docs updated: optimizer.md and memory-table.md now reflect OR_RANGE support
- Build passes; 277 tests pass (1 pre-existing failure in semi-anti-join unrelated)
- No API changes — transparent optimization for qualifying queries
