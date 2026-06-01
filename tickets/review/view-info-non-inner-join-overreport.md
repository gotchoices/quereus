description: Review the view_info() non-inner-join over-report fix — view-grain gate on the shared AST join-shape predicate. Verify view_info reports the conservative all-`NO`/`[]` row for cross / `> 2`-table / comma join bodies (agreeing with what propagate() accepts) while the two-table inner equi-join (`ms_jv`) and outer-join cases are unchanged. Confirm it reuses `isDecomposableJoinBody` (shared with column_info), not a second join-shape parser.
files: packages/quereus/src/func/builtins/schema.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/test/logic/06.3.4-view-info.sqllogic, docs/view-updateability.md
----

# Review: view_info() over-reports non-inner-join multi-table bodies

## What the bug was

`deriveViewInfo` (`func/builtins/schema.ts`) walked the planned body's root
`updateLineage`, resolved each `base` site to a producing `TableReferenceNode`,
and reported `is_updatable = 'YES'` with both tables in `effective_targets` — even
for **cross joins** and **`> 2`-table inner joins**, which `propagate()`
(`propagateMultiSource` / `collectInnerJoinSources`) rejects wholesale. The
pre-existing `null-extended` (outer-join, Divergence 2) gate does **not** catch
these: only LEFT/RIGHT/FULL joins null-extend, so cross / `> 2`-table bodies carry
strict-`base` lineage and slipped straight through. Confirmed empirically before
the fix: `view_info('<cross-join-view>')` returned
`is_updatable='YES', effective_targets='["ra","rb"]'` while a real
`update` through it errored `cannot write through view`.

## What changed

**Reused the shared shape predicate — no new parser.** The column-info ticket
(`column-info-non-inner-join-overreport`, which ran first, out of order) already
created and exported `isDecomposableJoinBody(selectAst)` in
`planner/mutation/multi-source.ts` — the non-throwing boolean shadow of the
throwing `collectInnerJoinSources` (`true` iff a single explicit two-table INNER
join with an ON predicate over two distinct plain base tables). It was already
imported into `schema.ts` and wired into `deriveColumnInfo`. This ticket wires the
**same** helper into `deriveViewInfo` (the original ticket assumed the helper still
needed creating; it didn't — so this is the DRY outcome the column-info review
asked for, both surfaces calling one predicate).

**Gate wired into `deriveViewInfo`.** Right after the Divergence-2 outer-join
gate, a parallel early-return:

```ts
if (isJoinBody(view.selectAst) && !isDecomposableJoinBody(view.selectAst)) {
    return CONSERVATIVE_VIEW_INFO;
}
```

Same polarity and structure as `deriveColumnInfo`'s
`unsupportedJoinShape` (one reads the AST shape, `hasNullExtendedLineage` reads
lineage — kept as parallel defense-in-depth). The two-table inner equi-join
(`ms_jv`) is not a match (`isDecomposableJoinBody` accepts it) and stays
`is_updatable='YES'`.

