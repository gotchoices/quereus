description: EAV-pivot decomposition UPDATE captured-value support — arbitrary EAV values (self-reference, cross-member, embedded subquery) ride the single-identity `__vmupd_keys` capture per attribute (matched-UPDATE + filtered-materialize-INSERT triple pair) instead of rejecting `unsupported-decomposition-update`. Implemented, reviewed, shipped.
files: packages/quereus/src/planner/mutation/decomposition.ts, packages/quereus/src/planner/mutation/backward-body.ts, packages/quereus/test/lens-put-fanout.spec.ts, packages/quereus/test/property.spec.ts, docs/lens.md, docs/view-updateability.md
----

## What shipped

An EAV-pivot value column is projected by the get body as a **correlated subquery**
(`(select val from pivot where entity = anchor.key and attr = '<attr>')`), so **any** EAV
self-reference (`set p = p + 1`), cross-member read, or embedded subquery lowers to a subquery value
and previously landed `arbitrary` → rejected. This work flips EAV onto the **same** single-identity
(anchor-key) `__vmupd_keys` capture the columnar prereq (`view-write-decomposition-update-captured-columnar`)
built, per attribute: the captured value substitutes the get-body projection over the anchor scan, the
matched UPDATE reads it back by the **entity** column, and a non-null-filtered materialize INSERT reads
it back by the **anchor key** (`on conflict (entity, attr) do nothing`).

Per captured EAV attribute cell the emit is the triple analogue of the columnar pair (matched UPDATE
keyed by entity column + filtered materialize INSERT keyed by anchor key). The matched UPDATE is
**unfiltered**: a captured-null on a matched triple writes `val = null` (reads identically to an absent
triple through the get-side subquery — a benign physical divergence from the explicit `set p = null`
DELETE). The materialize INSERT's runtime non-null filter means a captured null on an absent entity
materializes no phantom triple. Conflict target `(entity, attr)` is the deploy-guaranteed pivot PK/UNIQUE.

## Key changes (implement)

- **decomposition.ts** — `lowerMaterializedValue` removed the columnar-only gate (an EAV owner with the
  capture carrier classifies `captured`); `emitEavMemberUpdate` gained a `captured`-cell branch →
  `emitEavCapturedAttr` (registers the lowered value into the capture, emits the matched UPDATE via
  `buildEavAttrOp('update', valueOverride)` + the filtered materialize INSERT via new
  `buildEavCapturedInsert`). `EavCell.kind` widened to admit `captured`. Threaded `registerCapturedExpr`
  through `decomposeUpdate → emitEavMemberUpdate`. No routing change in `buildViewMutation`.
- **backward-body.ts** — `findBodySource` made **scope-aware**: returns the outermost node from root that
  carries a registered output scope (the `JoinNode` for a join body, the FROM `AliasNode` for an
  anchor-only EAV body) rather than the deepest `TableReferenceNode`. This closed a latent prereq gap:
  the anchor-only path's scope is registered on the FROM `AliasNode`, not the inner table ref, so the
  old walk returned an unscoped node and raised `no-base-lineage`.

## Validation

- `yarn workspace @quereus/quereus run build` — clean.
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus test` — **5287 passing, 9 pending, 0 failing** (was 5283; +4 review tests).

## Review findings

**Process:** read the implement diff (decomposition.ts, backward-body.ts, both spec files, both docs)
with fresh eyes before the handoff summary; verified the `__vmupd_keys` substrate, the columnar
analogues, and the `findBodySource` change; ran the full suite, lint, build; and exercised the
implementation with throwaway adversarial runtime probes for the gaps the handoff flagged.

**Correctness (no bugs found).** Adversarial probes all returned correct results:
- **Pre-mutation cross-attribute both-sides** `set p = q + 1, q = p + 1 where id = 1` → p=13, q=12
  (each reads the *other* attribute's pre-mutation value — the capture-pre-mutation invariant holds
  for EAV, not a sequential read-after-write).
- **Two captured attrs in one statement** `set p = p + 1, q = q + 1` → independent srcN, no collision.
- **Embedded subquery value** `set p = (select max(val) from pivot)` → 21 (a genuinely non-self
  arbitrary value rides the capture).
- **NOT-NULL pivot value column** `set p = q + 1` over a matched triple whose captured value is null →
  raises `NOT NULL constraint failed` atomically, triple unchanged (reject-don't-widen holds).
- **Mixed columnar + EAV members in one statement** `set c = c + 1, p = p + a` → c=101, p=1010; the
  single `__vmupd_keys` carrier holds both members' srcN without collision (columnar keys
  `cap:<rel>:<col>`, EAV keys `cap:<rel>:attr:<attr>`).

**`findBodySource` regression check (gap #2 — the broadest change).** Confirmed safe. `outputScopes`
is populated in exactly two places (`select.ts` `buildFrom` line 608 on the FROM relation, `buildJoin`
line 698 on the `JoinNode`); `ProjectNode`/`FilterNode` are never registered. So the new "first scoped
node from root" walk returns the **same** outermost `JoinNode` for every columnar/join body (no
behavior change) and the FROM `AliasNode` (correct) for the anchor-only EAV body the old walk broke on.
Full suite green (columnar/surrogate/multi-member capture tests all pass) corroborates no regression.

**Minor findings — fixed inline this pass:**
- *Gap #1 (NOT-NULL pivot value column untested + undocumented for EAV).* Added a test asserting the
  captured-null-on-matched write over a NOT-NULL pivot value column raises atomically with the prior
  value intact, and a `docs/lens.md` § Current limitations bullet documenting the boundary as the EAV
  analogue of the captured optional-columnar invisible-row boundary.
- *Gap #4 (mixed columnar + EAV in one statement — only covered indirectly).* Added a combined-fixture
  test (one decomposition with an optional columnar member and an EAV pivot, both captured in one
  `update`) pinning the no-carrier-collision behavior.
- Added a both-sides pre-mutation test (`set p = q + 1, q = p + 1`) and an embedded-subquery test to
  pin the strongest correctness guarantees, which the implement tests did not cover.

**Not filed (gap #3 — no EAV captured fuzz arm).** The `property.spec` EAV PutGet oracle exercises
`insert`/`delete`/`update-p`/`update-p-null` plus an explicit captured self-reference accept; a fuzz
arm modeling the matched-null-on-absent / materialize-on-non-null semantics would add parity with the
columnar fuzz arms but no new correctness coverage beyond the deterministic accept tests now present.
Left as a documented, non-blocking nicety rather than a new ticket.

**Docs.** `docs/lens.md`, `docs/view-updateability.md`, and the spec header comments were read in full
and reflect the new reality (EAV arbitrary values supported, only structural rejects remain); added the
NOT-NULL EAV boundary bullet noted above. No stale references to the retired EAV-arbitrary deferral.

**Residual rejects (unchanged, structural).** Writing a logical column the EAV pivot does not back
(`no-inverse`/unbacked), the shared-key (identity) write, composite key, and the non-anchor/subquery
WHERE predicate gate (`unsupported-decomposition-predicate`) all stay rejected. The view image is
never widened.
