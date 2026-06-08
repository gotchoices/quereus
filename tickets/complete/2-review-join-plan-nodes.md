description: Review of join plan nodes (nested-loop, bloom, merge)
files:
  packages/quereus/src/planner/nodes/join-node.ts
  packages/quereus/src/planner/nodes/bloom-join-node.ts
  packages/quereus/src/planner/nodes/merge-join-node.ts
  packages/quereus/src/runtime/emit/join.ts
  packages/quereus/src/runtime/emit/bloom-join.ts
  packages/quereus/src/runtime/emit/merge-join.ts
  packages/quereus/src/planner/util/key-utils.ts
----
## Findings

### smell: DRY violation across three join plan nodes and emitters
file: packages/quereus/src/planner/nodes/bloom-join-node.ts, merge-join-node.ts, join-node.ts
`buildAttributes()`, `getType()`, and `estimatedRows` are near-identical across all three classes. The three emitters also duplicate the semi/anti/left join output logic. Not a correctness issue but a maintenance burden.
Ticket: tickets/plan/2-plan-join-node-dry-refactor.md

### defect: Pre-existing test failure in keys-propagation.spec.ts
file: packages/quereus/test/optimizer/keys-propagation.spec.ts:37
`String(rows[0].props)` produces `[object Object],...` instead of JSON. The test "Join combines keys for inner join (conservative)" has been failing. Not caused by join node code — it's a test serialization bug.
Ticket: tickets/fix/fix-keys-propagation-test.md

### note: `right` and `full` JOIN not implemented at runtime
file: packages/quereus/src/runtime/emit/join.ts:46-51
The nested-loop emitter throws UNSUPPORTED for right/full joins. Bloom and merge emitters don't support them either. The plan nodes correctly handle nullable column metadata for these types, so adding runtime support later should be straightforward. The physical selection rule prevents right/full from reaching bloom/merge emitters.

### note: BloomJoinNode/MergeJoinNode missing `right`/`full` in estimatedRows
file: packages/quereus/src/planner/nodes/bloom-join-node.ts:160-172
The `right` and `full` join types fall through to `default: leftRows * rightRows * 0.1` instead of the correct `rightRows` / `leftRows + rightRows`. Currently unreachable since the physical selection rule doesn't create these combinations.
Ticket: tickets/plan/2-plan-join-node-dry-refactor.md (covered in refactor)

### note: Conservative key propagation in physical join nodes
file: packages/quereus/src/planner/nodes/bloom-join-node.ts:125
BloomJoinNode and MergeJoinNode return `keys: []` in `getType()`. This is correct because `computePhysical()` handles key propagation via `analyzeJoinKeyCoverage`, and downstream consumers use physical properties for key-based optimizations.

### note: MergeJoinNode conservatively drops ordering for LEFT joins
file: packages/quereus/src/planner/nodes/merge-join-node.ts:144-146
The merge join emitter actually preserves left-side order for LEFT joins, so `computePhysical` could declare ordering. Being conservative avoids correctness risk.

## Trivial Fixes Applied
- None needed

## No Issues Found (correctness verified)
- join-node.ts — Join type correctness, null handling, outer join nullable column metadata, semi/anti attribute projection, equi-pair extraction with both column orderings, `withChildren` identity check, cost estimation heuristics all correct.
- bloom-join-node.ts — Hash map build/probe pattern correct, null keys skipped, residual condition evaluated, LEFT JOIN null padding, semi/anti short-circuit, collation-aware key normalization, resource cleanup via try/finally.
- merge-join-node.ts — Sorted merge with run detection correct, null key handling on both sides, duplicate key run cross-product, LEFT JOIN null padding, resource cleanup via try/finally.
- key-utils.ts — `analyzeJoinKeyCoverage` correctly handles semi/anti (preserves left keys), inner/cross (combines keys), and outer (returns empty). FK-PK alignment check is sound.
- All 5 join-related sqllogic test suites pass (11-joins, 82-bloom-join, 83-merge-join, 12-join_padding_order, 08.1-semi-anti-join).

## Test Coverage
Tests cover: inner join, left join, cross join, semi join, anti join, multi-column equi-joins, NULL handling (both sides), empty tables (both sides), duplicate key runs, USING clause, NOCASE collation, null padding with aggregates and window functions, plan introspection verifying algorithm selection, RIGHT JOIN error case.
