description: Review the direction fix + injection gate for the existence-anchor inclusion dependency minted by `computeExistenceAnchorInds`. The producer now emits `anchor.key ⊆ member.key` (was `member.key ⊆ anchor.key`) — the totality direction `presence:'mandatory'` guarantees and the only fact the anchor-rooted inner join's no-row-loss obligation needs — and injection is gated to the synthesized-decomposition body (R2). Docs + 6 IND tests updated to the corrected direction.
prereq:
files: packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/schema/lens.ts, packages/quereus/src/vtab/mapping-advertisement.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/analysis/coverage-prover.ts, packages/quereus/test/lens-advertisement.spec.ts, docs/optimizer.md, docs/lens.md
----

## What landed (settled bug, not a tweak)

The `InclusionDependency` convention is `THIS.cols ⊆ target.targetCols` (`cols` index THIS
relation's output, `targetCols` index the TARGET relation; positional pairing). The
FK seed (`seedTableForeignKeyInds`) makes `cols` the child/referencing side, `target` the
parent/referenced side. The intended consumer (`indDerivedNoRowLoss` in
`coverage-prover.ts`) discharges an inner/cross join `tSide ⋈ lookup`'s no-row-loss for
`tSide` by reading an IND **on `tSide`** of the form `tSide.cols ⊆ lookup.targetCols`.

`compileDecompositionBody` builds a left-deep join **rooted at the existence anchor**,
inner-joining each mandatory member (`anchor ⋈ member`). The logical entities are the
anchor rows (1 per logical row), so the no-row-loss obligation is "no **anchor** row is
dropped" → `tSide = anchor`, `lookup = member` → the IND the consumer needs is
**`anchor.key ⊆ member.key`**.

The old producer emitted the opposite (`member.key ⊆ anchor.key`), which is both (a) not
what the consumer needs, and (b) not guaranteed by `presence:'mandatory'` ("every logical
row has it" gives anchor→member totality, never member→anchor RI). An orphan
mandatory-member row whose key is absent from the anchor is filtered by the inner join
(reads stay correct) but makes the old fact **false** → an over-claim, which
`plan-node.ts` documents as unsound. There is **no live consumer** of
`LensSlot.injectedInds` today (verified: the prover does not read it; `put-fanout` does
not reference it), so this is a pure correctness-of-the-fact fix with zero behavioral
blast radius — it had to land before any consumer is built.

### Changes

- **Direction swap** (`computeExistenceAnchorInds`, `lens-compiler.ts`): per mandatory
  non-anchor non-EAV member, now emits `cols = anchorKeyIdx.slice(0,n)`,
  `target = { kind:'relation', relationId: member.relationId, targetCols: memberKeyIdx.slice(0,n) }`,
  `nullRejecting:false`. `n = min(anchorKeyIdx.length, memberKeyIdx.length)` unchanged.
  Multiple mandatory members still produce distinct INDs (same `cols` = anchor key,
  different `target.relationId`) so `addInd` dedup is unaffected. All guards intact
  (mandatory-only, non-EAV, non-anchor, empty-key→none).
- **R2 injection gate** (`deployLogicalSchema`, `lens-compiler.ts`): a `fromDecomposition`
  flag is set true only in the `else if (advertisement)` branch (the synthesized n-way
  body from `compileDecompositionBody`). `injectedInds` is computed only when
  `fromDecomposition` — left undefined for the full hand-authored override and
  single-source default bodies (which carry no advertised `anchor ⋈ member` join, so an
  injected IND would describe joins absent from `compiledBody`).
- **Doc comments**: `computeExistenceAnchorInds` (corrected direction + soundness
  one-liner), `LensSlot.injectedInds` (`lens.ts`), `DecompositionMember.presence`
  (`mapping-advertisement.ts`, cross-reference to the IND's totality).
- **Docs**: `docs/optimizer.md` IND-promotion note + the §"next producer" sentence;
  `docs/lens.md` two lens-compiler bullets — all now state `anchor.key ⊆ member.key`.
- **Tests**: 6 IND-injection tests in `lens-advertisement.spec.ts` flipped to the
  corrected direction (target = member, `cols` = anchor key). The old "relationId equals
  anchor" test was reworked into a **direction-swap guard** that asserts the target is a
  non-anchor member (`!= anchorRelationId`) and `cols` address the anchor key.

## Use cases / what to scrutinize (reviewer — treat tests as a floor)

- **Soundness of the new direction.** Confirm `anchor.key ⊆ member.key` is what
  `indDerivedNoRowLoss` would consume for an `anchor ⋈ member` inner join (THIS = anchor,
  target = member). The argument: every anchor (= logical) row has a matching mandatory
  member on the shared key (totality), so no anchor row is dropped. Verify nothing in the
  advertisement/store contract secretly guarantees the converse (member→anchor RI) that
  would have rescued the old direction — the ticket asserts it does not.
- **Fixture blind spot (known gap).** In every test fixture the shared-key index is `0`
  on *both* relations, so `cols` and `targetCols` are both `[0]` — the index *values*
  cannot catch a future re-swap. The only discriminator is `target.relationId`
  (anchor vs member). The added direction-swap guard leans on `relationId`, which is
  correct, but a fixture where anchor-key-index ≠ member-key-index (e.g. surrogate at a
  non-zero ordinal on one side) would make the `cols`/`targetCols` assertions
  independently load-bearing. Consider whether such a fixture is worth adding.
- **R2 gate completeness.** The gate currently fires only for `compileDecompositionBody`.
  The future sparse-override gap-fill body (`lens-multi-source-decomposition`) will also
  carry the advertised joins and should extend the gate — flagged in-code and in the
  ticket, intentionally deferred (do not block on it). Confirm the override and default
  branches genuinely leave `injectedInds` undefined (slot field is
  `injectedInds.length > 0 ? … : undefined`, and the gated array is `[]` for those
  branches).
- **`plan-node.ts` `IndTarget` doc (pre-existing staleness, left untouched).** The
  `relation`-variant doc still reads "No producer mints it in this wave" — that was
  already stale before this ticket (the injection shipped in
  `lens-multi-source-ind-injection`), is about *existence* of a producer, not *direction*,
  and is out of this fix's scope. Note it; a future doc-sweep ticket can correct it if
  desired.

## Validation performed (all green)

- `yarn workspace @quereus/quereus run build` → exit 0 (tsc, no type errors).
- `lens-advertisement.spec.ts` → **31 passing, 0 failing** (incl. the 6 updated IND tests).
- `optimizer/inclusion-dependencies.spec.ts` + `covering-structure.spec.ts` → **110 passing**
  (IND soundness/law harness + coverage-prover structural backstop).
- All `test/lens*.spec.ts` → **120 passing** (prover/compiler regression check for the R2 gate).
- Full `packages/quereus/test/**/*.spec.ts` → exit 0, **zero failures** (dot reporter, no `F`).
- `yarn workspace @quereus/quereus run lint` → exit 0, clean.

Note: under Windows + Git Bash the `tee`/redirect stdout was intermittently swallowed;
mocha **exit codes** (= failure count) and the absence of `F` dots are the authoritative
signal used above. A reviewer re-running `yarn test` should see the same green.

## Out of scope / not done

- No new fixture with distinct per-side key ordinals (see "Fixture blind spot" above) —
  judged optional; the `relationId`-based swap guard already fails loudly on a re-swap.
- `plan-node.ts` `IndTarget` "no producer this wave" staleness left as-is (pre-existing,
  not direction-related).
- The R2 gate extension for the future sparse-override gap-fill body is deferred to
  `lens-multi-source-decomposition` (tied to that property, not appropriate now).
