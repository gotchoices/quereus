description: Correct the DIRECTION of the existence-anchor inclusion dependency injected by `computeExistenceAnchorInds`. It currently emits `member.key ⊆ anchor.key` (cols=member, target=anchor); the no-row-loss obligation it exists to discharge needs `anchor.key ⊆ member.key`, which is also the only direction `presence:'mandatory'` actually guarantees. Swap the emitted direction, gate injection to the synthesized-decomposition body (R2), then update the 6 IND tests and the docs that describe the old direction.
prereq:
files: packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/analysis/coverage-prover.ts, packages/quereus/src/vtab/mapping-advertisement.ts, packages/quereus/test/lens-advertisement.spec.ts, docs/optimizer.md, docs/lens.md
----

## Investigation result (settled — this is a real bug, not a code tweak)

The `InclusionDependency` direction convention is unambiguous and verified against
all three reference points:

- **Convention** (`plan-node.ts` `InclusionDependency` / `IndTarget`; `docs/optimizer.md`
  § "Inclusion Dependency Tracking" line ~1428): `cols` are output-column indices on
  **THIS** relation; `target.targetCols` index into the **TARGET** relation; `cols[i]`
  pairs positionally with `targetCols[i]`. Semantics: **`THIS.cols ⊆ target.targetCols`**.
- **FK seed** (`seedTableForeignKeyInds`, `util/ind-utils.ts`): `cols` = FK **child**
  (referencing) columns, `target` = **parent** (referenced) PK → asserts `child ⊆ parent`.
  So `cols` is always the *child/referencing* side, `target` the *parent/referenced* side.
- **The intended consumer** (`indDerivedNoRowLoss`, `planner/analysis/coverage-prover.ts`):
  to discharge an inner/cross join `tSide ⋈ lookup`'s **no-row-loss for `tSide`**, it reads
  an IND **on `tSide`** of the form `tSide.cols ⊆ lookup.targetCols`. The IND lives on the
  row-preserved side and points at the other side; the guarantee "for every tSide row a
  matching lookup row exists" is what proves no tSide row is dropped.

### Why the current emission is wrong AND unsound

`compileDecompositionBody` builds a left-deep join **rooted at the existence anchor**,
INNER-joining each mandatory member: `anchor ⋈ member`. The logical entities are the
anchor rows (the existence anchor is 1 row per logical row). The no-row-loss obligation
is therefore "**no anchor row is dropped by the inner join**" → `tSide = anchor`,
`lookup = member` → the IND the consumer needs is **`anchor.key ⊆ member.key`**.

`presence:'mandatory'` (`mapping-advertisement.ts`: "*every logical row has it*") gives
exactly that: every anchor (= logical) row has a matching member row on the shared key →
`anchor.key ⊆ member.key`, total (`nullRejecting:false`).

The producer today emits the **opposite**: `cols = memberKeyIdx`,
`target = { relationId: anchor, targetCols: anchorKeyIdx }` → `member.key ⊆ anchor.key`.
That direction:
- is **not what the consumer needs** (a `member ⊆ anchor` fact on the member side does
  not let the prover derive "no anchor row dropped"), and
- is **not guaranteed by `mandatory`** — `member ⊆ anchor` requires member→anchor
  referential integrity (no orphan member rows), which the decomposition contract never
  states. A mandatory-member row whose key is absent from the anchor is simply filtered
  out by the inner join (reads stay correct), but it makes the *injected* fact **false**
  → an over-claim, which `plan-node.ts` documents as unsound.

The implementer's 1:1 defense does not rescue it: even granting anchor↔member 1:1 on the
shared key, only one direction is injected and `member ⊆ anchor` cannot derive
`anchor ⊆ member`; the 1:1-ness is not itself an injected fact. Inject **only** the
direction a stated property guarantees.

### Decision

**Emit `anchor.key ⊆ member.key`** (the totality direction `mandatory` guarantees and the
no-row-loss consumer needs). Do **not** also emit the converse — nothing in the
advertisement/store contract guarantees member→anchor RI today. If a future invariant
(e.g. the put fan-out maintaining no orphan members) makes the converse hold, add it then,
tied to that property — not now.

