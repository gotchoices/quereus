description: Wave-3 existence-anchor inclusion-dependency (IND) injection — the lens compiler mints one `InclusionDependency` (`IndTarget.kind:'relation'`) per mandatory decomposition member onto the existence anchor and threads it to the prover via `LensSlot.injectedInds`. First `kind:'relation'` producer. Read-direction soundness fact only; no put fan-out, no new prover obligation. REVIEWED.
files: packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/schema/lens.ts, packages/quereus/test/lens-advertisement.spec.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/planner/util/ind-utils.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/vtab/mapping-advertisement.ts, docs/lens.md, docs/optimizer.md
----

## Summary of what shipped (verified against the diff)

For a logical table backed by a primary-storage `MappingAdvertisement`, the lens
compiler now computes existence-anchor INDs and records them on the slot:

- `computeExistenceAnchorInds(advertisement, basis, db)` (lens-compiler.ts:851) +
  `mapKeyColumnsToIndices` (899). Per **mandatory, non-anchor, non-EAV** member it
  emits one `InclusionDependency`: `cols` = the member's shared-key column indices on
  its own basis relation, `target = { kind:'relation', relationId: <anchor>, targetCols:
  <anchor key indices> }`, `nullRejecting:false`. Member/anchor keys pair positionally
  via `Math.min(len)` (mirrors `buildKeyEquiJoin`). Optional members, EAV pivots, and
  the empty-key singleton inject nothing. Dedup/cap via `addInd(..., { cap: MAX_INDS_PER_NODE })`.
- `LensSlot.injectedInds?: ReadonlyArray<InclusionDependency>` (lens.ts:154), set in
  `deployLogicalSchema` (lens-compiler.ts:160-174) whenever `slot.advertisement` exists
  (undefined when empty). Threading **seam (2)** chosen: the slot is the prover's own
  input, so the fact reaches the prover by construction (a scan-time seed wouldn't — the
  body is planned before the slot is committed).
- 6 new tests in `lens-advertisement.spec.ts` (847-1039); docs updated in `docs/lens.md`
  and `docs/optimizer.md`.

## Review findings

### What was checked
- The full implement diff (lens-compiler.ts, lens.ts, the 6 tests, docs) read first,
  before the handoff summary.
- The `InclusionDependency` / `IndTarget` contract in `plan-node.ts` and the
  `addInd`/`MAX_INDS_PER_NODE` helpers in `fd-utils.ts`.
- The `MappingAdvertisement` / `StorageShape` / `DecompositionMember` / `SharedKey`
  types in `vtab/mapping-advertisement.ts` (field names, `presence`, `attributePivot`,
  `keyColumnsByRelation`, `anchorRelationId`, `id`).
- The FK-seeded sibling producer `seedTableForeignKeyInds` / `lookupCoveringFK` in
  `ind-utils.ts` (to confirm the convention and that it is structurally blind to the
  surrogate join, as the design claims — confirmed: FK-declaration-bound).
- Whether the prover consumes `injectedInds` (grep over `lens-prover.ts`): it does
  **not** — confirming the disclosed "no consumer yet" gap is accurate.
- Docs flips in `docs/lens.md` (§ Default Mapper, § IND existence-anchor contract,
  § Implementation Surface ×3) and `docs/optimizer.md` (§ IndTarget comment, § Wave-3
  note) — read in full; they describe the shipped reality correctly.
- SPP / DRY / type-safety / resource-cleanup / error-handling aspects of the new code.

