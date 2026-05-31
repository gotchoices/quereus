description: Existence-anchor IND direction fix — `computeExistenceAnchorInds` now emits `anchor.key ⊆ member.key` (was the unsound `member ⊆ anchor`), the totality `presence:'mandatory'` guarantees and the only fact the anchor-rooted inner join's no-row-loss obligation needs; IND injection gated to the synthesized-decomposition body (R2). Reviewed and completed.
files: packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/schema/lens.ts, packages/quereus/src/vtab/mapping-advertisement.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/test/lens-advertisement.spec.ts, docs/optimizer.md, docs/lens.md
----

## What landed

`computeExistenceAnchorInds` (`schema/lens-compiler.ts`) now emits, per **mandatory**,
non-anchor, non-EAV decomposition member, an inclusion dependency
`anchor.key ⊆ member.key` (total, `nullRejecting:false`):

- `cols = anchorKeyIdx.slice(0,n)` — the **anchor's** shared-key column indices on the
  anchor's basis relation,
- `target = { kind:'relation', relationId: member.relationId, targetCols: memberKeyIdx.slice(0,n) }`,
- `n = min(anchorKeyIdx.length, memberKeyIdx.length)`.

The previous direction (`member.key ⊆ anchor.key`) was an **over-claim**: it asserted
member→anchor referential integrity, which `presence:'mandatory'` ("every logical row has
it") never guarantees. Reads were already correct (an orphan mandatory-member row is
filtered by the inner join), but the *fact* was false. Since the `InclusionDependency`
contract treats a false IND as unsound (`plan-node.ts`), the direction had to be corrected
before any consumer rides `LensSlot.injectedInds`.

Injection is gated (R2) to the synthesized-decomposition body via a `fromDecomposition`
flag set `true` only in the `else if (advertisement)` branch of `deployLogicalSchema`
(the `compileDecompositionBody` path). The full hand-authored override and single-source
default bodies carry no advertised `anchor ⋈ member` join, so they leave `injectedInds`
undefined.

Docs (`docs/optimizer.md`, `docs/lens.md`) and 6 IND-injection tests in
`lens-advertisement.spec.ts` were flipped to the corrected direction; the old
"relationId == anchor" test was reworked into a direction-swap guard.

## Review findings

**Diff reviewed first, against the IND convention and the intended consumer, before
trusting the handoff.**

### Soundness of the new direction — CONFIRMED
- The `InclusionDependency` contract (`plan-node.ts`) is `THIS.cols ⊆ target.targetCols`.
  The new producer sets `cols = anchorKey`, `target.relationId = member`,
  `targetCols = memberKey` ⇒ the fact reads `anchor.key ⊆ member.key`. ✓
- `presence:'mandatory'` ("every logical row has it") gives exactly anchor→member
  totality on the shared key — every anchor (= logical) row has a matching member row ⇒
  `anchor.key ⊆ member.key`, total. The converse (member→anchor RI) is not guaranteed by
  any advertisement/store contract; the code intentionally does not assert it. ✓
- `indDerivedNoRowLoss` (`coverage-prover.ts`) — the *shape* of consumer the anchor-rooted
  `anchor ⋈ member` inner join needs — reads an IND **on the T-side** (= anchor) whose
  target is the lookup (= member). The corrected direction matches that shape. (That
  specific consumer only admits `target.kind === 'table'`, so it does **not** read these
  `kind:'relation'` INDs today — see "no live consumer" below.) ✓

### No live consumer — CONFIRMED
- `find_references(injectedInds)` returns only the producer (`lens-compiler.ts`), the type
  (`lens.ts`), and the test file. Nothing threads `slot.injectedInds` into
  `PhysicalProperties.inds`; `indDerivedNoRowLoss` reads only `tSide.physical?.inds`. So
  this is a pure correctness-of-the-fact fix with zero behavioral blast radius, exactly as
  claimed.

### R2 gate completeness — CONFIRMED
- `fromDecomposition` is set `true` only inside `else if (advertisement)`, so the
  `computeExistenceAnchorInds(advertisement!, …)` non-null assertion is sound. The override
  and default branches leave it `false` ⇒ `injectedInds = []` ⇒ slot field `undefined`
  (`injectedInds.length > 0 ? … : undefined`). ✓

### Findings fixed inline (minor)

