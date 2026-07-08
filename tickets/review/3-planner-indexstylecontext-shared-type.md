description: Two optimizer rules that hand data to each other now share one type definition instead of two drifted copies, removing the unsafe casts at their boundary.
files: packages/quereus/src/planner/rules/shared/index-style-context.ts, packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts, packages/quereus/src/planner/rules/access/rule-select-access-path.ts
difficulty: medium
----

## What was done

`ruleGrowRetrieve` (producer) and `ruleSelectAccessPath` (consumer) coordinate by stashing an `IndexStyleContext` object on the untyped `RetrieveNode.moduleCtx` channel. That type was declared **twice** — once per rule — and the copies had drifted (`residualPredicate?: PlanNode` vs `?: ScalarPlanNode`), forcing `as unknown as` casts at the retrieval site.

Consolidated to a single shared definition:

- **New file** `packages/quereus/src/planner/rules/shared/index-style-context.ts` exports the one `IndexStyleContext` interface + `isIndexStyleContext` type guard.
- `residualPredicate` reconciled to the narrower correct type **`ScalarPlanNode`** (a residual is always a scalar boolean predicate — see verification below).
- `originalConstraints` typed `PredicateConstraint[]` (constraint-extractor's type). Note this is the *same* symbol the consumer already imports as `PlannerPredicateConstraint`, so no cross-type bridge is needed.
- Both rules import the shared type; both local declarations deleted.
- Casts removed: `as unknown as PlannerPredicateConstraint[]` and `as PlannerPredicateConstraint[]` in `rule-select-access-path.ts`; three `as ScalarPlanNode` casts in `rule-grow-retrieve.ts`. The type guard now narrows `moduleCtx` from `unknown` at both retrieval sites with no blind cast.

### Producer-writes-scalar verification (the ticket's open question)

Confirmed the producer only ever writes a `ScalarPlanNode` residual, so `ScalarPlanNode` is correct (not a papered-over cast):

- `fallbackIndexSupports`: `residualPredicate` is assigned from `extraction.residualPredicate`, whose declared type in `ConstraintExtractionResult` (constraint-extractor.ts) is already `ScalarPlanNode | undefined`, and otherwise from a `BinaryOpNode` accumulator (a `ScalarPlanNode`).
- `trySortAbsorbViaIndexOrdering` (the second producer site): its local `residualPredicate` was already declared `ScalarPlanNode | undefined`. This inline context object is now annotated `: IndexStyleContext` so it too is drift-checked against the shared shape.

## How to validate

- **Build/type**: `cd packages/quereus && yarn tsc --noEmit -p tsconfig.json` → clean. The consolidation is enforced *by the compiler* — if the two rules ever disagree again, tsc fails, which is the whole point of the change.
- **Lint** (`yarn workspace @quereus/quereus run lint`) → EXIT=0 (eslint + `tsc -p tsconfig.test.json` over spec files).
- **Tests** (`yarn workspace @quereus/quereus run test`) → 6472 passing, 9 pending, 0 failing.

### Behavioral coverage (this is a type-only refactor — no runtime behavior should change)

The `moduleCtx` index-style channel is exercised by index-style vtab modules (those implementing `getBestAccessPlan`) where a WHERE predicate is partially pushed into the access plan and a residual filter is kept above the physical leaf. Relevant paths a reviewer should confirm still behave identically:

- Filter constraints partially handled by the module → residual re-applied as a `FilterNode` above the `IndexSeek`/`IndexScan` (`test/optimizer/`, `test/logic/`).
- Sort absorbed into a Retrieve via index ordering (`trySortAbsorbViaIndexOrdering`).
- Correlated-subquery residual deliberately kept above the grown Retrieve (`predicateContainsCorrelatedSubquery`).

## Known gaps / reviewer attention

- **Guard is discriminant-only.** `isIndexStyleContext` checks `kind === 'index-style'` and trusts the payload fields — it does not deep-validate `accessPlan`/`originalConstraints`/`residualPredicate`. This preserves the exact behavior of both prior guards and is sound because `ruleGrowRetrieve` is the sole writer of this channel. Parked as a tripwire `NOTE:` at the guard site in `index-style-context.ts` (add field checks only if a second producer appears).
- **Out of scope, intentionally left:** unrelated structural casts not on the cross-rule boundary remain — `... as unknown as RelationalPlanNode` in both files (FilterNode/SeqScan → RelationalPlanNode). These are not the `moduleCtx` boundary the ticket targeted; touching them is a separate concern.
- No new tests were added: the change removes casts without altering runtime logic, and correctness is now guaranteed structurally by tsc. If the reviewer wants a regression floor beyond the existing suite, a focused optimizer test asserting an index-style residual filter is preserved end-to-end would be the place to add one.

## Review findings

- Tripwire recorded: `isIndexStyleContext` validates only the `kind` discriminant, not payload shape — `NOTE:` comment at the guard in `packages/quereus/src/planner/rules/shared/index-style-context.ts`. Fine while grow-retrieve is the only writer.
