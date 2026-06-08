---
description: Side-effect audit safety net for the optimizer — registry guardrail, per-rule fixes, and FROM-position DML write-target propagation in ChangeScope.
prereq: query-expr-ast-parser-unification
files:
  - packages/quereus/src/planner/framework/characteristics.ts
  - packages/quereus/src/planner/framework/registry.ts
  - packages/quereus/src/planner/framework/pass.ts
  - packages/quereus/src/planner/framework/README.md
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/src/planner/analysis/change-scope.ts
  - packages/quereus/src/planner/rules/predicate/rule-empty-relation-folding.ts
  - packages/quereus/src/planner/rules/predicate/rule-filter-contradiction.ts
  - packages/quereus/src/planner/rules/predicate/rule-predicate-pushdown.ts
  - packages/quereus/src/planner/rules/predicate/rule-aggregate-predicate-pushdown.ts
  - packages/quereus/src/planner/rules/predicate/rule-predicate-inference-equivalence.ts
  - packages/quereus/src/planner/rules/subquery/rule-subquery-decorrelation.ts
  - packages/quereus/src/planner/rules/subquery/rule-anti-join-fk-empty.ts
  - packages/quereus/src/planner/rules/subquery/rule-semi-join-fk-trivial.ts
  - packages/quereus/src/planner/rules/join/rule-join-elimination.ts
  - packages/quereus/src/planner/rules/join/rule-join-greedy-commute.ts
  - packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts
  - packages/quereus/src/planner/rules/join/rule-quickpick-enumeration.ts
  - packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts
  - packages/quereus/src/planner/rules/join/rule-fanout-batched-outer.ts
  - packages/quereus/src/planner/rules/parallel/rule-async-gather-union-all.ts
  - packages/quereus/src/planner/rules/parallel/rule-async-gather-zip-by-key.ts
  - packages/quereus/src/planner/rules/parallel/rule-eager-prefetch-probe.ts
  - packages/quereus/src/planner/rules/retrieve/rule-projection-pruning.ts
  - packages/quereus/src/planner/rules/cache/rule-scalar-cse.ts
  - packages/quereus/test/optimizer/side-effect-audit.spec.ts
  - packages/quereus/test/optimizer/change-scope-analyzer.spec.ts
  - packages/quereus/test/optimizer/pass-manager.spec.ts
  - packages/quereus/test/planner/framework.spec.ts
  - docs/optimizer.md
  - docs/architecture.md
  - docs/change-scope.md
---

## Summary

Lands the side-effect awareness safety net for the optimizer:

1. **Registry guardrail.** `RuleHandle.sideEffectMode: 'safe' | 'aware'`
   is required at registration time (both `addRuleToPass` and
   `registerRule` paths). `validateSideEffectMode` rejects rules that
   fail to declare. Every existing rule in `optimizer.ts` is annotated
   inline with a short rationale.

2. **Per-rule guards.** Aware rules consult
   `PlanNodeCharacteristics.subtreeHasSideEffects(node)` (or
   `hasSideEffects` for local-only checks) and refuse to move,
   duplicate, drop, or merge subtrees that carry a write. Covers
   structural folds (empty-relation, filter-contradiction), pushdowns
   (predicate, aggregate predicate, inference), join rules (commute,
   physical selection, quickpick, fanout, elimination, anti/semi),
   parallel gathers, projection pruning, and scalar CSE.

3. **`ChangeScope` write-target propagation.** `collectTableRefs` now
   walks both `getChildren()` and `getRelations()` so DML write targets
   (`Insert.table` / `Update.table` / `Delete.table`, which sit outside
   `getChildren`) surface in the outer statement's `ChangeScope` when
   the DML is in FROM position. Cycle-safe via a `visited` set.

The audit is mostly inert today because DML still appears only at the
statement root or in FROM position — the safety net catches new shapes
once `dml-in-expression-position` (parallel ticket) lifts the
planning-time gate.

## Validation

- `yarn workspace @quereus/quereus run lint` — clean (exit 0).
- `yarn test` — **3659 passing in `@quereus/quereus`**, all other
  packages green, Done in 3m 9s.

## Review findings

### Process

Read the implement-stage diff (commit `14645410`) end-to-end before the
handoff summary: 33 files, +999/-164 lines. Verified every
`addRuleToPass` call has `sideEffectMode` (45/45). Cross-checked every
aware rule's guard against the rule's actual transform shape. Walked
the `ChangeScope` propagation path with a representative wrapped-DML
plan in my head, and the helper traversal against shared-subtree DAGs.

