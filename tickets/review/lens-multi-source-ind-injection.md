description: Review of Wave-3 inclusion-dependency (IND) injection — the lens compiler now mints one `InclusionDependency` (`IndTarget.kind:'relation'`) per mandatory decomposition member onto the existence anchor and threads it to the prover via `LensSlot.injectedInds`. This is the first `kind:'relation'` producer (the variant Wave 1 reserved). Read-direction soundness fact only; no put fan-out, no new prover obligation.
files: packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/schema/lens.ts, packages/quereus/test/lens-advertisement.spec.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/planner/util/ind-utils.ts, docs/lens.md, docs/optimizer.md
----

## What shipped

For a logical table backed by a **primary-storage `MappingAdvertisement`**, the lens
compiler now injects existence-anchor inclusion dependencies and stores them on the
lens slot. The surrogate (or logical-tuple) join that stitches decomposition members
together carries **no declared SQL FK**, so the FK-bound `ind-utils.ts`
(`lookupCoveringFK` / `seedTableForeignKeyInds`) is structurally blind to it — the
injected IND is the parallel derivation surface that lets the prover discharge the
mandatory inner-join's no-row-loss / put-soundness obligation against a threaded fact
rather than re-deriving decomposition structure.

### Mechanism (the producer)
- `computeExistenceAnchorInds(advertisement, basis, db)` in
  `packages/quereus/src/schema/lens-compiler.ts` (new function, placed right after
  `compileDecompositionBody`, with helper `mapKeyColumnsToIndices`).
