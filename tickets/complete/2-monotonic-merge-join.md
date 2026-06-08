---
description: Monotonic-aware merge-join recognition rule + shared equi-pair extractor
files: packages/quereus/src/planner/rules/join/rule-monotonic-merge-join.ts, packages/quereus/src/planner/rules/join/equi-pair-extractor.ts, packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/test/optimizer/monotonic-merge-join.spec.ts, packages/quereus/test/logic/83-merge-join.sqllogic, docs/optimizer.md
---

## What was built

A new join-physical recognition rule, `ruleMonotonicMergeJoin`, that fires
whenever both join sides advertise `MonotonicOn` on the equi-pair attributes —
strictly broader than the ordering-based recognition in
`ruleJoinPhysicalSelection`. The rule reuses the existing `MergeJoinNode` and
its `emitMergeJoin` runtime emitter; no new node class or emitter was needed.

The change is purely additive. `ruleMonotonicMergeJoin` defers to
`ruleJoinPhysicalSelection` whenever both sides' physical ordering already
covers all equi-pairs in merge-ready order, so multi-key composite-PK joins
continue to flow through the existing rule with full unique-key propagation.

### Headline win
A three-way join `t1 JOIN t2 ON t1.id=t2.id JOIN t3 ON t2.id=t3.id` now
produces two MergeJoins. Previously the parent join could not recognise the
merge opportunity because the child MergeJoin's `physical.ordering` reflects
only the left side; recognition has to use `monotonicOn`, which already
covers both sides for inner/left joins (via `propagateJoinMonotonicOn`).

## Key files

### New
- `packages/quereus/src/planner/rules/join/equi-pair-extractor.ts` — shared
  helpers used by both join-physical rules: `extractEquiPairs`,
  `extractEquiPairsFromUsing`, `combineResidual`, `isOrderedOnEquiPairs`,
  `reorderEquiPairsForMerge`, `isMergeReadyOnAllPairs`. The `EquiPairExtraction`
  result also returns `equiPairNodes` (the original `=` BinaryOpNode for each
  pair) so rules can demote pairs back into the residual.
- `packages/quereus/src/planner/rules/join/rule-monotonic-merge-join.ts` — the
  new rule itself.
- `packages/quereus/test/optimizer/monotonic-merge-join.spec.ts` — 12 tests
  covering positive/negative/correctness/physical-properties cases.

### Changed
- `packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts` —
  refactored to use shared helpers (no behavior change).
- `packages/quereus/src/planner/optimizer.ts` — registers the new rule in
  PassId.PostOptimization at priority 4 (one ahead of
  `ruleJoinPhysicalSelection` at priority 5).
- `packages/quereus/test/logic/83-merge-join.sqllogic` — extra correctness +
  plan-shape cases for monotonic-merge recognition (three-way join,
  multi-conjunct ON, LEFT JOIN, SEMI/ANTI via EXISTS/NOT EXISTS).
- `docs/optimizer.md` — Join rules section now documents the new rule.

## Out of scope (parked)
- Composite monotonic-on prefixes (multi-key streaming merge keyed on `(X, Y)`
  when both sides are jointly monotonic on the prefix).
- Right and full outer joins (emitter doesn't support them).
- DESC-DESC streaming (would need a reversed `compareKeys` in the merge-join
  emit).
- USING with multiple monotonic-driving pairs (rule bails; existing
  ordering-based rule handles).

## Validation
- `yarn build`: clean.
- `yarn lint`: clean.
- `yarn test`: 2597 passing, 2 pending, 0 failing.
- Spot-checked the headline three-way case both as plan-shape (in
  `83-merge-join.sqllogic`) and as a Mocha test in
  `monotonic-merge-join.spec.ts`.
- Composite-PK regression case in `keys-propagation.spec.ts` ("Composite PK
  join preserves left keys when right PK covered") still passes — confirms
  the defer-to-ordering-rule gate preserves multi-key uniqueKey propagation.

## Usage
- Triggered automatically: any `JOIN`/`LEFT JOIN`/`SEMI`/`ANTI` where both
  inputs advertise `monotonicOn(asc, attrId)` on the equi-pair columns will
  pick MergeJoin without inserting Sort nodes.
- Disable for benchmarking via `optimizer.tuning.disabledRules` containing
  `'monotonic-merge-join'`.
