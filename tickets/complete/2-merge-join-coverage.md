description: Merge join emitter exercised via PK-ordered join path — coverage 17% → 91%
files:
  packages/quereus/src/vtab/memory/module.ts
  packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts
  packages/quereus/src/runtime/emit/merge-join.ts
  packages/quereus/src/planner/nodes/merge-join-node.ts
  packages/quereus/src/runtime/emit/join-output.ts
  packages/quereus/test/logic/83-merge-join.sqllogic
----

## Summary

Two planner-level fixes enable the merge join path for PK-equi-joins on memory tables:

1. **Memory module advertises inherent PK ordering** (`module.ts:186-204`): B-tree scans
   produce rows in PK order.  When no `requiredOrdering` is present and the plan uses
   the primary index, `providesOrdering` is set to the PK column specs.

2. **Equi-pair reordering for multi-column PKs** (`rule-join-physical-selection.ts:126-156`):
   `reorderEquiPairsForMerge()` permutes equi-pairs to match both sources' physical
   ordering prefix before costing the merge join.

## Coverage

`emit/merge-join.ts`: 17% / 0 functions → 90.8% / 100% functions

## Testing

`83-merge-join.sqllogic` covers: PK inner/left/semi/anti joins, multi-column composite
PK joins, partial PK overlap, empty table edge cases, NULL handling, NOCASE collation,
duplicate key runs, USING clause, text column joins, and plan-shape assertions confirming
MergeJoin selection.

## Review notes

- Code is DRY: `joinOutputRow` shared with bloom-join; join attribute/type building reuses `join-utils.ts`
- Resource cleanup: `try/finally` in emitter closes row slots
- `reorderEquiPairsForMerge` validates both left and right side ordering before accepting reorder
- `computePhysical` conservatively omits ordering for LEFT joins (safe; bloom-join does the same)
- All tests pass, build clean, no new lint issues
