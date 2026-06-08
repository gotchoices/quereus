description: Review of aggregate and window plan nodes
files:
  packages/quereus/src/planner/nodes/aggregate-node.ts
  packages/quereus/src/planner/nodes/hash-aggregate.ts
  packages/quereus/src/planner/nodes/stream-aggregate.ts
  packages/quereus/src/planner/nodes/aggregate-function.ts
  packages/quereus/src/planner/nodes/window-node.ts
  packages/quereus/src/planner/nodes/window-function.ts
  packages/quereus/src/runtime/emit/aggregate.ts
  packages/quereus/src/runtime/emit/hash-aggregate.ts
  packages/quereus/src/runtime/emit/window.ts
  packages/quereus/src/runtime/emit/window-function.ts
----
## Findings

### smell: Extensive code duplication across aggregate node classes
files: aggregate-node.ts, hash-aggregate.ts, stream-aggregate.ts
`getGroupByColumnName`, `withChildren`, `getLogicalAttributes`, `buildAttributes`, `getType`, `getChildren`, `getRelations`, and `estimatedRows` are duplicated (or near-duplicated) across all three classes. Physical nodes add source attribute pass-through but core logic is identical.
Ticket: tickets/plan/deduplicate-aggregate-node-classes.md

### smell: O(n^2) window ranking functions
file: packages/quereus/src/runtime/emit/window.ts
RANK, DENSE_RANK, PERCENT_RANK, and CUME_DIST all re-evaluate ORDER BY callbacks in nested loops. Pre-computed orderByValues exist but ranking functions don't use them consistently.
Ticket: tickets/plan/window-ranking-quadratic-perf.md

## Trivial Fixes Applied
- aggregate-node.ts:236 — removed unnecessary `(props as any)` cast; `props` is `Record<string, unknown>` so `.uniqueKeys` assignment is valid without `any`
- stream-aggregate.ts:35-36 — removed extraneous blank lines in constructor body
- stream-aggregate.ts:40 — fixed inconsistent indentation on `buildAttributes` method (extra leading spaces)
- aggregate-function.ts:72,79 — replaced `throw new Error` with `quereusError(..., StatusCode.INTERNAL)` for consistency with other plan nodes
- window-node.ts:109 — replaced `throw new Error` with `quereusError(..., StatusCode.INTERNAL)` for consistency
- window-function.ts:55 — replaced `throw new Error` with `quereusError(..., StatusCode.INTERNAL)` for consistency

## No Issues Found
- aggregate-node.ts — clean (correctness, logic, attribute lifecycle, cost estimation all sound)
- hash-aggregate.ts — clean (hash cost model, key serialization with null grouping, DISTINCT handling all correct)
- stream-aggregate.ts — clean (streaming group-change detection, context lifecycle, finalization correct)
- aggregate-function.ts — clean (DISTINCT flag, FILTER, ORDER BY within aggregates, type inference all correct)
- window-node.ts — clean (attribute preservation, window spec grouping, child management all correct)
- window-function.ts — clean (type resolution, zero-ary node contract correct)
- emit/aggregate.ts — clean (context push/pop lifecycle, DISTINCT BTree tracking, coercion optimization correct)
- emit/hash-aggregate.ts — clean (reuses shared utilities from aggregate.ts, GroupState lifecycle correct)
- emit/window.ts — clean (frame bounds, RANGE vs ROWS, partition/sort logic, navigation/value functions all correct)

## Test Coverage
- packages/quereus/test/optimizer/hash-aggregate.spec.ts — 15 tests covering hash aggregate selection, GROUP BY, NULLs, DISTINCT, HAVING, empty tables
- packages/quereus/test/planner/window-function-types.spec.ts — type inference for ranking and aggregate window functions
- packages/quereus/test/logic/07-aggregates.sqllogic — comprehensive aggregate function and GROUP BY/HAVING tests
- packages/quereus/test/logic/06.6-aggregate-extended.sqllogic — extended aggregate tests (TOTAL, variance, stddev)
- packages/quereus/test/logic/07.5-window.sqllogic — window function tests (ROW_NUMBER, RANK, DENSE_RANK, LAG, LEAD, FIRST_VALUE, LAST_VALUE, SUM/COUNT OVER with ROWS frames)

All 472 tests passing (1 pre-existing failure in unrelated keys-propagation test).
