description: Review the column_info() non-inner-join over-report fix — column-grain gate on the shared AST join-shape predicate. Verify column_info reports all-`NO`/`null` for cross / `> 2`-table / self-join bodies (agreeing with what propagate() accepts) while the two-table inner equi-join and outer-join cases are unchanged.
prereq: view-info-non-inner-join-overreport
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/test/logic/06.3.5-column-info.sqllogic, docs/view-updateability.md
----

# Review: column_info() over-reports non-inner-join multi-table bodies

## What the bug was

`deriveColumnInfo` (`func/builtins/schema.ts`) read each output attribute's
backward `updateLineage` site, unwrapped `null-extended`, resolved the `base`
site to a producing `TableReferenceNode`, and reported `is_updatable = 'YES'`
with a base trace — even for **cross joins** and **`> 2`-table joins**, which
`propagate()` rejects wholesale. The existing `null-extended` (outer-join) gate
does **not** catch these: only LEFT/RIGHT/FULL joins null-extend, so cross /
`> 2`-table bodies carry strict-`base` lineage and slipped straight through.

## What changed

**Shared shape predicate (new).** `isDecomposableJoinBody(selectAst)` in
`planner/mutation/multi-source.ts` — a **non-throwing** AST shape check, the
boolean shadow of the substrate's throwing `collectInnerJoinSources`. Returns
`true` iff the body is a single explicit two-table INNER join with an ON
predicate over two distinct plain base tables (the exact shape `propagate()`
decomposes). Cross / outer / `> 2`-table / subquery-source / self-join → `false`.

**Gate wired into `deriveColumnInfo` only.** A new
`unsupportedJoinShape = isJoinBody(view.selectAst) && !isDecomposableJoinBody(view.selectAst)`
is combined with the pre-existing `outerJoin` lineage gate at the per-attribute
site read: `const bs = (outerJoin || unsupportedJoinShape) ? undefined : baseSiteOf(...)`.
This keeps one row per output column, all `NO`/`null`, without restructuring the
row loop. Both gates are kept as parallel defense-in-depth (one reads lineage,
one reads the AST); the shape check subsumes the outer-join case for join bodies.

**Docs.** `docs/view-updateability.md` § `column_info` gains a "Non-inner-join
shape gate (Divergence 3)" paragraph next to the existing Divergence 2 note.

**Tests.** `06.3.5-column-info.sqllogic` gains `cross_v` (2-table cross) and
`three_v` (3-table inner) — each all-`NO`/`null`, each cross-checked against a
rejected mutation (`-- error: cannot write through view`). The comma/implicit
join exclusion is documented in-file (not buildable → no case).

## ⚠️ Honest gaps / things to scrutinize

1. **The prereq did NOT land before this ticket ran.** `view-info-non-inner-join-overreport`
   was still in `tickets/implement/` when this ran; the shared helper it was
   meant to land **did not exist**. Per this ticket's documented fallback
   ("factor out the shared shape predicate so both call it … do not hand-roll a
   second join-shape parser"), **this ticket created `isDecomposableJoinBody`**
   in the location the ticket predicted (`multi-source.ts`, exported) and wired
   it into `deriveColumnInfo` **only**. **`deriveViewInfo` is deliberately left
   untouched** — that is the prereq's remaining job (wire the same helper into
   `deriveViewInfo` + add `06.3.4-view-info.sqllogic` cases). The `prereq:`
   header on this review ticket holds it until view-info clears, so the reviewer
   sees both surfaces consolidated.
   - **Consequence to verify:** until the prereq lands, `view_info('cross_v')` /
     `view_info('three_v')` **still over-report `is_updatable='YES'`**. So the
     ticket's "agrees with view_info()'s conservative row" is only half-true
     right now — `column_info` is correct; `view_info` is not yet. Confirm the
     prereq actually reuses `isDecomposableJoinBody` (not a second predicate) so
     the two surfaces stay parallel. If the prereq chose a different
     name/location/polarity, reconcile.

2. **Self-joins are now gated but untested.** `isDecomposableJoinBody` rejects a
   two-table same-table join (mirroring `collectInnerJoinSources`), so a
   self-join view's `column_info` now reports all-`NO` — a correct side effect
   agreeing with `propagate()`, but **no sqllogic case covers it**. Worth a
   case if the reviewer wants the floor raised.

3. **DISTINCT / LIMIT / OFFSET join bodies are NOT gated here.** The shape check
   is join-*shape* only; `propagate()` separately rejects `distinct` / `limit`
   join bodies (`analyzeJoinView`), but `deriveColumnInfo` does not. A
   `select distinct … from a join b on …` view would still over-report. This is
   an orthogonal divergence (it also affects the single-source spine) and out of
   this ticket's scope — flagged as a potential follow-up, not fixed here.

4. **Equi-join condition is not validated.** Like `collectInnerJoinSources`,
   the predicate only requires an ON condition to be *present*, not specifically
   `a.col = b.col`. A non-equi two-table inner join passes both the shape check
   and (for update/delete) `collectInnerJoinSources`, so the surfaces stay
   consistent with what `propagate()` accepts — intentional, but confirm it is
   the desired contract.

## Use cases / how to validate

- **Cross join:** `create view cross_v as select a.aid, a.av, b.bv from ra a cross join rb b;`
  → `column_info('cross_v')` every column `NO`/`null`; `update cross_v set av='z' …`
  errors `cannot write through view … 'cross' without ON`.
- **3-table inner join:** `… from ra a join rb b on … join rc c on …` →
  `column_info('three_v')` every column `NO`/`null`; update errors
  `… found 3 base tables`.
- **Regression (must stay unchanged):** `ms_jv` (two-table inner equi-join) still
  all-`YES` with per-source traces; `oj_left` (LEFT join) still all-`NO`;
  base-table / identity / rename / computed / VALUES / aggregate cases unchanged.

## Validation run

- `node test-runner.mjs --grep "06.3.5"` — passing.
- `node test-runner.mjs --grep "SQL Logic Tests"` — 216 files passing.
- `node test-runner.mjs` (full quereus suite) — 4236 passing, 9 pending, 0 failing.
- `yarn workspace @quereus/quereus run typecheck` — clean.
- `yarn run lint 'src/**/*.ts'` (in `packages/quereus`) — clean.