- Per **mandatory, non-anchor, non-EAV** member `m` it emits one
  `InclusionDependency`:
  - `cols` = `m`'s shared-key column indices on `m`'s **own basis relation**
    (= the member scan's output indices, table-columns 1:1),
  - `target` = `{ kind:'relation', relationId: <anchorRelationId>, targetCols: <anchor key indices> }`,
  - `nullRejecting:false` (a mandatory member's existence is **total**).
  - Member/anchor key columns pair **positionally** up to `Math.min(len)` — matching
    the get-synthesis equi-join (`buildKeyEquiJoin`).
- Skips: optional members (outer-joined; absence is preserved → IND would over-claim),
  EAV pivots (projected as correlated subqueries, never inner-joined), and the
  empty-key singleton (`primary key ()` / empty `keyColumnsByRelation` → no witnessing
  tuple). Dedup/cap via `addInd(..., { cap: MAX_INDS_PER_NODE })`.
- Direction note (potential review point): the ticket spec is `member.key ⊆ anchor.key`
  (`cols` on the member, `target` the anchor), and that is what is implemented. Anchor
  and mandatory member are 1:1 on the shared key, so the converse holds too; the
  implemented direction matches the ticket and the test assertions exactly.

### Threading seam — **(2) was chosen** (`LensSlot.injectedInds`)
The ticket offered seam (1) "seed at the member `TableReferenceNode`" vs seam (2)
"store on the slot, prover reads directly". **Seam (2)** was implemented, for two
load-bearing reasons:
1. **Timing.** The prover plans the compiled body (`compileBodyForProving`/`planBody`)
   *before* the slot is committed to the catalog (atomic compile-first deploy). A
   scan-time membership lookup would find no slot, so seam (1) would never reach the
   prover — the named consumer.
2. **Coupling.** Seam (1) needs the planner's table-access path to discover decomposition
   membership from the shared basis `TableSchema` (a logical↔basis coupling; a basis
   table can be a member of several logical decompositions across schemas).

`LensSlot.injectedInds?: ReadonlyArray<InclusionDependency>` was added
(`packages/quereus/src/schema/lens.ts`), set in `deployLogicalSchema` when an
advertisement is present (undefined when the list is empty). The slot is the prover's
own input, so the fact "reaches the prover" by construction. Documented trade-off: the
relation-IND is visible only to the prover, **not** the general optimizer (acceptable
— the prover is the sole intended consumer named in the design).

## Honest gaps / things to scrutinize (treat tests as a floor)

- **No prover-side consumption yet (forward-looking).** The shipped prover
  (`lens-prover.ts`) has **no** "no-row-loss / unprovable-existence" obligation today —
  it checks column coverage, type/nullability, key reconstructibility, round-trip. So
  this ticket *produces and threads* the fact but adds **no** new prover behavior and
  **no** new deploy error/warning. The "Prover consumption smoke" test in the ticket
  could not be written against a real obligation; that discharge lands when the prover
  (or `lens-multi-source-put-fanout`) grows a consumer. **Verify** this is acceptable
  scope (the ticket says "produces and threads … and ensures it survives to the
  prover" — satisfied — but a reviewer may want a TODO/cross-link in `lens-prover.ts`).
- **Injected for any advertisement-backed slot, including override+advertisement
  composition** — `injectedInds` is computed whenever `slot.advertisement` exists
  (its authority is the advertisement *declaration*, independent of which body — pure
  decomposition vs override — was compiled). Confirm that is the intended scope vs
  restricting to the pure `compileDecompositionBody` path. (Rationale: the fact is a
  property of the advertised mandatory-member contract, not of the body shape.)
- **`cols`/`targetCols` are basis-relation-relative, not body-output-relative.** Under
  seam (2) there is no scan node to anchor to, so indices are defined on each member's
  own `TableSchema` (output = table columns 1:1). This is internally consistent and is
  what the tests assert, but a future seam-(1) migration (if ever) would need to remap
  `cols` to the join's output offsets (Wave-1 join propagation already does this for
  FK INDs).
- **Surrogate arity edge.** When member/anchor key arities differ, injection pairs the
  first `min(len)` positionally (mirrors `buildKeyEquiJoin`). The advertisement
  validator already rejects surrogate arity mismatches, so in practice arities match;
  the `min` is defensive. Worth a glance for whether a stricter "require equal arity"
  guard is preferable to silent truncation here.
- **No golden-plan impact expected** — the relation-IND lives on the slot, not in any
  query plan's `physical.inds`, so non-lens plans are unchanged. Not exhaustively
  swept; a reviewer running the full `test/plan` suite would confirm.

## Validation performed (the floor)

- `yarn workspace @quereus/quereus run build` — clean.
- eslint on the three changed source/test files — clean (exit 0).
- `packages/quereus/test/lens-advertisement.spec.ts` — **31 passing** (25 pre-existing
  + 6 new IND-injection tests).
- `packages/quereus/test/optimizer/inclusion-dependencies.spec.ts` +
  `lens-prover.spec.ts` + `lens-foundation.spec.ts` — **68 passing**, 0 failing.
- Did **not** run the full `yarn test` sweep (per-spec runs only); a reviewer should
  run the full suite to confirm no cross-cutting regression (none expected — the change
  is additive and slot-local).

## Key use cases to re-verify

1. **Mandatory component → one total relation-IND.** Columnar `CarCore` (anchor) +
   mandatory `CarPerf`: `slot.injectedInds` has one IND, `target.kind:'relation'`,
   `relationId === advertisement.id === storage.anchorRelationId`, `cols` = member key
   indices, `nullRejecting:false`.
2. **Optional member → no IND** (over-claim guard).
3. **Singleton (`primary key ()` / empty shared key) → no IND** even with a mandatory
   member (empty key ⇒ no witnessing tuple).
4. **Surrogate split** (per-member surrogate spelled differently, e.g. `sid` vs
   `doc_sid`): `cols` index the member relation, `targetCols` the anchor relation.
5. **Multiple mandatory members → one IND each**; optional ones excluded.
6. **Anchor contract** holds: injected `relationId` == `advertisement.id` ==
   `StorageShape.anchorRelationId` (the resolver-validated identity), so the IND and
   the get-synthesis join name the same anchor.

## Suggested adversarial checks for the reviewer

- Confirm `addInd` ordered-compare dedup is the right call for two structurally-distinct
  members that happen to share `cols`/`target` (shouldn't collide; different members →
  different `cols`).
- Confirm a **mandatory EAV pivot member** (if a module ever declares one) is correctly
  excluded — the get-synthesis never inner-joins it, so no row-loss obligation exists.
- Confirm re-deploy (clear-and-rebuild) recomputes `injectedInds` from the fresh
  advertisement (it does — computed inside the per-table compile loop).
- Spot-check the docs flips in `docs/lens.md` (§ The module mapping advertisement, the
  IND existence-anchor contract, Implementation Surface) and `docs/optimizer.md`
  (§ Inclusion Dependency Tracking) read correctly as "shipped".
