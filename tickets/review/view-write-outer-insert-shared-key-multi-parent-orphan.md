description: Review the plan-time reject of a multi-source outer-join INSERT whose single shared key column spans >1 presence-gated (optional) parent — the shape that previously silently lost data and orphaned a parent. Detected as `keyGate.groups.length >= 2` in `analyzeMultiSourceInsert`; now raises `unsupported-decomposition-key`.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/mutation/mutation-diagnostic.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md
----

## What was implemented

The minted-key conditional-thread loop in `analyzeMultiSourceInsert`
(`multi-source.ts`, inside `if (needsSharedKey && suppliedKeyIndex < 0)`, now
~lines 622-656) gained a single static guard: after assembling the per-side
`groups` AND-list, if `groups.length >= 2` it raises a structured
`unsupported-decomposition-key` diagnostic instead of attaching the broken
AND-gated `keyGate`. The single-parent path (`groups.length === 1`, the shipped
`ojv2` gate) and the unconditional-key path (`groups.length === 0`) are untouched.

**Why `groups.length >= 2` is exactly the broken shape.** `groups` accumulates one
inner group per *active, presence-gated FK-parent partner the side declares an FK
onto*. Only an FK-child accumulates groups. `>= 2` therefore means one child threads
its single shared key column across ≥2 optional parents
(`cc.pr references p1(pp) references p2(qq)`, both LEFT-joined, both supplied). One
key value `K` must satisfy two FK constraints at once; a partial-supply row (one
parent's value null) nulls `pr` entirely via the AND-gate, yet the present parent
still materializes through its own presence filter — the silent-loss + orphan the
ticket describes. The condition is fully static (column-supply set + FK schema, no
per-row values), so it fires at build time like every other view-mutation reject.

The diagnostic message carries the stable substring **`single shared key`** for the
sqllogic `-- error:` assertion. The `unsupported-decomposition-key` doc comment
(`mutation-diagnostic.ts`) was broadened to name the multi-parent case alongside the
sibling composite-shared-key reject.

Docs: `docs/view-updateability.md` § Outer Joins (the inline "known gap" note at the
end of the per-row-conditional-key-thread paragraph) was flipped from "known gap" to
"rejected at plan time", and a new bullet was added to § Current limitations.

## Verification done

- `yarn workspace @quereus/quereus test --grep "93.4-view-mutation"` → 1 passing.
- Full `yarn workspace @quereus/quereus test` → **5287 passing, 9 pending, exit 0**
  (memory-backed vtab; `--bail`, so a single failure would have stopped it). The
  `ojv2` single-optional-parent FK-on block and the `skv` supplied-key block both
  still pass — no regression to the `groups.length === 1` / supplied-key paths.
- `yarn workspace @quereus/quereus typecheck` → clean.
- `eslint` on `multi-source.ts` + `mutation-diagnostic.ts` → clean.
- Store-module path (`yarn test:store`) was **not** run (memory default per AGENTS.md;
  this reject is plan-time and store-independent — no store code path is exercised).

## Test coverage (the floor — reviewer should treat as a starting point)

Added to the FK-on region of `93.4-view-mutation.sqllogic` (after `ojv2`, before
`skv`), the `mpp1`/`mpp2`/`mpc`/`mpv` fixtures:

- **Partial supply** (`insert into mpv (c, cv, pv, qv) values (2, 200, 30, null)`) →
  `-- error: single shared key`. The core regression (was: silent wrong result + orphan).
- **All-parents supplied** (`(3, 300, 30, 40)`) → same reject, asserting the documented
  v1 **over-rejection** tradeoff (the reject is static, so even a fully-supplied row
  errors).
- **No leakage** — `count(*)` over `mpp1`, `mpp2`, `mpc` all `0` after the two rejected
  inserts (no parent/child row persisted from a rejected statement).

## Known gaps / things a reviewer should probe

These are deliberate scope boundaries or untested-but-believed-correct corners. The
test set above is a floor, not a finish line:

- **Single-parent-*columns* shape is NOT covered by this reject and is only described
  in a comment, not asserted.** `insert into mpv (c, cv, pv)` (qv omitted) leaves `mpp2`
  statically inactive ⇒ `groups.length === 1` ⇒ no reject; the child's `pr` then dangles
  the (untouched) second FK and errors loudly at *runtime* under FK enforcement. This is
  pre-existing behavior (not the silent-loss bug), and I left it unasserted to avoid
  coupling to the exact `_fk_*` CHECK-violation message text. A reviewer may want to add
  a runtime-error assertion (the engine spells FK violations as
  `CHECK constraint failed: _fk_<table>_<col>` — but with two FKs on one column the
  constraint name/order is worth confirming before asserting).
- **Supplied shared key (`suppliedKeyIndex >= 0`) + multi-parent shape — not tested.**
  The new reject is inside the minted-key-only block, so a supplied-key multi-parent
  view is *not* caught here; the ticket's reasoning is that FK enforcement validates a
  partial supply loudly (the existing `skv` supplied-key precedent). I did **not** add a
  dedicated test exercising a *multi-parent* supplied key — only the single-parent `skv`
  block exists. A reviewer could add one to confirm the minted-vs-supplied boundary.
- **FK-off variant — not tested.** The reject is shape-based (pragma-independent), so it
  fires with `foreign_keys = false` too. The ticket called this optional; I covered only
  the FK-on shape (matching the plan's acceptance bar). A one-line FK-off variant would
  document pragma-independence.
- **≥3 parents and RIGHT-join mirror — not tested.** A child referencing 3 optional
  parents yields `groups.length === 3` ⇒ same reject (the message interpolates the count).
  RIGHT mirrors LEFT (routing keys off `JoinSide.preserved`, not source order). Both are
  believed correct by construction but have no explicit sanity test.
- **Static updateability surface (`view_info` / `deriveViewInfo`) still reports `mpv`
  insertable** — out of scope, consistent with every other build-time reject (e.g.
  `no-default`). Not extended here; a backlog ticket could close the gap if desired.
- **Message-substring brittleness.** The `-- error:` assertion matches `single shared
  key`, which appears in the new reject message *and* would NOT collide with the
  composite-key sibling (that says "composite shared key"). If the message is reworded,
  keep that substring or the test breaks.

## Suggested review focus

1. Confirm `groups.length >= 2` is genuinely unreachable for any *supported* shape
   (i.e. the only views that reach it are the multi-parent-orphan shape) — the plan
   ticket argued the distinct-FK-columns sibling is already rejected upstream as a
   composite shared key in `extractJoinKeyColumns`; verify that upstream reject actually
   pre-empts the cases we'd want to keep.
2. Sanity-check that the reject fires for side index 0 first (the FK-child) and that no
   earlier reject (`assertNoMissingNotNull`, etc.) would mask it with a less precise
   message.
3. Decide whether the over-rejection (all-parents-supplied also errors) is acceptable
   for v1 or warrants a follow-up `fix`/`backlog` ticket for the per-parent-key-columns
   generalization (Option 3 in the source plan).
