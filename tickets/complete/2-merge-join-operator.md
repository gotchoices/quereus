---
description: Merge join operator for sorted inputs — complete
prereq: BloomJoinNode, optimizer physical selection rule
---

## Summary

Merge join operator that exploits pre-sorted inputs to perform equi-joins in a single linear pass. The optimizer performs a three-way cost comparison (nested-loop vs hash vs merge) and selects merge join when it's cheapest, inserting SortNodes when inputs aren't already ordered.

### Key Files

| File | Role |
|------|------|
| `src/planner/nodes/merge-join-node.ts` | `MergeJoinNode` — plan node implementing `BinaryRelationalNode`, `JoinCapable`, `PredicateSourceCapable` |
| `src/runtime/emit/merge-join.ts` | Emitter with sorted merge algorithm, run detection, LEFT JOIN null-padding, residual evaluation |
| `src/planner/rules/join/rule-join-physical-selection.ts` | Three-way cost comparison, ordering detection, SortNode insertion |
| `src/planner/cost/index.ts` | `MERGE_JOIN_PER_ROW` (0.3), `mergeJoinCost()` |
| `src/runtime/register.ts` | `PlanNodeType.MergeJoin` → `emitMergeJoin` registration |

### Design

- **Algorithm**: Materializes right side into sorted array; streams left side with a pointer into the right array. Collects "runs" of equal keys to produce cross-products for duplicate keys.
- **Ordering preservation**: Merge join preserves left-side ordering in `computePhysical()` (unlike hash join which destroys ordering).
- **Sort insertion**: `isOrderedOnEquiPairs()` detects existing ascending ordering via positional matching against equi-pair columns. Falls back to inserting SortNodes when ordering is absent, descending, or doesn't match equi-pair column order.
- **Node structure**: Mirrors BloomJoinNode exactly (same interfaces, same attribute/type/physical logic patterns).

### Review Findings & Fixes

- **Fixed `isOrderedOnEquiPairs()`**: Changed from set-based column matching to strict positional matching with ascending direction verification. The original set-based check had two bugs: (1) didn't verify ascending direction — a descending-sorted source would bypass sort insertion; (2) didn't verify column order matched equi-pair order — for multi-column joins, a source sorted on (b, a) would falsely pass for equi-pairs expecting (a, b) order, breaking the linear-scan invariant.
- **Updated docs**: optimizer.md (rule description, physical join section, future work), rules README, todo.md.

### Testing

- `test/logic/83-merge-join.sqllogic` — covers INNER/LEFT joins, multi-column equi-joins, NULL key handling, empty tables, text columns, USING clause, duplicate key cross-products, size asymmetry, NOCASE collation.
- All 684 engine tests pass, 0 failing, 7 pending (pre-existing).
- Build succeeds cleanly.