### MAJOR — filed as a new ticket (not fixed inline)
- **R1: direction of the injected IND.** `computeExistenceAnchorInds` emits, per
  mandatory member, `cols = member key` / `target.targetCols = anchor key`. Per the
  documented convention in `plan-node.ts` (`child.cols ⊆ table.targetCols`; matches
  `seedTableForeignKeyInds`), that asserts **`member.key ⊆ anchor.key`**. But the stated
  purpose — no-row-loss of the mandatory INNER join, "prove every logical/anchor row
  matches the mandatory side" — requires the **opposite** inclusion, **`anchor.key ⊆
  member.key`**, which is exactly what `presence:'mandatory'` (totality: every logical
  row has the member; confirmed in `mapping-advertisement.ts:84-88`) guarantees. The
  emitted direction (`member ⊆ anchor`) is instead a member→anchor referential-integrity
  claim that "mandatory" does **not** state. The implementer's "1:1, so the converse
  holds" note is true in a well-formed decomposition, but (a) only one direction is
  injected and a consumer cannot derive the other from it, and (b) the ticket *spec*
  itself specified `member ⊆ anchor`, so this is a design question, not a code slip.
  **Currently inert** — no code reads `LensSlot.injectedInds` (verified) — so there is no
  live incorrectness today; the fix must land before a consumer
  (`lens-multi-source-put-fanout` or a prover no-row-loss obligation) is built.
  → filed `tickets/fix/lens-ind-injection-direction-verify.md` (prereq: this ticket).
  The 6 new tests assert the as-implemented direction, so their passing does **not**
  absolve R1; that ticket also covers updating them.

### MINOR — noted (rolled into R1's ticket; not blocking)
- **R2: injected for any advertisement-backed slot, including a full hand-authored
  override** that bypasses the advertised body (`validateOverrideAdvertisementConflict`
  runs only for sparse, gap-filling overrides). `injectedInds` is computed from the
  advertisement contract regardless of which body compiled, so the fact may not match the
  actual compiled joins in the full-override case. Inert today; acceptable as the fact is
  a property of the advertised contract, but worth revisiting when a consumer lands.
- **R3: surrogate arity truncation.** `Math.min(memberKeyIdx.length, anchorKeyIdx.length)`
  silently truncates if arities differ; the advertisement validator already rejects
  surrogate arity mismatch, so this is defensive only. A stricter equal-arity assertion
  would fail louder if that invariant regressed. Optional hardening.

### Checked, no issue (clean)
- `basis` param **is** used (`resolveBasisRelation(db, member, basis)`) — no unused-arg.
- Exclusions are correct and match the get-synthesis join set: optional → outer-joined
  (over-claim guard), EAV pivot → never inner-joined, empty/singleton key → no witnessing
  tuple. All three are exercised by the new tests (use-cases 2, 3, 5).
- `advertisement.id === storage.anchorRelationId` (resolver-validated; `mapping-advertisement.ts:34`)
  so the IND's `relationId` and the get-synthesis join name the same anchor (test 2).
- Surrogate split indexes each relation independently (`cols` on member, `targetCols` on
  anchor) — correct, and `keyColumnsByRelation` is keyed per member (test 4).
- Dedup/cap via `addInd` is the right primitive (distinct members → distinct `cols`, so
  no spurious collisions); `readonly injectedInds?` set to `undefined` (not `[]`) when
  empty; recomputed per-table inside the deploy loop so clear-and-rebuild refreshes it.
- Type safety: no `any`; `InclusionDependency`/`IndTarget` imported as types; small
  single-purpose functions. Resource cleanup / error handling: defensive early-returns
  with documented "validated at resolution" rationale — not eaten exceptions (the
  resolver already threw for the malformed cases these guard).
- Docs accurately reflect "shipped" and the seam-(2) / no-general-optimizer-visibility
  trade-off.

### Empty categories (explicit)
- **No new runtime / golden-plan impact**: the relation-IND lives on the slot, not in
  any query plan's `physical.inds`, so non-lens plans are unchanged. (Not exhaustively
  swept — see validation note below.)
- **No security / concurrency surface**: compile-time, per-deploy, in-memory slot field.

## Validation performed

- `yarn workspace @quereus/quereus run build` — **green this session** (`BUILD_EXIT:0`;
  full `tsc` typecheck, the strongest gate for this additive typed change).
- `eslint 'src/schema/lens-compiler.ts' 'src/schema/lens.ts' 'test/lens-advertisement.spec.ts'`
  — **green this session** (`LINT_EXIT:0`).
- Test suite — **green this session**: `yarn workspace @quereus/quereus run test`
  (the project's `test-runner.mjs`, which injects the ts-node/ESM loader) →
  **`4084 passing, 9 pending`, exit code 0** (full suite; includes the 6 new
  IND-injection specs and the lens-prover / lens-foundation / inclusion-dependencies
  specs). No failures. (An earlier direct `npx mocha …` attempt errored with
  `ERR_MODULE_NOT_FOUND: …/src/index.js` + a Node "Type Stripping" warning — that was a
  wrong-invocation artifact, **not** a code/test failure: bare `npx mocha` bypasses the
  loader that maps `src/index.js` → `index.ts`. Resolved by using the package's runner.)
- Note: a tool-result delivery lag in this session made command output flush in large
  delayed batches — unrelated to the code; all of build / lint / the full suite ultimately
  reported green.

## Disposition
- Implementation is sound and complete for its stated read-direction, produce-and-thread
  scope. One **major design question (R1)** filed as `lens-ind-injection-direction-verify`
  to be resolved before any consumer reads `injectedInds`. Minor items R2/R3 folded into
  that ticket. No inline code changes were required in this review pass.
