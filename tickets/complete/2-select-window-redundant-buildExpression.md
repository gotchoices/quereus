description: Eliminate redundant buildExpression calls in window function projection building
files:
  packages/quereus/src/planner/building/select-window.ts
----
## What was done

Eliminated redundant `buildExpression` calls in `buildWindowProjections` and `findWindowFunctionIndex`.
Previously each column in a SELECT with window functions triggered 2-3 `buildExpression` calls
(one for classification, one for projection, one inside `findWindowFunctionIndex`). Now each
column's expression is built once and reused.

### Changes

- `buildWindowProjections`: Builds `builtExpr` once per column, reuses for `isWindowExpression`
  check and as the projection node for non-window columns.
- `findWindowFunctionIndex`: Signature changed from `(AST.ResultColumnExpr, PlanningContext, ...)`
  to `(ScalarPlanNode, ...)`, eliminating its internal `buildExpression` call.

## Testing

All 1013+ existing tests pass, including window function tests in `test/logic/07.5-window.sqllogic`:
- Mixed window and non-window columns
- Multiple window functions with different PARTITION BY / ORDER BY
- COUNT(*) OVER (...) special-case handling
- Various frame specifications (ROWS, RANGE, UNBOUNDED, offsets)
- LAG/LEAD, FIRST_VALUE/LAST_VALUE, NTILE, PERCENT_RANK, CUME_DIST
- NULL handling in window partitions

No lint issues in the changed file. No doc updates needed (internal optimization).
