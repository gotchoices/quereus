description: Design-spike — promote inclusion dependencies (INDs) from on-demand FK helpers to a first-class PROPAGATED member of the `PhysicalProperties` dependency family (alongside `fds` / `equivClasses` / `constantBindings` / `domainConstraints`), seeded from declared FKs and threaded through joins/projections, so the coverage prover's no-row-loss obligation becomes a derivation and lens n-way decomposition `put`/`get` gains a sound existence foundation for surrogate-shared (non-FK) joins. DECISION: the surface is designed to support a runtime ENFORCEMENT consumer (the lens layer's set-level/existence enforcement) from the start, via an obligation-vs-discharge split — authoritative declared/injected INDs are the enforcement OBLIGATIONS; the propagated/inferred surface only DISCHARGES them, so propagation's conservative over-claim-free bar keeps both optimization and enforcement sound. Recommends ONE additive path + a bounded proof-of-concept and names the implement follow-ons it unblocks.
prereq:
files: packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/planner/util/ind-utils.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/nodes/join-node.ts, packages/quereus/src/planner/nodes/project-node.ts, packages/quereus/src/planner/analysis/coverage-prover.ts, docs/optimizer.md
----

## Problem

Foreign keys are inclusion dependencies (`child.fk ⊆ parent.pk`). Quereus already
EXPLOITS this — `complete/1-optimizer-ind-existence-reasoning` shipped
`planner/util/ind-utils.ts` (`lookupCoveringFK`, `isRowPreservingPathToTable`) and
three Structural-pass rules (anti-join-to-empty, semi-join-trivial, FK-covered
aggregate elimination), and the coverage prover's inner-join FK admit path
(`innerJoinRetainsConstrainedTable`) consumes the same helpers. But INDs live ONLY
as on-demand, FK-declaration-bound helpers consulted ad hoc against the bottom
table schema. They are **not** a propagated property: existence is never threaded
through joins/projections the way uniqueness is via `fds`.

Two consequences:

- The coverage prover's **no-row-loss (≥1) obligation** is a per-call structural
  plan-walk. Its own module doc states the seam precisely: *"FDs encode
  uniqueness, not existence, so obligation (1) cannot be FD-derived; obligation (2)
  reads the FK schema + the lookup-side plan shape directly."* A propagated
  existence fact would let that obligation be DERIVED, and would extend to
  multi-hop FK chains (`T → M → P`) that the single-call `lookupCoveringFK` cannot
  reason about.
- **Lens n-way decomposition `put`** (`lens-multi-source-decomposition`) has no
  existence fact to lean on. Its mandatory (`not null`) components must be
  inner-joined and the put fan-out must reach every member, but the basis relations
  join on a substrate-managed **surrogate**, not a declared SQL FK — so
  `lookupCoveringFK` is structurally blind to them. There is no threaded fact saying
  "every anchor row exists in component relation `C`."

## Decided direction (recommend ONE path)

Add a **minimal, additive `InclusionDependency` member to the `PhysicalProperties`
dependency family**, seeded from declared FKs at `TableReferenceNode` AND injectable
by the lens compiler for surrogate-shared decompositions, threaded through
joins/projections with conservative drops — mirroring the proven
`fds` / `constantBindings` / `domainConstraints` foundation pattern
(`complete/1-fd-property-foundation` / `5-collapse-uniquekeys-into-fds`).

`ind-utils.ts` and the three IND rules stay **untouched**: they need the FK
*declaration* (nullability for the anti/semi/inner split, positional composite
pairing) that a coarse `child ⊆ parent` fact does not carry. The new property is a
*parallel derivation surface*, not a migration of the existing helpers — the
coverage prover will consult the propagated fact first and **fall back to the
existing structural `lookupCoveringFK` check**, so behavior on every existing FK
shape is unchanged (both must agree).

Rejected alternatives:

- **Helpers-only (status quo).** Fails the lens-decomposition need: surrogate joins
  carry no declared FK, so `lookupCoveringFK` can never see the existence guarantee.
- **Deep Z-set / bag-existence rewrite.** Disproportionate. The lens and prover needs
  are satisfied by a single propagated fact; a relational-existence-tracking
  subsystem is not warranted here. (The Z-set question for *maintenance* is a
  separate spike — `incremental-maintenance-substrate-spike` — and is orthogonal to
  this existence-reasoning surface.)

## The abstraction

New types in `plan-node.ts`, beside `FunctionalDependency`:

