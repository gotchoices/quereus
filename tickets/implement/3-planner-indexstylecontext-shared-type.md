description: Two optimizer rules pass data to each other through a shared structure that each one describes with its own, slightly-different type definition, forcing unsafe type casts; consolidate to a single shared, correctly-typed definition.
files: packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts, packages/quereus/src/planner/rules/access/rule-select-access-path.ts
difficulty: medium
----

## Problem

Two rules coordinate by stashing a context object on an untyped `moduleCtx` channel. The shape of that object — `IndexStyleContext` — is declared **twice**, once in each rule, and the two declarations have **drifted**:

- `rules/retrieve/rule-grow-retrieve.ts:49` declares `residualPredicate?: PlanNode`
- `rules/access/rule-select-access-path.ts:1000` declares `residualPredicate?: ScalarPlanNode`

Because the producer and consumer disagree on the type, the consumer is forced into `as unknown as` casts to bridge them. That cast defeats the type checker exactly at the cross-rule boundary where a mismatch would be most damaging, and nothing stops the two copies from drifting further.

## Expected behavior

One `IndexStyleContext` type, declared in a single shared module, imported by both rules. No `as unknown as` casts across the boundary. A residual predicate is a *scalar* boolean expression, so the field should be typed `ScalarPlanNode` (the narrower, correct type) — verify the producer only ever puts a scalar predicate there.

## Direction

- Reconcile the divergent field type to `ScalarPlanNode` unless investigation shows the producer legitimately stores a non-scalar `PlanNode` — if so, surface that as a real design question rather than papering it with a cast.
- Since the object rides an untyped `moduleCtx`, add a small type guard so the consumer validates the shape at retrieval rather than blind-casting.

## TODO

- Create a shared module (e.g. under `rules/` or a `rules/shared/`-style location consistent with the codebase) exporting the single `IndexStyleContext` type and a type guard for it.
- Reconcile `residualPredicate` to `ScalarPlanNode` (confirm the producer in `rule-grow-retrieve.ts` only writes a scalar predicate; adjust if not).
- Update `rule-grow-retrieve.ts:49` and `rule-select-access-path.ts:1000` to import the shared type; delete both local declarations.
- Replace the `as unknown as` casts with the type guard at the `moduleCtx` retrieval site.
- Run `yarn workspace @quereus/quereus run lint` and `yarn test`.
