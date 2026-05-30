description: Wave 3 of the inclusion-dependency (IND) rollout — the lens compiler injects one `InclusionDependency` (`IndTarget.kind:'relation'`) per mandatory decomposition member onto the decomposition's existence anchor, so the optimizer/lens prover can prove every logical row exists in each mandatory basis relation (making the mandatory inner-joins row-loss-free and the put fan-out sound) against a threaded existence fact rather than re-deriving structure per decomposition. The `kind:'relation'` `IndTarget` variant was reserved by `optimizer-inclusion-dependency-foundation` for exactly this injection; `lookupCoveringFK` is structurally blind to the surrogate join (no declared SQL FK), which is why the propagated IND surface is the mechanism. Design source: `docs/lens.md` § "Existence soundness rides the propagated IND surface".
prereq: optimizer-inclusion-dependency-foundation, lens-multi-source-get-synthesis
files: packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/planner/util/ind-utils.ts, packages/quereus/src/planner/nodes/table-access-nodes.ts, packages/quereus/src/planner/nodes/reference.ts, docs/lens.md, docs/optimizer.md
----

## Scope

`optimizer-inclusion-dependency-foundation` (Wave 1) made `InclusionDependency` a
first-class propagated member of `PhysicalProperties` and reserved the
`IndTarget.kind:'relation'` variant *without a producer* — explicitly for this
lens injection (its § "The abstraction" note: "`kind:'relation'` is reserved for
the Wave-3 lens existence-anchor injection").

This ticket is that Wave-3 producer. For a decomposition synthesized by
`lens-multi-source-get-synthesis`, every **mandatory** member is inner-joined onto
the existence anchor. That inner join is row-loss-free, and the put fan-out is
sound, **only if** every logical row provably exists in each mandatory member's
basis relation. Because members are stitched on a substrate-managed **surrogate**
(or a logical tuple) — *not* a declared SQL foreign key — `ind-utils.ts`
`lookupCoveringFK` cannot see the relationship. So the lens compiler injects the
existence fact directly as a propagated IND targeting the anchor by its stable
`relationId` (= `advertisement.id` = `StorageShape.anchorRelationId`, the contract
the resolver already validates). The prover (`3-lens-prover-and-attachment`)
consumes it to discharge the no-row-loss / put-soundness obligation against a
threaded fact instead of re-deriving decomposition structure.

This ticket does **not** build the join (that is the get-synthesis sibling) and
does **not** build the put fan-out (the put sibling consumes the fact this ticket
produces). It produces and threads the existence fact, and ensures it survives to
the prover.

## Current state (verified, do not re-discover)

- `packages/quereus/src/planner/nodes/plan-node.ts` — after Wave 1:
  `InclusionDependency { cols, target, nullRejecting }`, `IndTarget` with the
  `{ kind:'relation'; relationId; targetCols }` variant, and
  `PhysicalProperties.inds?`. Propagation through join/project/filter/etc. exists;
  pass-through nodes carry `inds` verbatim.
- `packages/quereus/src/planner/util/fd-utils.ts` — `projectInds`/`shiftInds`/
  `mergeInds`/`addInd` + `MAX_INDS_PER_NODE`; structural dedup compares
  `cols`/`nullRejecting`/`target` (incl. `relationId`+`targetCols` for the relation
  variant).
- `packages/quereus/src/planner/util/ind-utils.ts` — `lookupCoveringFK` /
  `isRowPreservingPathToTable` (FK-declaration-bound; **untouched** by Wave 1 and
  by this ticket — they need the FK nullability/positional pairing a coarse
  `child ⊆ anchor` fact does not carry; the injected IND is a *parallel*
  derivation surface, not a migration).
- `packages/quereus/src/schema/lens-compiler.ts` — after the get-synthesis sibling,
  `compileDecompositionBody` produces the join body from `slot.advertisement`. The
  injection hooks here: the compiler knows the anchor `relationId`, the mandatory
  members, and the per-member key columns (`SharedKey.keyColumnsByRelation`).
- The lens body inlines into the plan as a registered `ViewSchema`; its base
  members are scanned via `TableReferenceNode` / physical scan nodes
  (`reference.ts`, `table-access-nodes.ts`). The injected IND must attach to the
  member-scan's `PhysicalProperties.inds` (or be threaded so it reaches the prover
  over the join), with `target.kind:'relation'`, `relationId` = the anchor.

## Design

### What gets injected

Per **mandatory** member `m` (excluding the anchor itself), inject one IND
asserting `m`'s key tuple is included in the anchor's key:

- `cols` = the output-column indices of `m`'s key columns *on the member scan's
  output relation* (the witnessing columns — `SharedKey.keyColumnsByRelation.get(m.relationId)`
  mapped to scan output indices).
- `target` = `{ kind:'relation', relationId: anchorRelationId, targetCols: <anchor key col indices> }`.
- `nullRejecting` = `false` — a mandatory member's existence is **total** (every
  logical row has it). (Optional members get **no** IND — their absence is exactly
  what the outer join preserves; injecting one would over-claim, which is unsound.)

The singleton / empty-key case injects **no** IND (the key column list is empty;
there is no witnessing tuple — existence is the anchor's own 0-or-1-row property,
nothing to thread).

