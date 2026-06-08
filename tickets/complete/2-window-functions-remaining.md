---
description: Added LAG, LEAD, FIRST_VALUE, LAST_VALUE, PERCENT_RANK, CUME_DIST, NTILE runtime, RANGE BETWEEN
---

## Summary

Implemented the remaining window functions and RANGE BETWEEN value-based frames.

### New Functions
- **LAG(expr, offset?, default?)** / **LEAD(expr, offset?, default?)**: Navigation functions with optional offset and default
- **FIRST_VALUE(expr)** / **LAST_VALUE(expr)**: Frame-based value functions
- **PERCENT_RANK()**: `(rank - 1) / (partition_size - 1)`, returns 0 for single-row partitions
- **CUME_DIST()**: `(last_peer_index + 1) / partition_size`
- **NTILE(n)**: Now fully functional at runtime

### RANGE BETWEEN
- RANGE CURRENT ROW includes all peer rows (same ORDER BY values)
- RANGE N PRECEDING/FOLLOWING uses value-based offsets on the first ORDER BY expression
- Default frame (ORDER BY present, no explicit frame) uses RANGE semantics with peer grouping

### Multi-arg Infrastructure
- `WindowNode.functionArguments` is `ScalarPlanNode[][]` — supports multiple arguments per function
- `buildWindowFunctionArguments()` builds all args per function
- Runtime callback extraction reconstructs per-function arg groups from flattened list

## Key Files
- `packages/quereus/src/runtime/emit/window.ts` — core runtime (navigation, value, range frame support)
- `packages/quereus/src/planner/nodes/window-node.ts` — multi-arg functionArguments type
- `packages/quereus/src/planner/building/select-window.ts` — multi-arg argument building
- `packages/quereus/src/func/builtins/builtin-window-functions.ts` — 6 new function registrations
- `docs/window-functions.md` — updated docs (supported functions, RANGE vs ROWS, examples)

## Review Notes

### Code Quality
- Well-structured: each function kind (ranking, aggregate, navigation, value) has its own compute function
- RANGE frame logic cleanly separated into peer-group helpers (`findFirstPeer`, `findLastPeer`, `arePeerRows`) and offset helpers (`findRangeOffsetStart`, `findRangeOffsetEnd`)
- `computeRank()` properly extracted for reuse by both RANK and PERCENT_RANK
- `SortedPartition` interface pre-evaluates ORDER BY values once, avoiding repeated async evaluation in frame computations
- `getChildren`/`withChildren` on WindowNode correctly handles the flattened 2D arg structure

### Test Coverage
- 684 core tests passing, 0 failing
- Tests cover: LAG/LEAD (basic, offset, default, partitioned), FIRST_VALUE/LAST_VALUE (explicit frame, default frame, no ORDER BY), PERCENT_RANK/CUME_DIST (ties, single-row edge case), NTILE (various bucket sizes), RANGE BETWEEN (CURRENT ROW peers, N PRECEDING/FOLLOWING, UNBOUNDED, with value functions)

### Doc Updates (during review)
- Removed "Range frames with value-based bounds" from Future Enhancements (now implemented)
- Added RANGE vs ROWS explanation to Frame Specification section
- Added RANGE frame example to Usage section
- Added RANGE BETWEEN to testing section list
