description: Multi-source outer-join INSERT whose single shared key column spans ≥2 presence-gated (optional) parents — the shape that previously silently lost data and orphaned a parent — is now rejected at plan time with `unsupported-decomposition-key` (detected as `keyGate.groups.length >= 2` in `analyzeMultiSourceInsert`). Implemented, reviewed, shipped.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/mutation/mutation-diagnostic.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md
----

## What shipped

The minted-key conditional-thread loop in `analyzeMultiSourceInsert`
(`multi-source.ts`, inside `if (needsSharedKey && suppliedKeyIndex < 0)`) gained a single
static guard: after assembling the per-side `groups` AND-list, if `groups.length >= 2` it
raises a structured `unsupported-decomposition-key` diagnostic (message substring **`single
shared key`**) instead of attaching the broken AND-gated `keyGate`.

`groups` accumulates one entry per *active, presence-gated FK-parent partner the side
declares an FK onto* — so only an FK-child accumulates, and `>= 2` means one child threads
its single shared key column across ≥2 optional parents (`cc.pr references p1(pp) references
p2(qq)`, both LEFT-joined and supplied). One key value `K` must satisfy two FK constraints
at once; a partial-supply row (one parent null) nulls `pr` entirely via the AND-gate, yet
the present parent still materializes through its own presence filter — the silent-loss +
orphan the ticket describes. The condition is fully static (column-supply set + FK schema,
no per-row values), so it fires at build time like every other view-mutation reject.

The single-parent path (`groups.length === 1`, the shipped `ojv2` gate) and the
unconditional-key path (`groups.length === 0`) are untouched. The
`unsupported-decomposition-key` reason doc comment (`mutation-diagnostic.ts`) was broadened
to name the multi-parent case alongside the sibling composite-shared-key reject. Docs
(`docs/view-updateability.md` § Outer Joins and § Current limitations) flipped the inline
"known gap" note to "rejected at plan time" and added a limitations bullet.

## Review findings

**Process:** read the implement diff (`multi-source.ts`, `mutation-diagnostic.ts`, the
93.4 sqllogic block, both doc edits) with fresh eyes before the handoff summary; traced
`groups` accumulation, `sideDeclaresFkOnto`/`fkTargetsSide`, the upstream
`extractJoinKeyColumns` EC/composite guard, and reject ordering; ran the targeted test, the
full quereus suite, typecheck, and lint.

**Correctness — no bugs found.** The `groups.length >= 2` condition is reachable only for
the targeted shape:
- *Distinct-FK-columns sibling* (`pr1 references p1, pr2 references p2`) is pre-empted
  **upstream** — the child contributes two columns to a cross-side equality, so
  `extractJoinKeyColumns` (line 814) raises the composite-shared-key `unsupported-
  decomposition-key` before the new guard runs. Confirmed (review focus #1).
- *Same column, one optional + one INNER parent* yields `groups.length === 1` (the
  always-active partner has empty `presenceGateIndices` and is skipped) → shipped single-
  parent gate, not the new reject. Correct routing.
- *Same column, ≥2 optional parents, same EC* (the bug shape) passes the upstream
  single-column / single-EC checks and reaches the guard → rejected. The guard reads
  `presenceGateIndices` populated in the prior `specByIndex` loop, so it runs after that
  loop is complete (review focus #2: ordering verified — only the FK-child accumulates
  `groups`, so regardless of `activeIndices` iteration order only the child raises, and the
  message names the child table).
- The reject is shape/schema-driven (`child.schema.foreignKeys`), independent of
  `pragma foreign_keys`.

**Minor finding — fixed inline this pass.** The implementer flagged the **FK-off variant**
as untested. Added a one-line assertion to the 93.4 block (`pragma foreign_keys = false;`
then the same multi-parent insert → `-- error: single shared key`) pinning that the reject
is pragma-independent. Full suite re-run green with it.

**Over-rejection (all-parents-supplied also rejects) — considered, not filed.** A row that
supplies *both* parents would in fact succeed (the single minted key `K` is threaded into
both parents' PKs and the child references `K`), so the static reject is conservative and
loses a working case. Narrowing it would require per-row static supply analysis (intractable
for SELECT sources), so static rejection is the right v1 call. Already named as future work
("per-parent key columns") in `docs/view-updateability.md` § Current limitations and asserted
by the `(3, 300, 30, 40)` test — no separate ticket warranted.

**Untested corners left as-is (documented in handoff, not regressions):** supplied-key
multi-parent (FK enforcement is the validator — the new guard is correctly inside the
minted-key-only block; mirrors the shipped `skv` supplied-key precedent), ≥3 parents and the
RIGHT-join mirror (both follow by construction — the message interpolates `groups.length`;
routing keys off `JoinSide.preserved`, not source order), the single-parent-*columns* shape
(`groups.length === 1` → loud runtime FK error, pre-existing, not the silent-loss bug), and
the static `view_info` insertable surface (unchanged, consistent with every build-time
reject e.g. `no-default`). None are correctness regressions introduced by this change.

**Docs.** Both `view-updateability.md` edits read accurately; a grep for stale "known gap" /
multi-parent / orphan references found only the two edited locations. `93.2-view-mutation-
pending.sqllogic` does not catalog the sibling composite-key reject either, so the 93.4
placement (beside the `ojv2` FK-on and `skv` supplied-key blocks) is correct and consistent.

**Verification.**
- `yarn workspace @quereus/quereus test --grep "93.4-view-mutation"` → 1 passing.
- Full `yarn workspace @quereus/quereus test` → **5287 passing, 9 pending, exit 0** (`--bail`),
  including the added FK-off assertion. No regression to `ojv2` (single-optional-parent) or
  `skv` (supplied-key) blocks.
- `yarn workspace @quereus/quereus typecheck` → clean.
- `eslint` on `multi-source.ts` + `mutation-diagnostic.ts` → clean.
- Store-module path not run (plan-time reject, store-independent; memory default per AGENTS.md).
