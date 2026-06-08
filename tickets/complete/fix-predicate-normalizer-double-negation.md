description: Fix: NOT-wrapped WHERE predicates were silently dropped during planning. FilterNode.getPredicates() now returns a normalized form so the constraint extractor sees canonical comparisons instead of UnaryOp(NOT, ...).
files:
  packages/quereus/src/planner/nodes/filter.ts (the fix — getPredicates now wraps with normalizePredicate)
  packages/quereus/src/planner/nodes/join-node.ts (pre-existing pattern this fix mirrors)
  packages/quereus/src/planner/analysis/predicate-normalizer.ts (the normalizer; unchanged)
  packages/quereus/src/planner/analysis/constraint-extractor.ts (walkPlanForPredicates — sole consumer)
  packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts (trySortAbsorbViaIndexOrdering — affected path)
  packages/quereus/test/optimizer/predicate-normalizer.spec.ts (regression coverage)
----

## What was built

Bug fix in `FilterNode.getPredicates()` (the `PredicateSourceCapable` plural
accessor used by analysis-time plan walks). It now returns
`[normalizePredicate(this.predicate)]` rather than the raw predicate, mirroring
the pattern already used by `JoinNode.getPredicates()`.

The single-predicate `getPredicate()` accessor (used by rewriters that mutate
the tree) intentionally still returns the raw predicate — only the analysis-
facing plural form is normalized.

## Why

`extractConstraintsForTable`'s plan walk (`walkPlanForPredicates` in
`constraint-extractor.ts`) is the only consumer of the `PredicateSourceCapable`
characteristic. With raw predicates, any `NOT NOT P`, `NOT (a > 10)`, etc. was
seen as a `UnaryOp(NOT, ...)` node which the constraint extractor cannot turn
into a column constraint, so it was routed to "residual." For
ORDER BY queries that triggered `trySortAbsorbViaIndexOrdering`, the walk
returned zero constraints, the rule produced an `index-style` `moduleCtx` with
`residualPredicate = undefined`, and `ruleSelectAccessPath`'s index-style
branch only re-attaches a Filter when `residualPredicate` is truthy. Net
effect: the WHERE clause was silently dropped between planner and physical
leaf.

## Verification

`yarn workspace @quereus/quereus test` — 2526 passing, 0 failing, 2 pending.

The five regression tests in `test/optimizer/predicate-normalizer.spec.ts`
that were failing before the fix now pass:

- `double negation: NOT NOT (a > 10) equals a > 10`
- `NOT (a > lit)` → inverted to `a <= lit`
- `NOT (a >= lit)` → inverted to `a < lit`
- `NOT (a < lit)` → inverted to `a >= lit`
- `NOT (a <= lit)` → inverted to `a > lit`

Three-valued-logic semantics are preserved: `NOT (a IS NULL)` still excludes
NULL rows correctly because the runtime NOT preserves NULL regardless of how
the planner extracts constraints.

## Reviewer notes (resolved)

- ✅ The diff matches `JoinNode.getPredicates()` — same `normalizePredicate(...)`
  wrapper.
- ✅ Sole call site of `getPredicates()` in production code is the analysis-
  layer plan walk (`constraint-extractor.ts:1108`); rewriters use the singular
  `getPredicate()` (unchanged).
- ✅ `bloom-join-node` and `merge-join-node` also implement the characteristic
  but expose `residualCondition` (already-extracted, post-analysis); they are
  not subject to the same bug surface and were intentionally left alone.
- ✅ Performance: `normalizePredicate` returns by reference when no rewrite is
  needed; cost is bounded by predicate AST size.

## Use cases / regression surface

Any WHERE clause containing `NOT (...)` around a comparison or
boolean-combined comparisons, especially in combination with an ORDER BY (or
any other shape that pulls `extractConstraintsForTable` into the path), now
filters correctly. De Morgan rewrites (`NOT (P AND Q)`, `NOT (P OR Q)`) are
exercised by the same suite.
