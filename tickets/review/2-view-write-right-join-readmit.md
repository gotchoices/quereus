description: Review the re-admission of RIGHT joins into view write-through recognition — recognition gate widened to accept `right` (mirror of LEFT), static surfaces report the per-side LEFT-mirror shape, dynamic write coverage added. FULL stays conservative (out of scope). Verify the per-side routing, the surfaces' agreement with `propagate()`, and the honestly-flagged untested RIGHT boundaries below.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/test/logic/06.3.4-view-info.sqllogic, packages/quereus/test/logic/06.3.5-column-info.sqllogic, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/property.spec.ts, docs/view-updateability.md
----

## What landed

With the runtime now executing RIGHT joins (prereq `outer-join-right-full-runtime`), a
RIGHT-join view is readable, and its preserved/non-preserved classification is the exact
**mirror** of LEFT (the **right** operand of a `right` is preserved; the **left** is
null-extended). RIGHT was excluded from write-through *only* because the body could not
execute — that reason is gone, so this ticket re-admits RIGHT into recognition. **FULL
write-through remains out of scope** (no preserved anchor; FULL self-conservatizes).

### Recognition (the only functional code change) — `multi-source.ts`

- `collectJoinSources` (~L1179): `acceptedType` now includes `'right'`; the diagnostic
  message reads `INNER/LEFT/RIGHT/FULL`; a new `case 'right'` recursion mirrors `left`
  with the operands swapped — `visit(fc.left, true, guardsWith)` (left non-preserved,
  guarded) and `visit(fc.right, nonPreserved, guards)` (right preserved).
- `isDecomposableJoinBody` (~L288): the boolean AST shadow now accepts `'right'`.
- Doc comments (top-of-file, both function docstrings, the inline notes) reframed from
  "RIGHT excluded" to "RIGHT admitted, mirror of LEFT; FULL still conservative".

No other per-op logic changed: `deriveJoinUpdateLineage` (`analysis/update-lineage.ts`)
**already** handled `case 'right'` (left side wrapped `null-extended`, right preserved), so
UPDATE/DELETE/INSERT routing, the FULL preserved-anchor reject (`hasPreservedSide`), and the
deferred non-preserved cases all fall out once the sides are classified.

### Static surfaces — `schema.ts` (comment-only change)

`deriveViewInfo` / `deriveColumnInfo` gate on `isJoinBody && !isDecomposableJoinBody` and
otherwise read per-column `null-extended` lineage with a `hasPreservedBase` / `preservedTargets`
anchor check. Once step 1 makes a RIGHT body decomposable these surfaces report the per-side
shape **with no code change** — confirmed by test. Only the stale "RIGHT excluded" comments
were updated (incl. the now-reachable "RIGHT never reaches here" note in `deriveViewInfo`).

### Docs — `view-updateability.md`

§ Outer Joins callout reframed to "RIGHT — admitted; FULL — not yet"; the "Shipped (LEFT)"
header → "Shipped (LEFT & RIGHT)"; the "Current limitations" RIGHT clause rewritten (RIGHT
now write-through-able; only FULL stays conservative).

## How to validate (use cases)

All green locally (see "Verification" below). The reviewer should re-run and scrutinize:

- **`06.3.4-view-info.sqllogic`** `oj_right` block (now flipped): `oj_a a right join oj_b b
  on b.bid = a.aid` — `oj_b` (right) preserved, `oj_a` (left) non-preserved. Asserts
  `is_insertable_into=YES, is_updatable=YES, is_deletable=YES,
  effective_targets=["oj_a","oj_b"]`, plus a real preserved-side (`bv`) update and a
  non-preserved-side (`av`) update that **materializes** `oj_a(aid=2)` via the EC join key
  (`aid = bid`). **`oj_full` deliberately stays conservative all-`NO`** and still rejects —
  confirm the RIGHT re-admission did not widen FULL.
- **`06.3.5-column-info.sqllogic`** `oj_right` per-side block: `bid`/`bv` (preserved, `oj_b`)
  and `av` (non-preserved, `oj_a`) all `is_updatable=YES`, `av` tracing `oj_a.av` (the
  preserved `oj_b` anchor makes the non-preserved column updatable).
- **`93.4-view-mutation.sqllogic`** end-to-end RIGHT block (`rojv`, the FK-parent/child
  mirror of the LEFT `ojv` block): preserved-side update, **matched** non-preserved update,
  **null-extended materialization** via a concrete dangling key (cc=5), both-side insert
  (minted shared key), preserved-only insert (null-extended read-back), non-preserved-only
  insert reject (`null-extended-create-conflict`), delete-to-preserved — all with read-back.
  Plus two edge-case blocks: **preserved-PK-hidden** RIGHT (`hpv` — identity reconstructed
  from the body though `oj_b.bid` is unprojected) and **self-join RIGHT** (`rsjv` — alias-keyed
  preserved/non-preserved split, read-back + preserved-side update).
- **`property.spec.ts` → View Round-Trip Laws → multi-source**: new test
  *"outer (right) join: preserved write-through + presence-gated optional member round-trips"*
  — the RIGHT mirror of the LEFT round-trip (`rj_parent p right join rj_child c …`, child on
  the right = preserved). Checks plan-lineage kinds (cc/cv `base`, pv `null-extended`),
  `view_info`/`column_info` per-side agreement, the non-preserved-only insert reject,
  delete-to-preserved, and the PutGet/GetPut insert/update/delete round-trip laws.

## Known gaps / what to scrutinize (tests are a floor)

- **FULL write-through** is intentionally NOT implemented (separable future concern). FULL
  read works; FULL write rejects and surfaces report all-`NO`. Verify nothing flipped FULL.
- **Existence (`exists … as`) columns on RIGHT write-through are UNTESTED here.** The read
  flags are correct (prereq); the write router keys off `existenceSide`/`preserved`, so a
  RIGHT existence-flip *should* route like LEFT, but there is no RIGHT existence test. The
  ticket explicitly allowed leaving this out — flag if the reviewer wants it pinned (a
  follow-up fix ticket if it misbehaves).
- **RIGHT non-preserved-update boundaries are only partially asserted for RIGHT directly.**
  93.4 covers the matched case and the concrete-dangling-key materialization. NOT directly
  asserted for RIGHT (covered for LEFT, and the substrate is `preserved`-keyed/symmetric, so
  they *should* hold): the **null-join-key no-op** boundary, the **NOT NULL non-preserved**
  reject, and the **composite non-preserved join key** reject (`unsupported-outer-join-update`).
  If the reviewer wants parity, mirror the LEFT *"non-preserved-side update materializes
  matched + null-extended rows"* property test for RIGHT.
- **RETURNING through a RIGHT view is untested.** LEFT non-preserved-update RETURNING rejects
  `returning-through-view`; RIGHT should be identical but is unasserted.
- **Self-join RIGHT** covers read + preserved-side update only (no non-preserved-side update
  on a self-join RIGHT).

## Verification (all passed locally, Windows)

- `yarn workspace @quereus/quereus typecheck` → clean (exit 0).
- Targeted: `mocha logic.spec.ts --grep "File: (06.3.4|06.3.5|93.4)"` → 3 passing;
  `mocha property.spec.ts --grep "outer (right|left) join|self-join"` → 7 passing.
- Full suite: `yarn workspace @quereus/quereus test` → **5116 passing, 9 pending, 0 failing**.
- `yarn workspace @quereus/quereus lint` → clean (exit 0).

No pre-existing failures surfaced; no `.pre-existing-error.md` written.