```typescript
export interface InclusionDependency {
  // Output-column indices on THIS relation whose tuple is guaranteed to exist in `target`.
  readonly cols: readonly number[];
  readonly target: IndTarget;
  // true: a NULL in any of `cols` excludes that row from the guarantee (MATCH SIMPLE / nullable FK).
  // false: total — every row's `cols` tuple is present in the target.
  readonly nullRejecting: boolean;
}

export type IndTarget =
  // child.cols ⊆ table.targetCols, where targetCols is a key of that table. The FK-seeded form.
  | { readonly kind: 'table'; readonly schema: string; readonly table: string; readonly targetCols: readonly number[] }
  // For lens-decomposition anchors: a basis relation addressed by a stable symbolic id the lens compiler mints.
  | { readonly kind: 'relation'; readonly relationId: string; readonly targetCols: readonly number[] };
```

`PhysicalProperties` gains `inds?: ReadonlyArray<InclusionDependency>`.

An IND is strictly weaker than, and orthogonal to, an FD: it asserts *existence* of
a tuple in another relation, not *determination* within this one. The two
`IndTarget` kinds separate the FK-seeded case (table-addressed, what the prover
reasons over) from the lens-anchor case (decomposition existence-anchor, what the
lens compiler injects).

## Enforcement readiness (obligation vs discharge)

This release designs the surface so a runtime **enforcement** consumer (the lens layer's
set-level / existence enforcement — `3-lens-prover-and-constraint-attachment`,
`lens-multi-source-decomposition`) can ride it soundly, rather than scoping enforcement
out. The model is an **obligation-vs-discharge split**:

- **Obligations are authoritative, never inferred.** What *must* be enforced comes only
  from declared/injected INDs: an FK-seeded `kind:'table'` IND, or a lens-compiler-injected
  `kind:'relation'` IND for a mandatory decomposition component. These are complete by
  construction (the FK schema / lens spec is the source of truth), so an enforcement
  consumer enumerating obligations from them can never *miss* a required check.
- **The propagated/inferred surface only DISCHARGES obligations.** A threaded IND may
  *prove an obligation already holds* (basis structure guarantees the inclusion ⇒ no
  runtime check needed); it may never be the basis for concluding an obligation does not
  exist. So a **missing** inferred IND merely fails to discharge ⇒ the runtime check runs
  (safe); an **over-claimed** inferred IND would wrongly discharge ⇒ skip a needed check ⇒
  unsound — exactly the over-claim the conservative propagation bar (§Soundness boundary)
  already forbids.

The consequence: **admitting enforcement does NOT raise the propagation bar** (still
over-claim-unsound, under-claim-free) — *because enforcement reads obligations from the
authoritative declaration, not from the propagated set*. The rejected alternative — treat
the propagated set itself as the obligation source — is unsound: it would demand
completeness of a propagated fact (generally unachievable), turning every under-claim into
a skipped check. The enforcement-consumer *implementation* still lands with the lens
tickets (not the foundation wave); this spike only fixes the surface so it is
enforcement-ready.

## Per-operator / per-property surface

New helpers in `fd-utils.ts`, named to match the family (`projectInds` / `shiftInds`
/ `mergeInds` / `addInd`) with a `MAX_INDS_PER_NODE` cap mirroring `MAX_FDS_PER_NODE`:

- **`TableReferenceNode.computePhysical`** — seed one IND per declared FK whose
  referenced columns form a key of the parent: `cols` = the FK child columns' output
  indices, `target` = `{table, parent, parentKeyCols}`, `nullRejecting` = (any FK
  child column nullable). This reuses `resolveReferencedColumns` and the *same*
  nullability computation `lookupCoveringFK` already performs — factor that bit into
  a shared helper so the seeded property and the rule helper cannot diverge.
- **`ProjectNode` / `ReturningNode`** — `projectInds(inds, mapping)`: drop an IND
  when any of its `cols` loses its mapping (the relation no longer carries the
  witnessing columns); remap survivors to output indices. Note the asymmetry vs
  `projectFds`: an IND's `cols` is all-or-nothing — there is no partial-dependent
  survival.
- **Join (`JoinNode` / `BloomJoinNode` / `MergeJoinNode`)** — `inner`/`cross`: union
  of `shiftInds(left)` and `shiftInds(right, leftColumnCount)`. Outer (`left`/`right`):
  the preserved side's INDs survive (NULL-padding can only hit the *other* side,
  never the preserved side's `cols`); the null-padded side's INDs are DROPPED. `semi`/
  `anti`: keep left's INDs only. `full`: drop both. This branch table is the IND
  analogue of `analyzeJoinKeyCoverage` / `propagateJoinFds` and MUST stay consistent
  with them.
- **`Filter` / `Alias` / `Sort` / `Distinct` / physical scans** — inherit unchanged:
  row-removal preserves a per-row inclusion claim. **`Aggregate` / `SetOperation` /
  `Window`** — drop conservatively (they reshape relational identity).

## Additive migration path (three waves, mirroring the FD rollout)

