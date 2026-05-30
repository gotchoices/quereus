description: Extend the coverage prover's IND-derived no-row-loss path (Wave 2) to two completeness cases it currently abstains on — a bushy (join-shaped) lookup side, and a join whose equi-pairs span two INDs. Both are safe under-claims today (a missed cover only forgoes an optimization), so this is a future optimization-completeness gain, not a correctness fix. Only becomes observable once a runtime consumer drives a join-bodied covering MV (Wave-3 lens enforcement).
prereq: lens-multi-source-decomposition
files: packages/quereus/src/planner/analysis/coverage-prover.ts, packages/quereus/test/covering-structure.spec.ts
----

## Background

Wave 2 (`coverage-prover-ind-derived-no-row-loss`, now complete) made the
inner/cross join no-row-loss obligation IND-derived: `indDerivedNoRowLoss` reads
the propagated `PhysicalProperties.inds` on the `T`-side subtree and admits when a
non-`nullRejecting` IND's `(cols → targetCols)` pairing set-equals the join's
equi-pairs against the lookup parent's key. This newly proves no-row-loss for
left-deep multi-hop FK chains (`T → M → P`).

Two completeness limitations remain. **Both are safe under-claims** — a missed
cover only forgoes an optimization; the prover never returns a false `Covers`.
Neither is reachable as a defect today, because a join-bodied covering MV's link
is informational until the Wave-3 lens runtime-enforcement layer consumes it.

## Limitation 1 — bushy lookup side

`indDerivedNoRowLoss` requires the lookup side to resolve to a single full-scan
base table via `resolveFullScanTableRef`. For the left-deep shape `(T⋈M)⋈P` the
topmost lookup side is `P` (a table) ✓. If the optimizer ever produces a **bushy**
`T⋈(M⋈P)`, the lookup side is a join, `resolveFullScanTableRef` returns
`undefined`, and the two-hop cover is silently lost (falls back to structural ⇒
`NotCovers`). The empty-table PoC stays left-deep empirically
(`rule-quickpick-enumeration` is cost-gated and inert; `rule-fanout-lookup-join`
needs module latency), but a cost-based reorder on real statistics could go bushy.

Expected behavior: prove no-row-loss when the bushy lookup side itself carries a
matching IND surface / threaded inclusion, **or** normalize the join shape to
left-deep before proving. Either path must preserve the over-claim-free guarantee.

## Limitation 2 — single-IND match

`indDerivedNoRowLoss` matches *one* IND on `tSide` to *all* of the join's
equi-pairs. A join whose equi-pairs are jointly covered by **two** INDs (no single
IND covers them) abstains. Expected behavior: admit when a *set* of INDs jointly
set-covers the equi-pairs, provided every contributing IND is non-`nullRejecting`
and targets the same lookup parent key.

## Acceptance

- Bushy `T⋈(M⋈P)` over NOT-NULL FK→PK hops proves no-row-loss (covers), with a
  regression test that constructs (or forces) the bushy plan shape.
- A two-IND-spanning equi-join proves no-row-loss when jointly covered.
- The equivalence-with-structural guarantee on the single-FK corpus is preserved
  (no verdict or reason churn on existing shapes).
- Soundness floor unchanged: still no false `Covers`; under-claim remains the only
  failure mode.