1. **`plan-node.ts` `IndTarget` doc staleness** — the `relation`-variant doc still read
   "*No producer mints it in this wave*", which became false once
   `lens-multi-source-ind-injection` shipped (and is the exact variant this fix emits).
   The implement handoff flagged this as pre-existing and deferred it; I judged it a minor,
   safe, in-scope doc correction (a "no producer exists" claim sitting next to a producer
   is misleading) and **fixed it inline**: the bullet now states the lens existence-anchor
   injection mints it (`anchor.key ⊆ member.key`, one per mandatory non-anchor member,
   recorded on `LensSlot.injectedInds`, read by the lens prover off the slot — not via
   general per-operator propagation), while preserving the enforcement-ready rationale.

2. **Fixture blind spot (the implement handoff's "known gap")** — every existing fixture
   keys both anchor and member at column ordinal `0`, so `cols`/`targetCols` are both
   `[0]` and the *index values* cannot catch a re-swap; only `target.relationId`
   discriminates. **Added a fixture with distinct per-side ordinals** (anchor surrogate
   `sid` @ ordinal 2, member surrogate `body_sid` @ ordinal 0) asserting `cols == [2]` and
   `targetCols == [0]`. A direction swap back to `member ⊆ anchor` now fails on the index
   *values* independently of the relationId guard. Verified `mapKeyColumnsToIndices`
   resolves to the basis-table ordinal, so the expected `[2]`/`[0]` are correct.

### Observations (no action — not introduced or worsened here)

- **`cols` frame for a future consumer.** The IND is attached to the slot; its `cols` are
  defined (and documented) as indices on the *anchor's basis relation*, not the
  decomposition-body output. A future consumer that reads `slot.injectedInds` per the
  generic `InclusionDependency` "output-column indices on THIS relation" contract must
  reconcile that frame (the body output may not place the anchor key at the same ordinal).
  This is a pre-existing design decision (the old direction had the identical frame
  question with `cols = member` indices); the direction fix is frame-neutral and does not
  regress it. The future `lens-multi-source-put-fanout` / prover-wiring ticket owns this.
- **R2 gate extension.** The future sparse-override gap-fill body
  (`lens-multi-source-decomposition`) will also carry the advertised joins and should
  extend the gate; flagged in-code and intentionally deferred to that ticket.

### Categories checked

- **Correctness / soundness** — see above; the central fix is correct and the converse is
  correctly withheld.
- **Type safety** — `advertisement!` assertion proven safe by the branch structure; no
  `any`; `relTarget` test helper narrows the union explicitly.
- **DRY / modularity** — the new fixture reuses the existing `colMap`/`keyMap`/`relTarget`
  helpers; no duplication introduced.
- **Resource cleanup** — the new test follows the established `try/finally { await
  db.close() }` pattern.
- **Docs** — `docs/optimizer.md`, `docs/lens.md`, `lens.ts`, `mapping-advertisement.ts`,
  `lens-compiler.ts`, and (newly) `plan-node.ts` all now state `anchor.key ⊆ member.key`
  consistently. Residual `member ⊆ anchor` strings are only the "converse intentionally
  not asserted" notes and the archived `tickets/complete/lens-multi-source-ind-injection.md`
  history (correctly left untouched).
- **Error handling** — no new error paths; the producer's defensive `return []` guards are
  intact.

### Validation (all green)

- `yarn workspace @quereus/quereus run build` → exit 0.
- `yarn workspace @quereus/quereus run lint` → exit 0.
- `lens-advertisement.spec.ts` → **32 passing** (31 prior + the new distinct-ordinal guard).
- `test/lens*.spec.ts` + `optimizer/inclusion-dependencies.spec.ts` +
  `covering-structure.spec.ts` → **231 passing, 0 failing**.

(Tests run from repo root via `node --import ./packages/quereus/register.mjs
node_modules/mocha/bin/mocha.js …` — the package's bare-`mocha` invocation lacks the ESM
register loader and fails to resolve `src/index.js`; use the register import.)

### Scope note

The implement commit `bb2c8db4` bundled a second ticket's work
(`3.3-materialized-view-rowtime-residual-join`: `database-materialized-views.ts`,
`coverage-prover.ts`, several MV docs/specs) into the same commit. That work is tracked by
its own `tickets/review/3.3-materialized-view-rowtime-residual-join.md` and was **out of
scope** for this review. This review covered only the lens existence-anchor IND direction
fix (lens-compiler.ts / lens.ts / mapping-advertisement.ts / plan-node.ts /
lens-advertisement.spec.ts / docs).
