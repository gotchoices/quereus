----
description: Eliminate the two structural debts in the view-mutation backward path the architecture review flagged as foundational. (A) Extract the triplicated scope-aware column-substitution logic (single-source.ts / multi-source.ts / lens-enforcement.ts) into one shared utility. (B) Thread the backward walk on the plan node so the multi-source/decomposition substrate consumes each operator's landed `updateLineage`/`attributeDefaults` directly, retiring the lossy plan→AST→re-plan round-trip that currently forces identity-only column mappings. Both ride the same plan-node backward surface, so they land together. The round-trip law harness is the acceptance gate.
prereq: view-roundtrip-laws-multi-source
files: packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/mutation/decomposition.ts, packages/quereus/src/planner/mutation/lens-enforcement.ts, packages/quereus/src/planner/mutation/propagate.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/nodes/view-mutation-node.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/src/planner/analysis/scalar-invertibility.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/test/property.spec.ts, docs/view-updateability.md
effort: xhigh
----

## Why this exists

The architecture review identified exactly two non-enhancement debts in the otherwise-strong
VU/MV/lens foundation — both in the backward (write) path, both worth fixing **now** rather
than revisiting:

1. **Triplicated scope-aware column substitution (DRY).** The "rewrite column references
   X→Y in an expression / query, scope-aware (shadowing, taint, deep subquery descent)"
   primitive exists in three near-parallel copies:
   - `single-source.ts` — `transformExpr` (exported, line ~117), the scope-aware
     `transformQueryExpr` / `makeViewColumnDescend` / `qualifyCorrelatedBaseRefs` (view-col →
     base-term, deep correlation-qualified).
   - `multi-source.ts` — `substituteViewColumns` / `stripSideQualifier` (view-col → alias-
     qualified base term, with cross-source rejection); imports some of single-source's helpers
     but re-implements the scoped variants.
   - `lens-enforcement.ts` — its own logical→basis column rewriting for synthesized
     check/FK/count-subquery expressions.
   These share a shadowing/taint model and differ only in the substitution map and the
   qualification rule. ~150–200 lines of parallel tree-walking — the most likely place for a
   future change to be applied to two of three sites.

2. **The lossy plan→AST→re-plan round-trip (the architectural tension).** `multi-source.ts`
   plans the body, reads `root.physical.updateLineage` to classify columns, then **lowers its
   decisions back to AST `BaseOp`s and re-plans** through the base builders. This double-plans
   and, worse, **discards the richer lineage** — it accepts only identity column mappings even
   where `scalar-invertibility.ts` proves an invertible transform (`x + k`), because the AST
   `BaseOp` cannot carry the threaded lineage. The decided north-star (`docs/view-updateability.md`
   § "Round-Trip Laws and the Derived Backward Walk", and the `view-mutation-plan-node-substrate`
   sequencing) is for the substrate to **walk the plan node's backward methods directly** — the
   *derived dual* of each operator's forward FD walk — instead of round-tripping through AST.

The annotation layer this depends on **has already landed**: `updateLineage` /
`attributeDefaults` on `PhysicalProperties` (`plan-node.ts:343/350`, `update-lineage.ts`),
threaded as `computePhysical` overrides on TableReference / Project / Filter / Join and passed
through the access / Retrieve / Alias boundary nodes; plus `viewComplement` (`view-complement.ts`).
So this is a **consumption** ticket, not new-annotation work — the design is decided in the docs;
this builds the consumer.

## Scope and sequencing

Do **not** build the Voigtländer auto-deriver (mechanical `put`-from-`get`). That remains the
deferred enhancement. This ticket hand-writes/relocates each backward method **as a derived dual
of the landed forward annotation**, so the eventual auto-deriver is a refactor behind the same
law — never an unwind. Hold the load-bearing invariant the docs name: *no operator may introduce
a backward rule that auto-derivation could not later reproduce.*

The prereq (`view-roundtrip-laws-multi-source`) is the **acceptance gate**: Phase B is not "done"
for a path until PutGet / GetPut / lineage-agreement stay green over that path after the
round-trip is removed. Behavioral parity with the retired AST path is the bar.

This is large. The two phases are separable; do Phase A first (it stands alone and de-risks B by
giving B one substitution primitive to thread). If Phase B proves too large for one pass, the
implement-stage rules permit decomposing it into same-stage `prereq:`-chained tickets (e.g. per
operator: Project, then Filter, then Join, then the decomposition fan-out) — keep each gated by
the law harness.

