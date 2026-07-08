description: Two optimizer rules that hand data to each other now share one type definition instead of two drifted copies, removing the unsafe casts at their boundary.
files: packages/quereus/src/planner/rules/shared/index-style-context.ts, packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts, packages/quereus/src/planner/rules/access/rule-select-access-path.ts
difficulty: medium
----

## What was done

`ruleGrowRetrieve` (producer) and `ruleSelectAccessPath` (consumer) coordinate by stashing an `IndexStyleContext` object on the untyped `RetrieveNode.moduleCtx` channel. That type was declared twice — once per rule — and the copies had drifted (`residualPredicate?: PlanNode` vs `?: ScalarPlanNode`), forcing `as unknown as` casts at the boundary.

Consolidated to a single shared definition in new file `packages/quereus/src/planner/rules/shared/index-style-context.ts` exporting the `IndexStyleContext` interface + `isIndexStyleContext` guard. `residualPredicate` reconciled to the narrower correct `ScalarPlanNode`; `originalConstraints` typed `PredicateConstraint[]` (the same symbol the consumer imports aliased as `PlannerPredicateConstraint`). Both rules import the shared type; both local declarations and five casts deleted. Consolidation now enforced by tsc — if the two rules ever disagree again, the compiler fails.

## Review findings

Adversarial pass over the implement diff (commit `ad911c56`), fresh eyes before reading the handoff.

**Checked — correctness of the type reconciliation:**
- `residualPredicate: ScalarPlanNode` — verified the producer only ever writes a scalar. Both write-sites (`fallbackIndexSupports` L436, `trySortAbsorbViaIndexOrdering` L584) declare their local `residualPredicate` as `ScalarPlanNode | undefined`, sourced from `ConstraintExtractionResult.residualPredicate` (already `ScalarPlanNode | undefined`) or a `BinaryOpNode` accumulator. No non-scalar path. Narrowing is correct, not a papered cast.
- `originalConstraints: PredicateConstraint[]` — the shared type and the consumer's `PlannerPredicateConstraint` alias resolve to the **same symbol** from `constraint-extractor.js`. The removed `as unknown as PlannerPredicateConstraint[]` / `as PlannerPredicateConstraint[]` casts were pure noise (identical types both sides); removal is safe, confirmed by tsc.
- Removed `|| []` guard on the consumer's `originalConstraints` read — safe: the field is non-optional in the shared type and both producer sites always assign an array. Sole-writer invariant holds.

**Checked — completeness / drift protection:**
- Both producer write-sites carry the `: IndexStyleContext` annotation, so both are drift-checked by tsc (not just the one shown moving in the diff).
- No orphaned imports after cast removal — every type import (`PlannerPredicateConstraint`, `BestAccessPlanResult`, `ScalarPlanNode`, `PlanNode`, `PredicateConstraint`) still has live uses in both files. Lint (which type-checks test files too) passes, confirming no signature drift at spec call sites.
- `SupportAssessment.ctx` is `unknown`; `assessment.ctx` is re-narrowed through `isIndexStyleContext` at the consumer — no `any` leak introduced.

**Checked — docs:** No maintained doc references the old local type. Only `docs/review.html` (auto-generated review artifact that *originated* this ticket) mentions `IndexStyleContext`; not a source doc to update. No doc drift.

**Tripwire (recorded by implementer, concurred):** `isIndexStyleContext` validates only the `kind === 'index-style'` discriminant, trusting payload fields — parked as a `NOTE:` at the guard site in `index-style-context.ts`. Sound while `ruleGrowRetrieve` is the sole writer; add field checks only if a second producer of a `{ kind: 'index-style' }` object appears. Not a ticket — genuinely conditional.

**Out of scope, intentionally left:** unrelated structural casts off the cross-rule boundary (`... as unknown as RelationalPlanNode` in both files) remain. Not the `moduleCtx` boundary this ticket targeted.

**Minor findings:** none. **Major findings (new tickets):** none — nothing to spawn.

## Validation (re-run in review)

- `yarn tsc --noEmit -p tsconfig.json` → EXIT 0
- `yarn workspace @quereus/quereus run lint` → EXIT 0 (eslint + tsc over spec files)
- `yarn workspace @quereus/quereus run test` → **6472 passing, 9 pending, 0 failing**

No new tests added: change removes casts without altering runtime logic; correctness is now guaranteed structurally by tsc. Existing suite exercises the index-style residual/sort-absorb/correlated-subquery paths and stays green.
