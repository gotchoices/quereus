description: Re-admitted RIGHT joins into view write-through recognition (mirror of LEFT — right operand preserved, left null-extended). Recognition gate widened to accept `right`; static surfaces and dynamic write routing fall out of the existing `preserved`-keyed substrate with no per-op change. FULL stays conservative (out of scope). Reviewed, fixed minor findings inline, all green.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/test/logic/06.3.4-view-info.sqllogic, packages/quereus/test/logic/06.3.5-column-info.sqllogic, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/property.spec.ts, docs/view-updateability.md
----

## What landed (implement)

With the runtime now executing RIGHT joins (prereq `outer-join-right-full-runtime`), a
RIGHT-join view is readable and its preserved/non-preserved classification is the exact
**mirror** of LEFT (the **right** operand of a `right` is preserved, the **left** is
null-extended). RIGHT had been excluded from write-through only because the body could not
execute; that reason is gone, so this ticket re-admits RIGHT into recognition.

The only functional change is in **recognition** (`multi-source.ts`):
- `collectJoinSources`, `isDecomposableJoinBody`, and the diagnostic message accept `'right'`.
- A new `case 'right'` mirrors `left` with the operands swapped: `visit(fc.left, true, guardsWith)`
  (left non-preserved, guarded) and `visit(fc.right, nonPreserved, guards)` (right preserved).

No per-op logic changed: `deriveJoinUpdateLineage` (`analysis/update-lineage.ts`) already
handled `case 'right'`, and the whole UPDATE/DELETE/INSERT substrate keys off
`JoinSide.preserved`, never source order — so routing, the FULL preserved-anchor reject, and
the deferred non-preserved cases all fall out once the sides are classified. The static
`view_info` / `column_info` surfaces report the per-side shape with no code change. **FULL
write-through remains out of scope** (no preserved anchor; FULL self-conservatizes).

## Review findings

**Verdict: sound.** The RIGHT recursion is a clean, correct mirror of LEFT; the
preserved-keyed substrate makes every downstream op (matched/materialize update, NOT NULL /
composite / RETURNING rejects, existence-flip, delete-to-preserved, insert routing)
source-order-independent, so RIGHT exercises the identical code once classification is
correct — which it is. Findings below were all **minor**, fixed inline. No major findings;
no new fix/plan/backlog tickets filed.

### Aspect-by-aspect

