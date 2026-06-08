description: Fix crash when scalar functions wrap aggregates (e.g. coalesce(max(Id), 0))
files:
  - packages/quereus/src/planner/building/select-projections.ts
  - packages/quereus/src/planner/building/select-aggregates.ts
  - packages/quereus/src/planner/building/select.ts
  - packages/quereus/test/logic/07-aggregates.sqllogic
----

## Summary

Fixed `SELECT coalesce(max(Id), 0) FROM T` and similar scalar-wrapping-aggregate patterns that crashed with `Expected AggregateFunctionCallNode but got ScalarFunctionCallNode`.

### Root cause
`analyzeSelectColumns` pushed the entire outer `ScalarFunctionCallNode` into the aggregates list when `isAggregateExpression()` detected an aggregate inside a scalar wrapper. Emitters then failed expecting `AggregateFunctionCallNode`.

### Fix (3-file change)
- **select-projections.ts**: `collectInnerAggregates()` walks scalar trees extracting only `AggregateFunctionCallNode` instances with dedup. `analyzeSelectColumns` returns `hasWrappedAggregates` flag.
- **select-aggregates.ts**: `buildAggregatePhase` folds `hasWrappedAggregates` into `needsFinalProjection`.
- **select.ts**: Threads `hasWrappedAggregates` through.

## Tests (07-aggregates.sqllogic lines 77-94)
- `coalesce(max(id), 0)` — basic scalar wrapping aggregate
- `coalesce(max(val), 0)` — nullable column
- `coalesce(min(val), -1)` — min variant
- `grp, coalesce(max(val), 0) ... GROUP BY grp` — grouped variant
- `max(val) + 1` — binary expression wrapping aggregate

## Validation
- 1130 tests pass, 0 failures
- Build clean, no new lint issues
