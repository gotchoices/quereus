description: Review Wave 2 of the IND rollout — the coverage prover's inner/cross no-row-loss obligation is now IND-derived (consults propagated `PhysicalProperties.inds` first) with the structural `lookupCoveringFK` check retained as fallback. Pure strengthening: identical verdicts on every existing FK→PK shape (enforced by a parametric equivalence test), plus it newly proves no-row-loss for multi-hop FK chains (`T → M → P`). Build + full suite green (4013 passing, 9 pre-existing pending), lint clean.
prereq:
files: packages/quereus/src/planner/analysis/coverage-prover.ts, packages/quereus/test/covering-structure.spec.ts, docs/optimizer.md, docs/materialized-views.md
----

## What landed

`innerJoinRetainsConstrainedTable` (`planner/analysis/coverage-prover.ts`, the
obligation-(2) proof for `inner`/`cross` join bodies) now discharges the
no-row-loss inclusion obligation **two ways**, tried in order:

1. **IND-derived** (`indDerivedNoRowLoss`, new, tried first) — reads the
   propagated `PhysicalProperties.inds` on the **`T`-side subtree** and admits
   when a non-`nullRejecting` IND's `(cols → targetCols)` positional pairing
   **set-equals** the join's `(tSide-output-col → lookup-base-col)` equi-pairs,
   with `target.kind:'table'` matching the lookup parent's `(schema, table)`.
2. **Structural fallback** (`lookupCoveringFK` + `!match.nullable`) — retained
   **verbatim**; runs only when the IND path abstains.

Both gate up front on the **shared preconditions** that were already there:
equi-only join (`pureJoinEquiAttrPairs`) and full parent row set
(`resolveFullScanTableRef` on the lookup side) — hoisted above the two paths so
they cannot diverge on them.

Supporting helpers added: `indDerivedNoRowLoss`, `indPairsMatchJoinPairs`. A
`ProveCoverageOptions { structuralOnly? }` arg was added to `proveCoverage`
(optional, default off) as a **verification seam** that disables the IND path so
the equivalence test can compare the two derivations directly; production callers
never set it.

Module doc (`coverage-prover.ts`) + `docs/optimizer.md` (§ Inclusion Dependency
Tracking, § Coverage proving) + `docs/materialized-views.md` (§ Covering
structures) updated to state obligation (2) is IND-derived with structural
fallback.

**`closeInds` was evaluated and NOT added.** Propagation alone carries the
reaching IND for the left-deep two-hop PoC (empirically confirmed — see the
"propagation suffices" note below), so a transitive IND closure is unnecessary.
This is documented in `optimizer.md`.

## Why it is sound / equivalent (the load-bearing claims to re-check)

- **Equivalence with structural on the single-FK corpus.** The IND set on a bare
  `T`-side is exactly `seedTableForeignKeyInds(T)` — one total/NOT-NULL IND per
  declared FK→parent-PK, with the *same* PK-cover + nullability validation
  `lookupCoveringFK` applies (`fkChildNullable` is the shared bit). The
  set-equality match in `indPairsMatchJoinPairs` mirrors `lookupCoveringFK`'s
  "equi-pairs are exactly the FK columns paired to the whole parent PK", so the
  two paths admit identical single-FK shapes. **Verify**: the parametric "both
  paths agree" test asserts `deepEqual` between IND-on and `structuralOnly` on 5
  shapes (single FK, composite FK, nullable FK, non-FK unique key, same-side
  equality filter).
- **Two-hop soundness.** A non-null IND `tSide.cols ⊆ parent.targetCols`
  guarantees, for every `tSide` row, a parent row `p` with `p.targetCols =
  tSide.cols`; when the join equi-pairs *are* that pairing, `p` satisfies every
  equi-condition ⇒ the row is retained. The full-row-set precondition (shared,
  checked first) ensures `p` is actually scanned.