Concretely, in `computeExistenceAnchorInds`, per mandatory non-anchor non-EAV member,
replace the injected entry with:

```ts
inds = addInd(inds, {
  cols: anchorKeyIdx.slice(0, n),                       // anchor's shared-key indices (THIS = anchor)
  target: {
    kind: 'relation',
    relationId: member.relationId,                      // target = the MEMBER (not the anchor)
    targetCols: memberKeyIdx.slice(0, n),               // member's shared-key indices
  },
  nullRejecting: false,                                  // total: every anchor row has the member
}, { cap: MAX_INDS_PER_NODE });
```

`n = Math.min(anchorKeyIdx.length, memberKeyIdx.length)` is unchanged. Multiple mandatory
members still produce distinct INDs (same `cols` = anchor key, different
`target.relationId`), so `addInd` dedup is unaffected.

Soundness one-liner to put in the doc comment: *`presence:'mandatory'` ⇒ every anchor
(= logical) row has a matching member row on the shared key ⇒ `anchor.key ⊆ member.key`,
total — exactly the existence fact the anchor-rooted inner join's row-preservation
obligation needs; the converse (`member ⊆ anchor`) is intentionally not asserted because
no stated property guarantees member→anchor referential integrity.*

### R2: gate injection to the synthesized-decomposition body

`injectedInds` is currently computed for **any** advertisement-backed slot:

```ts
const injectedInds = advertisement ? computeExistenceAnchorInds(advertisement, basis, db) : [];
```

For a **full hand-authored override** (the `if (override)` branch, where the override body
bypasses the advertised decomposition) the compiled body does **not** contain the
advertised `anchor ⋈ member` joins, so the injected IND describes joins that are not in the
body. The fact stays true as a *store* invariant, but a consumer reading `slot.injectedInds`
as "facts about `slot.compiledBody`'s joins" would be misled. Gate injection so it is
computed **only when the body came from `compileDecompositionBody`** (the `else if
(advertisement)` branch — the synthesized n-way decomposition). For the override and
default branches, leave `injectedInds` undefined.

Note for the future sparse-override gap-fill: once `lens-multi-source-decomposition`
synthesizes the n-way gap-fill body for sparse overrides, those bodies *will* carry the
advertised joins and injection becomes appropriate there too — extend the gate then, tied
to that ticket; do not block on it now.

## Coordination / safety

- **No live consumer today** — `LensSlot.injectedInds` is read by nothing (the prover does
  not consume it; `lens-multi-source-put-fanout` in `implement/` does not reference it,
  verified). So this is a pure correctness-of-the-fact fix with no behavioral blast radius;
  it must land before any consumer is built.
- Keep all existing guards intact (mandatory-only, non-EAV, non-anchor, empty-key → none).
  None of them change; only the emitted tuple's direction and the injection gate change.

## Tests to update (`packages/quereus/test/lens-advertisement.spec.ts`, describe block
"lens existence-anchor IND injection", lines ~847–1039)

The 6 tests currently assert the as-implemented (wrong) direction, so they pass today and
do not catch the bug. Flip them to the corrected direction:

- **"injects one existence-anchor IND per mandatory member ..."** (~887): `cols` becomes
  the **anchor** (`Car_core`) key indices `[0]`; `relTarget(ind).relationId` becomes the
  **member** `'Car_perf'`; `targetCols` becomes the member key `[0]`. Update the title's
  parenthetical (`cols = anchor key, target = member, total`).
- **"the injected relationId equals advertisement.id === storage.anchorRelationId ..."**
  (~907): this assertion is now **false by design** — the target is the member, not the
  anchor. Rework it into a positive check that the target `relationId` is a **non-anchor
  mandatory member** (e.g. `expect(t.relationId).to.equal('Car_perf')` and
  `expect(t.relationId).to.not.equal(ad.storage!.anchorRelationId)`), and that `cols`
  reference the anchor's key. Retitle accordingly (the "anchor contract" framing moves to
  `cols`, not the target).