### Findings (categorized)

**Correctness — none material.** Per-rule guards are correctly placed
inside the gate predicate (not as separate returns), the `'aware'`
classifications match each rule's actual transform shape (move /
duplicate / drop / merge), and the cycle-safe `visited` set in
`collectTableRefs` correctly handles shared subtrees. `ruleJoinFoldEmpty`
correctly picks the *non-empty* (potentially impure) side as
`droppedSide` regardless of which side is empty.

**Documentation — one inconsistency, fixed inline.** The framework
README example for `createRule(...)` was out of sync after
`sideEffectMode` became a required positional parameter — the example
would have passed `10` (the intended `priority`) into the
`sideEffectMode` slot and tripped runtime validation. Fixed: added
explicit `'safe'` argument and an inline doc-anchor comment in
`packages/quereus/src/planner/framework/README.md`.

**Audit posture — one over-claim, comment corrected inline.** The
inline rationale at `optimizer.ts:802-805` claimed that
`ruleMaterializationAdvisory` is sound because "the underlying
`CachingAnalysis.isCacheable` already gates side-effect-bearing
subtrees." That helper does exist and does the right thing — but
`MaterializationAdvisory.adviseCaching` (the path the rule actually
takes) does NOT call `isCacheable`. It only checks `stats.deterministic`
(which is orthogonal to `readonly`). Soundness for impure subtrees
actually rests on **CacheNode being a run-once fence**, not on any
explicit gate. The annotation is still appropriate (`'aware'` — the
rule's transform is sound on side effects) but the comment was
inaccurate. Rewrote the comment to reflect the actual soundness
argument and to point future readers at where to add an explicit
refusal gate if `dml-in-expression-position` lands.

**DRY — minor.** `containsOperationsWithSideEffects` in
`rule-mutating-subquery-cache.ts:89-110` is a hand-rolled equivalent
of `PlanNodeCharacteristics.subtreeHasSideEffects` (with extra walk
through `getRelations()`). The local helper predates the audit
ticket's new helper. Could be replaced by the centralized helper,
either by adding a `walkRelations: true` option to the helper or
accepting the slight under-coverage (Insert's own `readonly=false`
catches it at the local level either way). **Not addressed** — out of
scope; flag as cleanup if anyone refactors that rule.

**Test coverage — covered for the audit; one gap acknowledged.** The
two negative-case fixtures pin the canonical refusal paths
(`Filter(InsertReturning, false)` and the cross-join-with-empty-side).
Registry-guardrail tests cover both the accept (`'safe'` / `'aware'`)
and reject (missing) paths. Helper-level fixtures cover the
"lying-wrapper" defensive case. The implementer's flagged gap — no
end-to-end `Database.watch`-fires-on-wrapped-DML test — was left for a
separate ticket; the change-scope test pins the scope correctness,
which is the load-bearing layer. **Not addressed** here; minor
follow-up.

**Performance — flagged, not addressed.** `subtreeHasSideEffects` is
O(plan-size) per call; aware rules call it on candidate subtrees. For
well-formed plans where `physical.readonly` propagates via
AND-of-children, the local-only `hasSideEffects` would suffice. The
deeper walk is intentional defensive belt against
`computePhysical`-override lies (and the test fixture verifies this
case). Acceptable.

**Lint / tests.** Both green at HEAD with the inline edits applied.

### Disposition

- **Minor findings (2): fixed inline.** README example;
  optimizer.ts inline comment for materialization advisory.
- **Major findings: none.** No new tickets filed.
- **Deferred (in implementer's known gaps): unchanged.** End-to-end
  `Database.watch` test on wrapped DML, per-rule audit hardening for
  `MaterializationAdvisory` / `ruleCteOptimization` (both `'aware'`
  but rest on CacheNode soundness rather than explicit gates), and
  predicate-AST-level side-effect handling (deferred to whatever
  ticket lands `dml-in-expression-position`).

## Out of scope (deferred — unchanged from implement stage)

- Runtime emitter changes for DML in expression position.
- Lifting the planning-time DML-in-expression-position gate.
- Parallel-track refusal (`query-expr-parallel-track-refusal`).
- Adding a separate `writes` field to `ChangeScope` (today, wrapped
  DML's write target appears in `watches` as a full read scope — sound
  over-report, sufficient for current consumers).