### Where it attaches (the threading mechanism)

The fact must reach the prover, which reasons over the planned (inlined) lens body.
Two viable seams — **decide during implement by tracing how the prover reads
`PhysicalProperties` over the inlined view body** (the get-synthesis sibling and
`3-lens-prover-and-attachment` both touch this path; budget for the trace before
coding):

1. **Seed at the member scan** (preferred if reachable): when planning a basis
   member that participates as a mandatory member of a decomposition, seed the
   member's `TableReferenceNode`/scan `computePhysical` with the relation-IND, the
   same shape as Wave 1's FK seeding in `reference.ts` — except sourced from the
   lens slot's advertisement rather than a declared FK. This requires the planner
   to know, at scan time, that the relation is a decomposition member (carry the
   advertisement membership on the basis `TableSchema`, or look it up from the
   logical schema's lens slots keyed by basis relation). The existing IND
   join-propagation then carries it up through the synthesized join to the body
   output for free.

2. **Attach on the lens slot, consumed by the prover directly**: store the injected
   INDs on `LensSlot` (a new `injectedInds?: ReadonlyArray<InclusionDependency>`
   field) and have the prover read them alongside the body's propagated `inds`. This
   avoids threading membership to scan time but means the fact is not visible to the
   general optimizer (only the prover) — acceptable since the prover is the sole
   intended consumer named in the design.

Prefer (1) if the membership lookup is clean (it makes the fact a real propagated
property, usable by future optimizer consumers); fall back to (2) if seeding at
scan time would require invasive `TableSchema`/planner coupling. Document the
choice in `docs/optimizer.md` (the Wave-3 entry of the IND section) and
`docs/lens.md`.

### Soundness boundary (inherited from Wave 1)

A false IND (**over-claim**) is unsound. Inject **only** for `presence:'mandatory'`
members and **only** `nullRejecting:false` totals. Never inject for optional
members or the empty key. The injected fact's authority is the **advertisement
declaration** (the module's contract that a mandatory member backs every logical
row) — the same authoritative-declaration basis Wave 1's § "Enforcement readiness"
established for letting a declaration, not the propagated set, drive an obligation.
If the declaration is wrong (a mandatory member is actually missing rows) that is a
module bug, exactly as a lying declared FK would be — out of scope to detect here.

## Key tests (TDD)

Extend `test/optimizer/inclusion-dependencies.spec.ts` (Wave 1's spec) and
`test/lens-advertisement.spec.ts`:

- **Injected-IND existence-anchor proof for a mandatory component.** A columnar
  decomposition with `CarCore` (anchor) + mandatory `CarPerf` → the planned lens
  body carries an `InclusionDependency` with `target.kind:'relation'`,
  `relationId` = the advertisement anchor id, `cols` = the member key indices,
  `nullRejecting:false`. Assert it is present and structurally correct.
- **Optional member injects no IND.** Same with `CarPerf` optional → no relation-IND
  for it (over-claim guard).
- **Singleton injects no IND.** `primary key ()` decomposition → no relation-IND.
- **Anchor contract.** The injected `relationId` equals `advertisement.id` ==
  `StorageShape.anchorRelationId` (the resolver-validated identity) — so the IND and
  the get-synthesis join agree on the anchor.
- **Survives propagation to body output.** If seam (1) is chosen, the IND seeded at
  the member scan survives the inner-join propagation to the body's output
  `PhysicalProperties` (Wave 1's join-propagation keeps the preserved/inner-side
  INDs). If seam (2), the prover reads it off the slot.
- **Prover consumption smoke** (coordinate with `3-lens-prover-and-attachment`): the
  prover discharges the no-row-loss / mandatory-existence obligation using the
  injected fact rather than erroring for "unprovable existence".

## TODO

### Phase A — produce the injected INDs
- In `lens-compiler.ts`, after `compileDecompositionBody`, compute one `InclusionDependency` per mandatory non-anchor member (`cols` = member key output indices, `target` = relation-anchor, `nullRejecting:false`); none for optional members or the empty key.
- Use `addInd`/`mergeInds` + `MAX_INDS_PER_NODE` for dedup/cap consistency with Wave 1.

### Phase B — thread the fact to the prover
- Trace how the prover reads `PhysicalProperties` over the inlined lens body **first**.
- Implement seam (1) (seed at member scan via advertisement membership) if clean, else seam (2) (`LensSlot.injectedInds`, prover reads directly). Wire whichever is chosen so the fact reaches the prover.
- Confirm Wave-1 IND join-propagation carries a seam-(1) seeded IND through the synthesized join to the body output (no new propagation rule needed).

### Phase C — docs + tests
- `docs/optimizer.md`: add the Wave-3 entry to the "Inclusion Dependency Tracking" section — the lens existence-anchor injection is the first `kind:'relation'` producer; describe the chosen threading seam and the mandatory-only / total-only soundness rule.
- `docs/lens.md` § "Existence soundness rides the propagated IND surface": flip from pending to shipped; cross-link the get-synthesis and put-fanout siblings.
- Tests per "Key tests". Run `yarn workspace @quereus/quereus run build`, the optimizer + lens specs, and lint (single-quote globs on Windows) before handoff. No golden-plan churn expected for non-lens plans (only lens bodies gain the relation-IND).