**Docs.** No change needed — `docs/view-updateability.md` § Divergence 3 (added by
the column-info ticket) already describes the gate for *both* surfaces ("Both
surfaces therefore also gate on a non-throwing AST shape check…"). This ticket
makes that already-written claim true for `view_info` too.

**Tests.** `06.3.4-view-info.sqllogic` gains a "Divergence 3" section:
`xj_cross` (2-table cross join) and `xj_three` (3-table inner join) — each
asserts the conservative all-`NO`/`[]` row, each cross-checked against a rejected
mutation (`-- error: cannot write through view`). Plus a **positive** cross-check
added to the existing `ms_jv` section: `update ms_jv set note='x' where cid=999`
runs without error (no row matches → clean no-op), proving the two-table inner
join stays writable. The comma/implicit-join exclusion is documented in-file.

## ⚠️ Honest gaps / things to scrutinize

1. **Comma/implicit joins are gated defensively but UNtestable — not just
   "rejected at create-view time" as the column-info note claimed.** The actual
   mechanism (verified empirically): a comma FROM (`from a, b`) either fails to
   *parse* (with aliases) or is rejected by `buildSelectStmt` with "SELECT with
   multiple FROM sources (joins) not supported" (without aliases). So a comma-join
   view body never produces a successful plan — `deriveViewInfo`'s `_buildPlan`
   throws and the per-view try/catch returns the conservative row **regardless of
   my gate**. The gate (`isDecomposableJoinBody` requires a single JOIN FROM) would
   catch it if that ever became plannable, but today it is dead-but-correct
   defense-in-depth, not the load-bearing path. No sqllogic case (no buildable
   view). If the reviewer wants the column-info in-file note corrected to match
   this finding (it says "the builder rejects multiple FROM sources" — true, but
   the parse-error path with aliases is the more common failure), that is a
   one-line doc nicety, out of scope here.

2. **Self-joins gated but untested.** `isDecomposableJoinBody` rejects a two-table
   same-table join (mirroring `collectInnerJoinSources`), so a self-join view's
   `view_info` now reports conservative — correct, agreeing with `propagate()`, but
   no sqllogic case covers it (same gap the column-info review flagged). Worth a
   case if the reviewer wants the floor raised.

3. **DISTINCT / LIMIT / OFFSET join bodies are NOT gated here.** The shape check is
   join-*shape* only. `propagate()` separately rejects `distinct` / `limit` join
   bodies (`analyzeJoinView`), but `deriveViewInfo` does not — so a
   `select distinct … from a join b on …` view would still over-report. This is an
   orthogonal divergence (it also affects the single-source spine and `column_info`)
   and out of scope; flagged as a potential follow-up, not fixed here.

4. **Equi-join condition not validated.** Like `collectInnerJoinSources`, the
   predicate only requires an ON condition to be *present*, not specifically
   `a.col = b.col`. A non-equi two-table inner join passes both the shape check and
   `collectInnerJoinSources`, so the surfaces stay consistent with what
   `propagate()` accepts — intentional, but confirm it is the desired contract.

5. **`is_insertable_into` / `is_deletable` over-report was latent, not just
   `is_updatable`.** The pre-fix cross-join row happened to read
   `is_insertable_into='NO', is_deletable='NO'` (PK not exposed / not-null
   unrecoverable), so only `is_updatable='YES'` was visibly wrong in that fixture.
   But the conservative short-circuit correctly zeroes all four columns; a
   different cross/`>2`-table shape (all PKs + nullable columns exposed) could have
   over-reported insertable/deletable too. The tests assert all four are `NO`.

## Use cases / how to validate

- **Cross join:** `create view xj_cross as select a.aid, a.av, b.bv from xj_a a cross join xj_b b;`
  → `view_info('xj_cross')` = all-`NO`/`[]`; `update xj_cross set av='z' where aid=1`
  errors `cannot write through view … got 'cross'` (or "without ON").
- **3-table inner join:** `… from xj_a a join xj_b b on … join xj_c c on …` →
  `view_info('xj_three')` = all-`NO`/`[]`; update errors `… found 3 base tables`.
- **Regression (must stay unchanged):** `ms_jv` (two-table inner equi-join) still
  `is_updatable='YES'`, `effective_targets=["ms_child","ms_parent"]`, and accepts a
  routed update; `oj_left`/`oj_right`/`oj_full` (outer joins) still all-`NO`;
  identity / rename / projected-away-PK / constant-FD / default_for / computed /
  VALUES / aggregate / recursive-CTE / correlated-subquery cases unchanged.
- **Cross-surface consistency:** `view_info('xj_cross')` and
  `column_info('xj_cross')` now agree (both conservative); before this ticket,
  `column_info` was already correct but `view_info` over-reported.

## Validation run

- `node test-runner.mjs --grep "06.3.4-view-info"` — passing.
- `node test-runner.mjs --grep "06.3.5-column-info"` — passing (unchanged).
- Targeted view/mutation/join family (06.3.4, 06.3.5, 08-views, 08.1-view-edge-cases,
  93.1–93.4, 93-ddl-view-edge-cases, 46-mutation-context, 51/53.1 MVs, 11.2-comma-join,
  90.5-unsupported-join-types, 11-joins) — 15 files passing.
- `node test-runner.mjs` (full quereus suite) — 4243 passing, 9 pending, 0 failing.
- `yarn workspace @quereus/quereus run typecheck` — clean.
- `yarn lint` (in `packages/quereus`) — clean.
- Pre/post-gate diff verified by `git stash` of the schema.ts hunk: pre-gate
  `view_info('<cross>')` = `is_updatable='YES', effective_targets='["ra","rb"]'`;
  post-gate = conservative all-`NO`/`[]`.
