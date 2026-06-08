description: Extract shared logic from JoinNode / BloomJoinNode / MergeJoinNode to reduce duplication
files:
  packages/quereus/src/planner/nodes/join-utils.ts       # shared plan-node utilities
  packages/quereus/src/planner/nodes/join-node.ts
  packages/quereus/src/planner/nodes/bloom-join-node.ts
  packages/quereus/src/planner/nodes/merge-join-node.ts
  packages/quereus/src/runtime/emit/join-output.ts       # shared emitter helper
  packages/quereus/src/runtime/emit/join.ts
  packages/quereus/src/runtime/emit/bloom-join.ts
  packages/quereus/src/runtime/emit/merge-join.ts
----

## What was built

Extracted duplicated logic from three join plan-node classes and three join emitters into two shared utility modules.

### Plan-node utilities (`join-utils.ts`)

- `buildJoinAttributes()` — shared attribute construction for all join nodes. Handles semi/anti (left-only), preserveAttributeIds passthrough, and nullable marking for outer joins.
- `buildJoinRelationType()` — shared `getType()` logic. Combines columns, computes `isSet`, merges `rowConstraints`.
- `estimateJoinRows()` — shared row estimation with full switch covering all join types. Fixes missing `right`/`full` cases in BloomJoinNode and MergeJoinNode.
- `EquiJoinPair` interface — canonical definition; re-exported from `bloom-join-node.ts` for backward compatibility.

### Emitter output helper (`join-output.ts`)

- `joinOutputRow()` — shared post-match output logic for semi/anti yields and LEFT JOIN null-padding. All three emitters replaced their inline post-match block with a call to this function.

## Testing

- Build: passes
- All 1130 tests pass (2 pre-existing pending)
- No new tests needed — pure refactor plus the `right`/`full` estimateJoinRows fix
- Key test coverage: `11-joins.sqllogic`, `82-bloom-join.sqllogic`, `83-merge-join.sqllogic`, `08.1-semi-anti-join.sqllogic`
- No lint issues in changed files

## Usage

No API changes. All exports preserved.