- **"an optional member injects no IND ..."** (~923): unchanged (still length 0).
- **"a singleton (primary key ()) decomposition injects no IND ..."** (~933): unchanged
  (still length 0).
- **"a surrogate split injects per-member surrogate columns ..."** (~965): Doc_core is the
  anchor (`sid`), Doc_body the member (`doc_sid`). `cols` becomes anchor key `[0]` (sid @ 0
  on Doc_core); `relTarget().relationId` becomes `'Doc_body'`; `targetCols` becomes member
  key `[0]` (doc_sid @ 0 on Doc_body). Update the inline comments about which relation each
  index set addresses.
- **"injects one IND per mandatory member when several are present (3-member split)"**
  (~1006): `relTarget(inds[0]).relationId` becomes `'Car_perf'` (the mandatory non-anchor
  member), not `'Car_core'`.

Consider adding one assertion that makes the over-claim impossible to reintroduce silently:
assert `cols` equals the anchor key indices and `target.targetCols` equals the member key
indices (i.e. the THIS-side is the anchor), so a future accidental swap fails loudly.

## Docs to update

- **`docs/optimizer.md`**: the "IND promotion note" (lines ~1665–1686) states "*`cols` =
  the member's shared-key indices, `target = { kind:'relation', relationId: <anchor>,
  targetCols }`*" — rewrite to the corrected direction (`cols` = anchor shared-key indices,
  `target.relationId` = the member, `targetCols` = member shared-key indices) with the
  soundness one-liner above. Check the `IndTarget` comment near line ~1424 and the §1452
  "next producer" sentence for stale direction wording.
- **`docs/lens.md`**: the lens compiler bullet(s) (~356, ~360) say "records one relation-IND
  per mandatory member" with no direction — add a short clause stating the direction
  (`anchor.key ⊆ member.key`, the `mandatory` totality fact) so the doc pins the corrected
  semantics.
- **`packages/quereus/src/schema/lens-compiler.ts`**: rewrite the `computeExistenceAnchorInds`
  doc comment (currently describes `member ⊆ anchor`) to the corrected direction + soundness
  justification.
- **`packages/quereus/src/vtab/mapping-advertisement.ts`** (optional, low cost): the
  `DecompositionMember.presence` doc already says "every logical row has it"; optionally add
  one clause noting this is the `anchor.key ⊆ member.key` totality the existence-anchor IND
  encodes, so the producer and the property it relies on are cross-referenced.

## Validation

- `yarn workspace @quereus/quereus run build` then run the targeted spec:
  `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/lens-adv.log` (or the mocha file
  filter for `lens-advertisement.spec.ts`), confirm the 6 updated tests pass.
- Run `test/optimizer/inclusion-dependencies.spec.ts` to confirm the IND soundness/law
  harness still passes (it does not exercise relation-targets directly, but is the structural
  backstop for the IND surface).
- Lint `packages/quereus` (single-quote the glob on Windows).

## TODO

- Swap the emitted IND direction in `computeExistenceAnchorInds` to
  `anchor.key ⊆ member.key` (cols = anchor key indices; target = member relationId +
  member key indices; `nullRejecting:false`).
- Gate `injectedInds` computation in `deployLogicalSchema` to the synthesized-decomposition
  body branch only (R2); leave it undefined for override/default bodies.
- Rewrite the `computeExistenceAnchorInds` doc comment with the corrected direction +
  one-line soundness justification.
- Update the 6 IND-injection tests in `lens-advertisement.spec.ts` (per the list above),
  including reworking the "relationId equals anchor" test into a non-anchor-member check,
  and add the explicit anchor=cols / member=targetCols guard assertion.
- Update `docs/optimizer.md` (IND promotion note + IndTarget/next-producer wording) and
  `docs/lens.md` (lens compiler bullets) to the corrected direction; optionally annotate
  `mapping-advertisement.ts` `presence`.
- Build, run the lens + IND specs, and lint; confirm green.
