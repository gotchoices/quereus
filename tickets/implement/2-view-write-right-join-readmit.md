description: Re-admit RIGHT joins into view write-through recognition now that the runtime executes them — restore the `right` branch in collectJoinSources / isDecomposableJoinBody, flip the static view_info/column_info surfaces from conservative all-NO to the per-side LEFT-mirror shape, and add dynamic write coverage. FULL write-through stays conservative (no preserved anchor — separable, out of scope).
prereq: outer-join-right-full-runtime
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/test/logic/06.3.4-view-info.sqllogic, packages/quereus/test/logic/06.3.5-column-info.sqllogic, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/property.spec.ts, docs/view-updateability.md
----

## Why

With the runtime able to execute a RIGHT join (prereq `outer-join-right-full-runtime`), a
RIGHT-join view is now both **readable** and (for the statically-expressible cases) **writable** —
its preserved/non-preserved classification is the exact mirror of LEFT (the **right** of a
`right` is preserved, the **left** is non-preserved). RIGHT was excluded from write-through
*only* because the body could not execute; that reason is gone.

The recognition layer reads the **raw view AST** (`view.selectAst`, still spelling `'right'`),
not a normalized plan — so re-admission is an explicit join-type allowance, not something the
runtime change grants for free. (`analyzeJoinView` plans the body via `analyzeBodyLineage`, but
the gate `isJoinBody`/`isDecomposableJoinBody`/`collectJoinSources` inspect the raw AST. The
prereq took the nested-loop emit path with no AST rewrite, so the AST still says `right`.)

**FULL write-through stays conservative** and is *not* in scope: every FULL side is
null-extended per row, so there is no static preserved anchor to key materialization off — a
FULL view reports all-`NO` and rejects writes even though FULL `select`s now work. FULL read
support and FULL write-through are separable (the prereq covers the read; FULL write-through is
a future concern, not this ticket).

## Design

### 1. Recognition — restore the `right` branch

**`collectJoinSources`** (`multi-source.ts` ~line 1149): add `right` to `acceptedType`, update
the diagnostic message to `INNER/LEFT/RIGHT/FULL`, and restore the `case 'right'` recursion as
the mirror of `left`:

```
case 'right':
  visit(fc.left, true, guardsWith);     // left of RIGHT is non-preserved (null-extended)
  visit(fc.right, nonPreserved, guards); // right of RIGHT is preserved
  break;
```

**`isDecomposableJoinBody`** (`multi-source.ts` ~line 266): add `'right'` to the `accepted`
join-type set (the boolean AST shadow of `collectJoinSources`). Keep the `condition || columns`
guard.

