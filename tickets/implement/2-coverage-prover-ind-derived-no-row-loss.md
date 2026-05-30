description: Wave 2 of the IND property rollout — make the coverage prover's no-row-loss (≥1) obligation a *derivation* over the propagated `PhysicalProperties.inds` surface, with the existing structural `lookupCoveringFK` check retained as a fallback. Pure strengthening: identical `Covers`/`NotCovers` on every existing FK→PK shape (both paths must agree), and it newly proves no-row-loss for multi-hop FK chains (`T → M → P`) that the single-call `lookupCoveringFK` cannot reason about. Design source: the `optimizer-inclusion-dependency-property` design spike, Wave 2 (full design carried inline below).
prereq: optimizer-inclusion-dependency-foundation
files: packages/quereus/src/planner/analysis/coverage-prover.ts, packages/quereus/src/planner/util/ind-utils.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/util/fd-utils.ts, docs/optimizer.md, docs/materialized-views.md
----

## Goal

The coverage prover's 1:1 join decomposition splits "exactly one MV row per
governed `T` row" into two obligations (see the `coverage-prover.ts` module doc):
**no fan-out (≤1)** — already FD-derived via the join-frame `isUnique(T.pk)` gate
— and **no row loss (≥1)** — today a per-call structural plan-walk. Its own doc
names the seam: *"FDs encode uniqueness, not existence, so obligation (1) cannot
be FD-derived; obligation (2) reads the FK schema + the lookup-side plan shape
directly."*

Wave 1 (`optimizer-inclusion-dependency-foundation`) shipped a propagated
existence fact (`PhysicalProperties.inds`). This wave consumes it: the inner-join
no-row-loss proof tries the propagated IND **first**, then **falls back** to the
existing structural `innerJoinRetainsConstrainedTable` check. Behavior on every
existing FK shape is unchanged (both must agree — enforced by a test), and the
IND path additionally proves no-row-loss across multi-hop FK chains where the
single-call `lookupCoveringFK` abstains.

## Where it plugs in

`innerJoinRetainsConstrainedTable(join, tSide, lookupSide, baseTable)` in
`coverage-prover.ts` (the obligation-(2) proof for `inner`/`cross` joins). Today
it: extracts pure equi-pairs (`pureJoinEquiAttrPairs`), requires the lookup side
to expose the parent's full row set (`resolveFullScanTableRef`), and confirms a
NOT-NULL covering FK→PK (`lookupCoveringFK`, `!match.nullable`).

Add an IND-derived path tried *before* that structural check:

- Read the propagated INDs at the **join frame** (the `tSide` subtree's
  `physical.inds`, mapped to `T`'s base columns via the same stable-attr-id →
  base-column-index mapping the structural path already builds with
  `findConstrainedTableRef`).
- Admit no-row-loss when there exists an IND on `T` with:
  - `nullRejecting === false` (a NULL-rejecting / nullable-FK IND can drop `T`
    rows — the same reason the structural path requires `!match.nullable`),
  - `cols ⊇` the join's `T`-side equi-columns (the IND witnesses that exactly the
    columns `T` joins on are included in the target), and
  - `target` = the lookup parent (`kind:'table'` matching `lookupSide`'s base
    table + schema, `targetCols` = the lookup-side equi-columns / parent key), and
    the lookup side still exposes the parent's **full** row set
    (`resolveFullScanTableRef` — unchanged; a filtered/seeked parent re-introduces
    row loss regardless of the IND).
- Otherwise fall through to the existing structural check (unchanged).

Both paths gate on the *same* preconditions (equi-only join, full parent row set,
non-null inclusion to the parent's key) so they cannot disagree on the existing
single-FK corpus. The IND path's win is **composition**: a `T → M → P` chain
surfaces a propagated transitive/threaded IND on `T` reaching `P` (carried through
the intermediate join by Wave-1 propagation) that no single `lookupCoveringFK`
call can see.

> Implementation note — multi-hop derivation. Whether the threaded IND reaching
> `P` is already present at the join frame from Wave-1 propagation, or needs a
> bounded transitive *closure* over the IND set (compose `T.cols ⊆ M.key` with
> `M.cols ⊆ P.key` ⇒ `T ⊆ P` when the connecting columns align), is the one open
> implementation choice. Prefer the cheapest that proves the two-hop PoC case: a
> small bounded `closeInds`-style composition in `fd-utils.ts` (capped, drop-when-
> unsure — same conservative bar) if propagation alone does not already carry the
> reaching IND. Do NOT build an unbounded fixpoint; cap hops like the FD closure
> caps work.

## Soundness

A false `Covers` is unsound (once enforcement routes through the structure it
silently misses conflicts), so the IND path inherits the prover's existing
conservative bar — and the Wave-1 over-claim-free guarantee on the propagated set
is exactly what licenses trusting an IND to discharge the no-row-loss obligation.
The structural fallback means a *missing* IND never regresses an existing
optimization. Keep the RI-trust assumption identical to the structural path
(declared FKs are hard inclusion dependencies; full parent row set required).

## Key tests

Extend the coverage-prover specs (`test/optimizer/` — see
`coverage-prover-inner-join-fk-preservation` corpus in `complete/`) and
`docs/materialized-views.md` § Covering structures:

- **Equivalence (the heart).** On the existing NOT-NULL FK→PK inner-join MV-body
  corpus (lookup parent = full scan), the IND-derived path and the structural path
  return **identical** `Covers`/`NotCovers`. Drive this by asserting the prover
  result is unchanged from the pre-Wave-2 golden for every existing case; a
  parametric "both paths agree" assertion (run with IND path on vs structural-only)
  is ideal if cheap to wire.
- **Two-hop strengthening.** A `T → M → P` chain (both hops NOT-NULL FK→PK, all
  full-scan lookups) proves no-row-loss via the composed/threaded IND where a
  single `lookupCoveringFK` call abstains ⇒ the MV body now `Covers` where it
  previously returned `NotCovers('shape')`.
- **Negative guards (must still `NotCovers`).** nullable-FK / `nullRejecting`
  IND ⇒ no admit; filtered or seeked lookup side ⇒ no admit (full-row-set gate);
  IND whose `cols` do not cover the join's `T`-side equi-columns ⇒ no admit.

## Out of scope

- Lens existence-anchor injection (`kind:'relation'` INDs) — Wave 3,
  `lens-multi-source-decomposition`.
- Any runtime enforcement consumer — lands with the lens tickets, not here.
- Aggregate / set-op IND propagation (Wave-1 left them undefined).

## TODO

- Add the IND-derived no-row-loss path to `innerJoinRetainsConstrainedTable`, tried before the structural `lookupCoveringFK` check; structural fallback retained verbatim.
- Map join-frame `T`-side `physical.inds` to `T` base columns via the existing attr-id → base-column mapping; admit on (non-`nullRejecting`, `cols ⊇` T equi-cols, target = full-scan lookup parent key).
- If propagation alone does not carry the reaching IND for `T → M → P`, add a bounded `closeInds` composition to `fd-utils.ts` (capped, conservative); otherwise rely on propagation and document that.
- Equivalence test: identical prover verdicts vs structural-only on the existing FK→PK corpus (golden-stable).
- Two-hop test: `T → M → P` now `Covers`; negative guards still `NotCovers`.
- Update `coverage-prover.ts` module doc + `docs/optimizer.md` § Inclusion Dependency Tracking + `docs/materialized-views.md` to state obligation (1) is now IND-derived with structural fallback.
- `yarn workspace @quereus/quereus run build`, run optimizer + coverage-prover specs (stream with `Tee-Object`), lint.