### Phase A — one scope-aware substitution utility
- Introduce a single shared module (suggest `planner/mutation/scope-transform.ts`) exposing a
  scope-aware substitution that takes a `ScopeContext` value object — `{ substitution map,
  qualifier rule, shadowed-name set, taint policy }` — replacing the 6–8 positional-param
  threading currently in `single-source.ts`. It must cover the deep subquery-descent +
  shadowing + `unsupported-subquery-correlation` taint logic that single-source already gets
  right (this is the hard part — preserve its behavior exactly, including the known self-
  reference corner documented in `view-updateability.md` § Selection).
- Re-express `single-source.ts`, `multi-source.ts`, and `lens-enforcement.ts` column rewriting in
  terms of it. The three callers differ only by their `ScopeContext`.
- No behavior change in Phase A — the round-trip law harness (single-source Tier A + the new B/C
  families) and the existing `93.x-view-mutation*.sqllogic` / `lens-enforcement.spec.ts` suites
  must stay green. Phase A is a pure refactor proven by unchanged tests.

### Phase B — plan-node backward walk; retire the AST round-trip
- Make the multi-source substrate consume `updateLineage` / `attributeDefaults` / `viewComplement`
  off the planned operator tree directly to bind each output column to its owning base and
  reconstruct the per-side identifying predicate, instead of lowering to AST `BaseOp`s and
  re-planning. Reuse the Phase-A substitution utility for any residual term rewriting.
- This unlocks **invertible (non-identity) column mappings** on the multi-source path
  (`scalar-invertibility.ts` already classifies them; the AST round-trip is what dropped them) —
  add coverage for at least one `inverse`-profile column written through a join body.
- Keep the `ViewMutationNode` substrate and its reuse of the base-table builders for the actual
  base writes — the goal is to stop *re-deriving via AST*, not to stop reusing the base writers.
  Where the substrate still needs a base statement, build it from the threaded lineage, not from
  a re-plan of a lowered AST.
- Apply the same plan-node consumption to the decomposition fan-out where it currently leans on
  AST-level analysis, so single-source / multi-source / decomposition share one backward-walk
  consumer rather than three.

## Acceptance criteria
- `yarn workspace @quereus/quereus test` green, including the full `View Round-Trip Laws` block
  (Tier A + B + C from the prereq) and the existing view-mutation / lens-enforcement suites.
- `yarn workspace @quereus/quereus run lint` clean.
- The scope-aware substitution logic lives in **one** module; `single-source.ts`,
  `multi-source.ts`, and `lens-enforcement.ts` no longer each carry their own copy (grep for the
  retired helpers returns nothing).
- The multi-source path no longer lowers-to-AST-and-re-plans to make backward decisions
  (the double-plan is gone); a join body with an `inverse`-profile column is now writable and
  covered by a round-trip law assertion.
- Behavioral parity: every previously-passing view-mutation test still passes; any newly-enabled
  shape (invertible-mapping join write) is additive.
- `docs/view-updateability.md` updated: the § Implementation Surface "Forward note" and the
  "Surface authority" callout reflect that the substrate now consumes the plan-node backward
  walk (and note which physical operators — HashJoin/MergeJoin/aggregate/set-op — still degrade
  lineage and therefore remain rejected, so the doc stays honest about the boundary).

## TODO
- [ ] Phase A: design the `ScopeContext` shape covering all three callers' substitution + qualification + shadowing/taint needs.
- [ ] Phase A: extract `scope-transform.ts`; re-express single-source, multi-source, lens-enforcement against it; prove zero behavior change via the existing + prereq test suites.
- [ ] Phase B: implement the plan-node backward-walk consumer reading `updateLineage`/`attributeDefaults`/`viewComplement`; bind owning base + identifying predicate from the threaded lineage.
- [ ] Phase B: route multi-source `update`/`delete`/`insert` through the consumer, retiring the lower-to-AST-and-re-plan path; keep `ViewMutationNode` + base-builder reuse for the writes.
- [ ] Phase B: enable + test an `inverse`-profile (non-identity) column written through a join body.
- [ ] Phase B: converge the decomposition fan-out onto the same consumer where it leans on AST analysis.
- [ ] Run full `yarn test` + lint; update `docs/view-updateability.md`. If Phase B is split, chain same-stage tickets per operator under this slug's prereq.