- **Set-equality is intentionally stricter than the ticket's literal "cols ⊇
  equi-columns" wording** — I chose set-equality to *guarantee* exact agreement
  with the structural path (the ticket's primary "both paths agree" constraint).
  A superset rule would admit a partial-composite-equi shape the structural path
  rejects; that case is independently caught by the fan-out gate, but with a
  different *reason*, which would break golden-stability. Set-equality keeps the
  full `proveCoverage` verdict (covers + reason) identical. **This is the one
  deliberate deviation from the ticket prose — please sanity-check the call.**

## Key tests (the floor — extend adversarially)

All in `test/covering-structure.spec.ts`, new `describe` block "coverage prover —
IND-derived no-row-loss (Wave 2)" (covering-structure spec: 66 → 75 passing):

- **Equivalence (the heart).** Parametric `both paths agree: …` over 5 existing
  FK→PK shapes — asserts IND-on `deepEqual` the pre-Wave-2 golden **and**
  `deepEqual` the `structuralOnly` verdict.
- **Two-hop strengthening.** `cc → mm → pp` (both hops NOT-NULL FK→PK): IND-on
  `covers:true`, `structuralOnly` `NotCovers('shape')` — the exact pre→post flip.
- **Negative guards (still NotCovers).** nullable mid→parent FK ⇒ `nullRejecting`
  threaded IND ⇒ `shape`; outer join on a non-FK mm column ⇒ IND pairing
  mismatch ⇒ `shape`; row-reduced (seeked) lookup ⇒ `shape`/`predicate-entailment`.

## Honest gaps / things for the reviewer to probe

- **Two-hop is shape-dependent (left-deep only).** The IND path needs the lookup
  side to resolve to a single full-scan table (`resolveFullScanTableRef`). For the
  left-deep `(T⋈M)⋈P`, the topmost lookup side is `P` (a table) ✓. If the
  optimizer ever produced a **bushy** `T⋈(M⋈P)`, the lookup side would be a join,
  `resolveFullScanTableRef` returns `undefined`, and the two-hop cover is silently
  lost (falls back to structural ⇒ `NotCovers`). Verified empirically that the
  optimizer keeps left-deep for the empty-table PoC (`rule-quickpick-enumeration`
  is cost-gated and does not fire; `rule-fanout-lookup-join` is inert without
  module latency). But a cost-based reorder on real statistics *could* go bushy.
  Under-claim ⇒ safe (coverage is an optimization), but it is a genuine
  completeness limitation worth a reviewer's eye — and a candidate follow-up
  (handle a join-shaped lookup side, or normalize to left-deep before proving).
- **Propagation suffices, but it is a single-IND match.** `indDerivedNoRowLoss`
  looks for *one* IND on `tSide` matching all the join's equi-pairs. A join whose
  equi-pairs span *two* INDs (no single IND covers them) would abstain. Not needed
  for the PoC; flagging the assumption.
- **`structuralOnly` is a test seam in a production signature.** Optional, default
  off, never set by production callers (`linkCoveredUniqueConstraints` /
  create-MV path call the 4-arg form). The reviewer may want to judge whether the
  seam belongs in production vs. a test-only export. It buys a *structural*
  equivalence guarantee (not a frozen golden), which I judged worth it.
- **Win is analysis-only this release.** Like the Wave-1 inner-join FK
  preservation, a join-bodied MV's covering link is **informational** — row-time
  maintenance still rejects multi-source bodies, so the two-hop cover cannot drive
  a real ABORT yet. No runtime consumer lands here (Wave 3).
- **Filtered/seeked-lookup negative lands on `predicate-entailment`, not
  `shape`.** In practice a row-reducing lookup filter references a lookup column,
  which predicate alignment rejects first; the full-row-set gate (shared, checked
  before the IND path) is still the structural backstop. The test accepts either
  reason — confirm that is acceptable, or construct a `shape`-only case if you want
  the gate isolated.
- **Schema/table name match is `toLowerCase`d** in `indDerivedNoRowLoss` (the
  seeded IND target stores raw `parent.schemaName`/`name`); consistent with the
  rest of the prover's name comparisons. Worth a glance for a cross-schema FK.

## Validation run

- `yarn workspace @quereus/quereus run build` — clean (exit 0).
- `covering-structure.spec.ts` + `optimizer/inclusion-dependencies.spec.ts` — 105 passing.
- `optimizer/**` + `plan/**` (golden plans) — 1234 passing, no golden churn (INDs
  never reach `serializePlanTree`, per Wave-1 review).
- Full `@quereus/quereus` suite — **4013 passing, 9 pending, 0 failing** (the 9
  pending are pre-existing; this ticket adds 9 tests). Lint clean. No
  `.pre-existing-error.md`.

## Out of scope (do not file here)

- Lens existence-anchor injection (`kind:'relation'` INDs) — Wave 3,
  `lens-multi-source-decomposition`.
- Runtime enforcement of a join-bodied covering MV (lands with the lens tickets).
- Aggregate / set-op IND propagation (Wave-1 left them undefined).