- **Wave 1 — foundation (the PoC, implement follow-on
  `optimizer-inclusion-dependency-foundation`).** The property + FK seeding +
  join/project propagation + a property-law test harness. NO consumer migration.
  Nothing user-visible changes.
- **Wave 2 — prover consumption (implement follow-on
  `coverage-prover-ind-derived-no-row-loss`, prereq: the foundation).**
  `innerJoinRetainsConstrainedTable` first tries the propagated IND at the join frame
  (a `T`-projection IND with `cols ⊇` the FK to the lookup, `nullRejecting = false`,
  target = the lookup parent exposing its full row set), then falls back to the
  existing structural check. Pure strengthening; identical results on existing FK
  shapes; extends to multi-hop chains.
- **Wave 3 — lens consumption (`lens-multi-source-decomposition` gains this spike as
  a prereq).** The lens compiler injects an IND per mandatory component onto the
  decomposition's existence anchor (the `kind: 'relation'` target), so the prover
  validates the n-way put/get without re-deriving structure per decomposition.

## Proof-of-concept scope (concrete, bounded)

Seed FK INDs at `TableReferenceNode`; propagate through inner + left/right joins and
projections; consume in the coverage prover's no-row-loss path with the structural
fallback retained. Demonstrate:

- on one residual NOT-NULL FK→PK inner-join MV body (lookup parent = full scan) that
  the IND-derived path and the structural path return identical `Covers`;
- on a two-hop FK chain `T → M → P` that the IND path proves no-row-loss where the
  single-call `lookupCoveringFK` abstains.

Explicitly OUT of the PoC: lens injection (Wave 3), aggregate/set-op IND propagation,
and the runtime enforcement-consumer *implementation* (the obligation-vs-discharge
*surface* is part of this spike's design output per §Enforcement readiness, but no runtime
check is wired in the PoC).

## Soundness boundary

A false IND (over-claim) is **unsound** — it would assert a row exists that does not,
which silently mis-proves coverage and (for an enforcement consumer) wrongly discharges an
obligation, skipping a needed check. A missing IND (under-claim) only forgoes an
optimization or a discharge (the runtime check then runs — safe). Every propagation rule
is therefore conservative: drop when unsure. Critically, this single bar suffices **even
with enforcement in scope, because enforcement obligations come from the authoritative
declaration, never from the propagated set** (§Enforcement readiness) — so admitting an
enforcement consumer does not raise the propagation bar to completeness. This matches the
coverage prover's existing "a false `Covers` is unsound ⇒ be conservative" bar, and the
RI-trust assumption is identical to the one `ind-utils.ts` and inner-join elimination
already make (declared FKs treated as hard inclusion dependencies; `pragma foreign_keys`
defaults on).

## Key tests (later phases)

- **Property/law harness** (Tier-1 style, the regression net
  `unified-key-inference-surface` established): for every relational node in an
  optimized plan, materialize it and assert the propagated INDs never OVER-claim — for
  each IND, every materialized row's `cols` projection (excluding NULL-rejected rows)
  actually appears in the target relation's `targetCols` projection. The load-bearing
  safety check, the IND analogue of the `keysOf`/`isUnique` soundness harness.
- Unit tests on `projectInds`/`shiftInds`/`mergeInds` (drop-on-lost-column, shift
  correctness, `nullRejecting` preservation, cap behavior).
- Seeding: a composite NOT-NULL FK seeds one *total* IND; a nullable FK seeds a
  `nullRejecting` IND.
- Join propagation: inner union; LEFT preserved-side IND survives, null-padded-side IND
  dropped; full drops both; semi keeps left.
- Equivalence (the PoC's heart): the coverage prover returns identical
  `Covers`/`NotCovers` on the existing FK→PK inner-join corpus with the IND path enabled
  vs structural-only.
- Two-hop strengthening: `T → M → P` proves no-row-loss via composed INDs where
  `lookupCoveringFK` abstains.

## Follow-on tickets this spike unblocks

- `optimizer-inclusion-dependency-foundation` (implement, Wave 1).
- `coverage-prover-ind-derived-no-row-loss` (implement, Wave 2; prereq: the
  foundation).
- `lens-multi-source-decomposition` (existing plan ticket) gains a prereq on this
  spike for its Wave-3 existence-anchor put soundness (now an explicit edge).

## Out of scope

- The runtime enforcement-consumer *implementation* (installing/running existence checks)
  — that lands with the lens tickets (`3-lens-prover-and-constraint-attachment`,
  `lens-multi-source-decomposition`), not the foundation wave. This spike makes the surface
  enforcement-**ready** (the obligation-vs-discharge split, §Enforcement readiness); it
  does not itself wire a runtime check.
- The maintenance-direction Z-set question (`incremental-maintenance-substrate-spike`)
  — orthogonal.