Update the surrounding comments (which currently document RIGHT's exclusion and point here) to
state RIGHT is now admitted; keep the note that FULL has no preserved side.

The per-column `null-extended` lineage that drives routing comes from
`deriveJoinUpdateLineage` (already correct for `right` — left side wrapped null-extended), so the
UPDATE/DELETE/INSERT routing, the FULL preserved-anchor reject (`hasPreservedSide`), and the
deferred non-preserved-update (`unsupported-outer-join-update`) all fall out unchanged once the
sides are classified. No new per-op logic — only the join-type gate widens.

### 2. Static surfaces — flip from conservative to per-side

`deriveViewInfo` / `deriveColumnInfo` (`func/builtins/schema.ts`) gate on
`isJoinBody && !isDecomposableJoinBody` (the `unsupportedJoinShape` short-circuit) and otherwise
read per-column lineage with a `hasPreservedBase` anchor check. Once step 1 makes a RIGHT body
decomposable, these surfaces automatically:

- stop reporting the RIGHT view conservative all-`NO` (it is no longer `unsupportedJoinShape`),
- report the **preserved** (right-of-`right`) columns `is_updatable = YES` with their base trace,
- report the **non-preserved** (left-of-`right`) columns `YES` too **when a preserved anchor
  exists** (the matched-update / null-extended-insert materialization, same as LEFT), and
- report `is_insertable_into` / `is_deletable = YES` (preserved anchor present).

So **no code change is required in `schema.ts`** beyond the comment updates that currently say
"RIGHT excluded" — verify by test that the per-side shape appears. (If a test reveals the
surfaces still short-circuit RIGHT, the cause is an over-tight gate; fix it there, but the
expectation is the lineage path already handles it symmetrically.)

### 3. Test surfaces — flip and extend

- **`06.3.4-view-info.sqllogic`** (~lines 255-269, the `oj_right` block): flip the expected
  `view_info('oj_right')` row from all-`NO`/`[]` to the per-side shape. `oj_right` is
  `select a.av as av, b.bid as bid, b.bv as bv from oj_a a right join oj_b b on b.bid = a.aid`
  — here `oj_b` (right) is **preserved**, `oj_a` (left) is **non-preserved**. Expect
  `is_insertable_into=YES`, `is_updatable=YES`, `is_deletable=YES`,
  `effective_targets=["oj_a","oj_b"]`. Replace the `-- error: cannot write through view` on the
  `update oj_right set bv='z' where bid=1` with the real accepted write + read-back (mirror the
  `oj_left` block just above). Keep the **`oj_full`** block conservative all-`NO` and its
  `update … -- error` (FULL stays out of scope) — update its comment to "FULL still gated: no
  preserved anchor; RIGHT now admitted (see view-write-right-join-readmit)".
- **`06.3.5-column-info.sqllogic`** (after the `oj_left` block ~line 198): add a
  `column_info('oj_right')` per-side block mirroring `oj_left`: `bid`/`bv` (preserved, `oj_b`)
  `is_updatable=YES`; `av` (non-preserved, `oj_a`) `is_updatable=YES` tracing `oj_a.av` (the
  preserved anchor on `oj_b` makes the non-preserved column updatable, exactly as LEFT's `bv`).
- **`93.4-view-mutation.sqllogic`** — add an end-to-end RIGHT-join mutation block mirroring the
  existing LEFT/multi-source blocks: create a `right join` view, UPDATE the preserved side,
  UPDATE the non-preserved side (materializes via the EC join key), DELETE-to-preserved, and an
  INSERT (preserved-only and both-side). Assert read-back.
- **`property.spec.ts` § View Round-Trip Laws → multi-source** (the LEFT round-trip lives
  around lines 4647-4665, `ojv = oj_child left join oj_parent …`): add a RIGHT-join mirror
  (`select … from child right join parent on …` with the preserved side on the right) exercising
  the same round-trip laws the LEFT case does.

### 4. Docs

`docs/view-updateability.md` § Outer Joins, the "RIGHT / FULL — not yet" callout (~line 192):
finish the **write** half the prereq deferred — RIGHT is now admitted into write-through
recognition and the surfaces report it the LEFT-mirror per-side shape; FULL remains conservative
(no preserved anchor — a non-preserved update rejects `unsupported-outer-join-update`). Reframe
the callout from "RIGHT/FULL not yet" to "FULL not yet (no anchor); RIGHT admitted".

## Edge cases & interactions

- **Preserved side is the right operand** — every routing/identity-capture path that assumed
  "preserved = left" must key off the `JoinSide.preserved` flag, not source order. The substrate
  already does (routing is `preserved`-keyed, alias-keyed), so the swap should be transparent;
  add a test where the preserved side's PK is **hidden** by the projection (as the LEFT suite
  does for `tj2.id`) to confirm identity capture still reconstructs it.
- **Non-preserved-column UPDATE** — `update oj_right set av = …` (av is the non-preserved
  left side): with a preserved anchor (`oj_b`) present it materializes; without one it would
  defer — but RIGHT always has a preserved side, so it materializes. Mirror the `oj_left set bv`
  case.
- **INSERT routing** — preserved-only insert (supply only `bid`/`bv`) inserts `oj_b` and the row
  reads back null-extended on `av`; both-side insert (supply `av` too) presence-gates the
  non-preserved `oj_a` member and threads the shared key. The `analyzeMultiSourceInsert` logic is
  `preserved`-keyed already; the only new thing is the preserved side being the right operand.
  Cover both.
- **`null-extended-create-conflict`** — inserting only the non-preserved (`av`) column with no
  preserved (`bid`) anchor must still reject (`anyNonPreservedActive && !anyPreservedSupplied`).
  Mirror the LEFT reject.
- **FULL must NOT flip** — a FULL-join view (`oj_full`) must remain conservative all-`NO` and
  reject writes (`hasPreservedSide` false). Explicitly assert this stays unchanged so the RIGHT
  re-admission doesn't accidentally widen FULL.
- **Self-join RIGHT** — `a x right join a y on …`: routing is alias-keyed; the preserved/
  non-preserved split is by alias, not table name. Lower priority, but the recognition path
  already supports self-joins for inner/left; a quick read-back test guards the right variant.
- **Existence (`exists … as`) on RIGHT write-through** — if existence columns are admitted on a
  RIGHT join (the prereq makes the read flags correct), the existence-flip insert/delete routes
  on the non-preserved side as for LEFT. If existence-on-RIGHT is out of the supported write
  shape, leave it rejected and note it; do not block this ticket on it.
- **`column_info` non-preserved anchor logic** — the `hasPreservedBase` check in `schema.ts`
  must see the right-of-`right` preserved column as a non-null-extended base site; confirm
  `baseSiteOf`/`null-extended` reads agree for the swapped side.

## Tests

- Flip `06.3.4` `oj_right` block (per above); keep `oj_full` conservative.
- Add `06.3.5` `oj_right` per-side `column_info` block.
- Add `93.4` RIGHT-join end-to-end mutation block (UPDATE preserved + non-preserved, DELETE,
  INSERT preserved-only + both-side, read-backs).
- Add `property.spec.ts` RIGHT-join multi-source round-trip mirror.
- Run `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/t.log; tail -n 80 /tmp/t.log`, then
  `yarn workspace @quereus/quereus lint`.

## TODO

- `collectJoinSources`: add `right` to `acceptedType`; restore `case 'right'` recursion (left
  non-preserved, right preserved); update message + comments.
- `isDecomposableJoinBody`: add `'right'` to the accepted set; update comment.
- `schema.ts`: update the RIGHT-exclusion comments in `deriveViewInfo`/`deriveColumnInfo`;
  verify (by test) the per-side shape now appears — add code fix only if a gate still
  short-circuits RIGHT.
- Flip `06.3.4` `oj_right`; add `06.3.5` `oj_right`; add `93.4` RIGHT block; add `property.spec.ts`
  RIGHT round-trip; assert `oj_full` stays conservative.
- Finish the `docs/view-updateability.md` write half (RIGHT admitted, FULL still gated).
- Run the quereus test suite + lint.
