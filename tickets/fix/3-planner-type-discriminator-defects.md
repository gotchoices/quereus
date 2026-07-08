description: Two of the optimizer's "what kind of node is this?" checks are subtly broken — one can never match, another matches too eagerly — and two related detection features are dead code; fix the live bugs and remove the dead surface.
files: packages/quereus/src/planner/framework/characteristics.ts
difficulty: medium
----

## Problem

The planner detects node capabilities with duck-typed helper predicates. Two of them are defective:

- **`isColumnBindingProvider`** tests `typeof method === 'string'`. Methods are functions, so `typeof` yields `'function'` — the branch can never be true. It is a permanently dead test that silently reports "not a column-binding provider" for everything it checks.

- **`isAggregateFunction`** keys off *mere property presence*. Any node that later grows a same-named member (even an unrelated field) silently and wrongly acquires "is an aggregate" status. This is a latent correctness trap: a future field addition changes optimizer behavior with no visible link.

Both live in `framework/characteristics.ts:323-443`.

Additionally, two capability surfaces are dead:

- **`PredicateAnalysis`** — its TODO stub returns `true`, which is the *unsafe* default (claiming a predicate is safe/analyzable when it has not been analyzed). Even though nothing queries it today, a stub that defaults to the unsafe answer is a landmine if wired up later.
- **`CapabilityRegistry`** — nodes register into it, but nothing ever queries it. Pure dead weight.

## Expected behavior

- `isColumnBindingProvider` correctly identifies column-binding providers (test the method's existence as a function, or use whatever canonical discriminator the codebase settles on).
- `isAggregateFunction` identifies aggregates via a real, intentional marker (a discriminant field / `nodeType` / class check), not incidental property presence — so unrelated members cannot flip the result.
- No dead `PredicateAnalysis` stub that defaults to the unsafe direction; no unqueried `CapabilityRegistry`.

## Investigation / direction

- Reproduce the `isColumnBindingProvider` dead branch (a unit assertion that a known provider currently fails detection) before fixing, to confirm the diagnosis and to lock in a regression test.
- For `isAggregateFunction`, pick a real discriminator consistent with how aggregates are otherwise identified in the planner; confirm no consumer relied on the loose property-presence behavior.
- Confirm `PredicateAnalysis` and `CapabilityRegistry` are genuinely unqueried across `packages/quereus` (including tests) before removing; delete them and any now-orphaned wiring.

## Relationship

The broader "pick one canonical type-discrimination mechanism" redesign is tracked separately (`planner-type-discrimination-canonical`). This ticket fixes the concrete live defects and removes dead surface now, independent of that larger decision; where a fix needs a discriminator, prefer the mechanism that redesign is likely to standardize on and note the choice.

## Use case

A node that provides column bindings is correctly detected; adding an unrelated field named like an aggregate's member to some other node does not cause the optimizer to treat it as an aggregate.
