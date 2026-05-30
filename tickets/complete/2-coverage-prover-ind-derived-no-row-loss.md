description: Wave 2 of the IND rollout — the coverage prover's inner/cross no-row-loss obligation is now IND-derived (consults propagated `PhysicalProperties.inds` first via `indDerivedNoRowLoss`) with the structural `lookupCoveringFK` check retained as fallback. Pure strengthening: identical verdicts on every existing FK→PK shape (parametric equivalence test), plus it newly proves no-row-loss for multi-hop FK chains (`T → M → P`). Reviewed and complete.
files: packages/quereus/src/planner/analysis/coverage-prover.ts, packages/quereus/test/covering-structure.spec.ts, docs/optimizer.md, docs/materialized-views.md
----

## What landed

`innerJoinRetainsConstrainedTable` (`planner/analysis/coverage-prover.ts`)
discharges the obligation-(2) no-row-loss inclusion two ways, in order:

1. **IND-derived** (`indDerivedNoRowLoss`, tried first) — reads the propagated
   `PhysicalProperties.inds` on the `T`-side subtree; admits when a
   non-`nullRejecting` IND's `(cols → targetCols)` pairing **set-equals** the
   join's `(tSide-output-col → lookup-base-col)` equi-pairs and `target.kind:
   'table'` matches the lookup parent's `(schema, table)`.
2. **Structural fallback** (`lookupCoveringFK` + `!match.nullable`) — retained
   verbatim; runs only when the IND path abstains.

Both gate up front on the shared preconditions (equi-only join via
`pureJoinEquiAttrPairs`; full parent row set via `resolveFullScanTableRef`).
`ProveCoverageOptions { structuralOnly? }` is a verification seam (default off,
never set by production callers) that disables the IND path so the equivalence
test can compare the two derivations directly. Module doc + `docs/optimizer.md` +
`docs/materialized-views.md` updated to state obligation (2) is IND-derived with
structural fallback. `closeInds` was evaluated and deliberately NOT added
(propagation alone carries the reaching IND for the left-deep chain).

## Review findings

Adversarial pass over the implement diff (commit `2b62447f`). Verdict: **sound,
shippable.** One minor test gap fixed inline; one completeness limitation filed
as a follow-up backlog ticket. No major defects.

### What was checked

- **Soundness of the IND path (the load-bearing claim).** Re-derived it from
  scratch: a non-`nullRejecting` table-target IND `tSide.cols ⊆ parent.targetCols`
  guarantees, for every `tSide` row, a parent row `p` with `p.targetCols =
  tSide.cols`; when the join's equi-pairs *are* that pairing, `p` satisfies every
  equi-condition ⇒ the row is retained. The shared full-row-set precondition
  (checked before either derivation) ensures `p` is actually scanned. **No-row-loss
  does not even require `targetCols` to be a key** — that is the *separate*
  no-fan-out obligation, handled by `proveJoinNoFanout` at the join frame. Confirmed
  the two obligations stay independent. Sound.
- **Attribute-id / column-index frame alignment in `indDerivedNoRowLoss`.** IND
  `cols` are `tSide`-output indices (propagated/shifted into that frame); the
  function maps equi-pair attr-ids through `tSide.getAttributes()`. Lookup side
  resolves through `resolveFullScanTableRef` (only id-preserving pass-throughs:
  SeqScan/IndexScan/Alias/Sort/Retrieve), so the lookup base-col indices line up
  with the IND `targetCols` (target-relation indices). Frames are consistent.
- **The `kind:'table'` ⇒ `targetCols` is a parent key invariant.** `indDerivedNoRowLoss`
  does not locally verify `targetCols` is a unique key — it relies on the seeding
  invariant (`seedTableForeignKeyInds` only mints PK-targeted table INDs; the
  propagation helpers `shiftInds`/`projectInds`/`mergeInds` never rewrite `target`).
  Verified that invariant holds across all current IND producers. Sound today;
  documented as an invariant dependency.
- **Equivalence with the structural path on the single-FK corpus.** The IND set on
  a bare `T`-side is exactly `seedTableForeignKeyInds(T)`, which mirrors
  `lookupCoveringFK`'s PK-cover + nullability validation (shared `fkChildNullable`
  bit). Set-equality in `indPairsMatchJoinPairs` mirrors `lookupCoveringFK`'s
  positional "exactly the FK columns paired to the whole PK" requirement. The
  parametric `both paths agree` suite `deepEqual`s IND-on against `structuralOnly`
  and against the pre-Wave-2 golden — a structural equivalence guarantee, not a
  frozen snapshot. Confirmed.
- **`indPairsMatchJoinPairs` set-vs-subset edge.** The check is "equal length +
  every joinPair ∈ indSet + indSet distinct"; it does not separately assert
  `joinPairs` is duplicate-free. Analyzed the only way a duplicate `joinPair` could
  arise (a redundant `t.x = p.a AND t.x = p.a` ON) — in that degenerate case the
  IND is a *stronger* existence guarantee than the (weaker, duplicated) join
  condition, so no-row-loss still holds. Sound regardless; not worth a guard.
- **Production callers do not use the seam.** `linkCoveredUniqueConstraints`
  (`runtime/emit/materialized-view-helpers.ts`) calls the 4-arg
  `proveCoverage(root, mv, uc, table)`. `structuralOnly` is reachable only from the
  test. Judged the seam acceptable in the production signature: optional, documented,
  zero production effect, and the structural-equivalence guarantee it buys is worth
  more than the extra export surface a test-only factoring would cost.
- **Permutation handling (the inline fix — see below).**
- **Docs.** Read all three touched docs against the code: module doc,
  `docs/optimizer.md` (§ IND Tracking, § Coverage proving), `docs/materialized-views.md`
  (§ Covering structures). All accurately describe the IND-first / structural-fallback
  reality, the two-hop composition, and the `closeInds`-unnecessary decision.
- **Build / lint / full suite.** `yarn workspace @quereus/quereus run build` clean;
  `yarn lint` clean; full `@quereus/quereus` suite **4014 passing, 9 pending, 0
  failing** (4013 prior + the 1 new test below). No `.pre-existing-error.md`.

### Found & fixed inline (minor)

- **Untested permutation edge.** `lookupCoveringFK` is heavily documented to reject
  a permuted composite-FK ON (`c.pa = p.b AND c.pb = p.a` against FK `(pa,pb)→(a,b)`),
  but the Wave-2 suite never confirmed the new IND set-equality path rejects the same
  shape. Added a `permuted composite FK ⇒ shape` case to the parametric
  `equivalence with structural-only` suite, so both derivations are asserted to
  reject it identically (`{covers:false, reason:'shape'}`). Verified: the IND set
  `{pa:a, pb:b}` ≠ the join's `{pa:b, pb:a}` ⇒ abstains; structural rejects via
  positional alignment. Passes.

### Filed as follow-up (major — backlog)

- **`coverage-prover-ind-two-hop-completeness`** (backlog) — two completeness
  limitations of the IND path, both **safe under-claims** (a missed cover only
  forgoes an optimization; never a false `Covers`) and neither reachable as a
  defect today (join-bodied MV covering is informational until Wave-3 runtime
  enforcement):
  1. *Bushy lookup side.* The two-hop proof needs the lookup side to resolve to a
     single full-scan table (`resolveFullScanTableRef`). A bushy `T⋈(M⋈P)` makes the
     lookup side a join ⇒ `undefined` ⇒ the two-hop cover is silently lost. The PoC
     stays left-deep empirically, but a cost-based reorder on real statistics could
     go bushy.
  2. *Single-IND match only.* `indDerivedNoRowLoss` matches *one* IND to all the
     join's equi-pairs; a join whose equi-pairs span *two* INDs abstains.

### Empty categories (explicit)

- **No soundness defects.** The IND path can only under-claim relative to the
  structural path on the single-FK corpus (equivalence-tested) and only *adds*
  proofs (multi-hop) elsewhere; a false `Covers` would require a false propagated
  IND, which the Wave-1 over-claim-free propagation guarantee precludes.
- **No resource-cleanup / async / error-handling concerns** — pure synchronous
  analysis over an already-built plan tree; no I/O, no allocation lifecycle, no
  thrown-exception paths added.
- **No golden-plan churn** — INDs never reach `serializePlanTree` (per Wave-1
  review); the `optimizer/**` + `plan/**` goldens are untouched, confirmed by the
  green full suite.

## Out of scope (unchanged from implement)

- Lens existence-anchor injection (`kind:'relation'` INDs) — Wave 3,
  `lens-multi-source-decomposition`.
- Runtime enforcement of a join-bodied covering MV (lands with the lens tickets);
  the two-hop cover is informational this release.
- Aggregate / set-op IND propagation (Wave-1 left undefined).