- **Correctness / routing (verified):** `collectJoinSources` `case 'right'` mirrors `left`
  exactly (preserved-side propagates the enclosing classification + unchanged guards;
  non-preserved side forced `true` + the join's ON predicate as guard). `deriveJoinUpdateLineage`
  already classifies `right` (left null-extended, right preserved). Confirmed by source read +
  swept every `joinType`/`'right'`/`preserved` branch in the mutation path — the only
  type-aware sites are the two classifiers; the rest is `preserved`-keyed.
- **Type safety:** `yarn typecheck` clean (exit 0) before and after edits.
- **DRY / modular / maintainable:** no duplication introduced; RIGHT rides the existing
  substrate. Good.
- **Resource cleanup / performance:** N/A — recognition-time AST classification only; no new
  runtime, allocation, or I/O.
- **Tests (implementer's were a solid floor):** `06.3.4` (`oj_right` flipped to per-side YES +
  preserved/non-preserved updates, `oj_full` still all-`NO`), `06.3.5` (per-column),
  `93.4` (end-to-end RIGHT block + preserved-PK-hidden + self-join RIGHT), and a `property.spec.ts`
  RIGHT round-trip test all pass and faithfully mirror the LEFT cases. FULL confirmed unchanged.

### Findings & dispositions

1. **[minor, fixed] Stale inline comment contradicting the code** —
   `multi-source.ts` `collectJoinSources` carried a comment block (just above the
   `acceptedType` line) still reading *"RIGHT is **excluded** … admitting RIGHT here would
   make the static surfaces advertise … before the per-side routing exists"* — directly
   contradicting the line below it that now admits `'right'`. The implementer reframed the
   other doc comments but missed this one. Rewrote it to describe the admitted mirror.

2. **[minor, fixed] Coverage gap the handoff itself flagged — RIGHT non-preserved-update
   boundaries** — 93.4 covered the matched + concrete-dangling-key cases for RIGHT, but the
   null-join-key **no-op**, the **NOT NULL** `null-extended-create-conflict`, the **composite**
   non-preserved key `unsupported-outer-join-update`, and **RETURNING** `returning-through-view`
   were asserted for LEFT only. Although the substrate is provably `preserved`-keyed (so these
   *should* hold for RIGHT), I added a direct RIGHT mirror of the LEFT
   *"non-preserved-side update materializes matched + null-extended rows"* property test
   (`property.spec.ts`). It pins all four boundaries for RIGHT directly — green. This closes
   handoff gaps "RIGHT non-preserved-update boundaries" and "RETURNING through a RIGHT view".

3. **[minor, fixed] Two stale doc paragraphs in `view-updateability.md`** (predating even the
   LEFT work, now actively wrong about RIGHT) — the **Outer-join contract** (`view_info`) and
   the `column_info` gates paragraph both claimed any LEFT/RIGHT/FULL outer-join body yields
   the conservative all-`NO` row and referenced **`collectInnerJoinSources`**, a symbol that no
   longer exists (the function is `collectJoinSources`). They also wrongly listed self-joins /
   `>2`-table joins as rejected (both are supported). Rewrote both to the implemented per-side
   reality: decomposable `inner`/`left`/`right`/`full` equi-joins report per-side; LEFT/RIGHT
   are partially writable (preserved + non-preserved columns `YES` via the preserved anchor);
   FULL self-conservatizes; non-decomposable shapes report all-`NO`.

### Checked and clean (explicitly)

- **FULL write-through** — intentionally NOT implemented; confirmed nothing widened it. FULL
  read works, FULL write rejects, surfaces report all-`NO` (`oj_full` in 06.3.4 still all-`NO`).
  Separable future concern, documented as such.
- **No other `joinType` switch in the write path missed `'right'`** — swept all of
  `src/planner/mutation` and `analysis/update-lineage.ts`; the only type-aware sites are the two
  classifiers, both correct.

### Remaining low-risk gaps (acceptable deferrals — no ticket)

These ride the exact same `preserved`/`existenceSide`-keyed substrate verified above and the
RIGHT classification is confirmed a faithful mirror, so the risk is low and no bug was found.
Not worth a follow-up ticket; recorded here for honesty:

- **Existence (`exists … as`) columns on RIGHT write-through** — untested for RIGHT. The
  flag-flip path (`multi-source.ts` ~L1347) keys purely off `existenceSide` / `existenceComponent`
  / classification, never source order, so a RIGHT existence-flip routes like LEFT. Read flags
  are correct (prereq). If a future caller hits a RIGHT existence view and it misbehaves, file a
  fix ticket and mirror the LEFT `rj_ex` existence tests.
- **Self-join RIGHT non-preserved-side update** — 93.4 covers self-join RIGHT read +
  preserved-side update only. Alias-keyed routing is the same substrate; non-preserved-side
  self-join RIGHT is unasserted but expected to behave as the matched/materialize path does
  elsewhere.

## Verification (all passed locally, Windows)

- `yarn workspace @quereus/quereus typecheck` → clean (exit 0), before and after edits.
- `yarn workspace @quereus/quereus lint` → clean (exit 0).
- Targeted: `06.3.4 / 06.3.5 / 93.4` logic → 3 passing; RIGHT/LEFT/self-join property tests →
  green; new RIGHT non-preserved-update test → passing.
- Full suite: `yarn workspace @quereus/quereus test` → **5117 passing** (+1, the new RIGHT
  non-preserved-update test), 9 pending, **0 failing**.
- No pre-existing failures surfaced; no `.pre-existing-error.md` written. (Note: the editor
  flagged three TS diagnostics in `property.spec.ts` at lines 210/249/1457 — all unchanged at
  HEAD, outside this diff, and not caught by the project `typecheck`; left untouched as
  pre-existing and out of scope.)
