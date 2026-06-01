description: `column_info(name)` over-reports per-column updateability for non-inner multi-table join bodies (cross / `> 2`-table) — the same YES-when-NO class as `view-info-non-inner-join-overreport`, but at column grain and not detectable from `null-extended` lineage. Reuse the shared shape-check helper that ticket lands.
prereq: view-info-non-inner-join-overreport
files: packages/quereus/src/func/builtins/schema.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/test/logic/06.3.5-column-info.sqllogic
----

# column_info() over-reports non-inner-join multi-table bodies

`deriveColumnInfo` (`packages/quereus/src/func/builtins/schema.ts`, ~L978) is the
column-granular companion to `deriveViewInfo` and shares its weakness for
non-inner multi-table join bodies. It reads each output attribute's backward
`updateLineage` site, unwraps `null-extended`, resolves the `base` site to a
producing `TableReferenceNode`, and reports `is_updatable = 'YES'` with a
`base_table` / `base_column` trace — while `propagate()` rejects a real mutation
through the view wholesale.

The mutation substrate (`propagate()` → `isJoinBody` → `propagateMultiSource` →
`analyzeJoinView` → `collectInnerJoinSources`, in
`packages/quereus/src/planner/mutation/multi-source.ts`) accepts **only** a
single explicit two-table **inner equi-join** of plain base tables. Every other
multi-table shape is rejected. The existing `null-extended` outer-join gate
(`hasNullExtendedLineage`) does **not** catch the non-outer shapes: only
LEFT/RIGHT/FULL joins null-extend (`deriveJoinUpdateLineage`; `cross` never
null-extends), so cross / `> 2`-table bodies carry strict-`base` lineage and slip
straight through to the over-reporting path.

## Reproduction (confirmed during fix)

```sql
create table ra (aid integer primary key, av text);
create table rb (bid integer primary key, bv text);
create table rc (cid integer primary key, cv text);

-- cross join (2-table, no ON)
create view cross_v as select a.aid as aid, a.av as av, b.bv as bv
    from ra a cross join rb b;

-- 3-table inner join
create view three_v as select a.aid as aid, a.av as av, b.bv as bv, c.cv as cv
    from ra a join rb b on b.bid = a.aid join rc c on c.cid = a.aid;
```

Today `column_info('cross_v')` and `column_info('three_v')` report **every**
column `is_updatable = 'YES'` with a full base trace, e.g.
`[["aid","YES","ra","aid"],["av","YES","ra","av"],["bv","YES","rb","bv"]]`.

But the matching mutations are rejected:
- `update cross_v set av='z' where aid=1` → `cannot write through view 'cross_v':
  only INNER joins with an ON predicate are decomposable (got 'cross' without ON)`
- `update three_v set av='z' where aid=1` → `cannot write through view 'three_v':
  only a two-table join is decomposable (found 3 base tables)`

`view_info()` over-reports the same two views identically (`is_updatable='YES'`,
`effective_targets` listing all bases) — that is the prereq ticket's surface;
this ticket fixes the column-grain twin.

### Out of scope: comma / implicit joins

The sibling `view-info` ticket and the original phrasing of this one list comma
(implicit) joins as a third shape. They are **not reachable** here: the builder
rejects a multi-source comma FROM at view-creation time
(`SELECT with multiple FROM sources (joins) not supported`; bare-alias comma
lists are additionally a parse error), so a comma-join view cannot be created and
never reaches `column_info`. Do **not** add a comma-join sqllogic case — it fails
at `create view`, not at `column_info`. Note this in the test comments.

## Expected behavior

For any multi-table body the substrate's `propagate()` does not accept (cross /
`> 2`-table joins), `column_info(name)` must report **every** output column
`is_updatable = 'NO'` with `null` `base_table` / `base_column` — one row per
output column (unlike `view_info`'s single conservative row), agreeing with
`view_info()`'s conservative row and with what `propagate()` actually accepts.

The two-table inner equi-join positive case (`ms_jv` in
`06.3.5-column-info.sqllogic`) must keep reporting each column updatable with its
per-source trace. The outer-join case (`oj_left`) must keep reporting all `NO`.

## Fix approach

The faithful gate is the **AST/plan shape check** the mutation substrate runs,
not a lineage read — mirroring what `view-info-non-inner-join-overreport`
introduces. That ticket lands a shared, non-throwing shape-check helper (a
predicate over the view body's join shape mirroring `collectInnerJoinSources`'s
acceptance: a single explicit two-table inner equi-join over plain base tables)
and wires it into `deriveViewInfo`. **Reuse the same helper in
`deriveColumnInfo`** — the way `hasNullExtendedLineage` / `buildTableRefsById`
are already shared between the two derivations.

Concretely (adapt to the exact helper name/signature the prereq lands — read its
`deriveViewInfo` call site first and mirror it):

- Compute an `unsupportedJoinShape` boolean for the planned body: true when the
  body is a join body (`isJoinBody(view.selectAst)`) whose shape the helper
  rejects. Combine it with the existing `outerJoin` gate at the per-attribute
  site read in `deriveColumnInfo`:
  `const bs = (outerJoin || unsupportedJoinShape) ? undefined : baseSiteOf(...)`.
  This keeps one row per output column, all `NO`/`null`, without restructuring
  the row loop.
- The shape check rejects outer joins too (`joinType !== 'inner'`), so it likely
  **subsumes** the `hasNullExtendedLineage` / `outerJoin` gate. Whether to
  collapse the two gates into one is the implementer's call — follow whatever
  structure the prereq settled on in `deriveViewInfo` so the two surfaces stay
  parallel. If the prereq kept both gates, keep both here; if it consolidated,
  consolidate here.
- Prefer reusing the prereq's helper verbatim over re-deriving a column-grain
  variant. If the prereq placed the helper in `multi-source.ts`, export it from
  there and import into `schema.ts` (same module boundary `isJoinBody` already
  crosses for the mutation builder).

If the prereq's helper turns out to be view-level-only and genuinely not
reusable at column grain (it should be — both surfaces only need a boolean over
the same body), factor out the shared shape predicate so both call it, rather
than duplicating the AST walk. Do not hand-roll a second join-shape parser.

## Tests

Extend `packages/quereus/test/logic/06.3.5-column-info.sqllogic`, mirroring the
existing `oj_left` pattern (all-`NO` expectation paired with a real mutation
that errors):

- A **cross-join** view: `column_info` reports every column `NO` / `null`, then
  `update ... → -- error: cannot write through view`.
- A **3-table inner-join** view: same all-`NO` expectation, then a rejected
  mutation cross-check.
- Add a one-line comment noting comma/implicit joins are excluded because they
  are not buildable (see "Out of scope" above) — no test case.
- Confirm the existing `ms_jv` (two-table inner equi-join, all-`YES` with
  per-source traces) and `oj_left` (all-`NO`) cases still pass unchanged.

## Validation

- `yarn workspace @quereus/quereus test` (or run just the logic suite); the
  06.3.5 file is the focus. Stream output per AGENTS.md (`2>&1 | tee` then tail).
- `yarn workspace @quereus/quereus run typecheck`.
- Lint `packages/quereus` (single-quote globs on Windows).

## TODO

- Read the prereq's `deriveViewInfo` change in `schema.ts` (and any helper added
  to `multi-source.ts`) to learn the exact shape-check helper name/signature.
- Wire that helper into `deriveColumnInfo`: gate the per-attribute base-site read
  to `undefined` when the body is an unsupported join shape, so every output
  column emits `is_updatable='NO'` with null `base_table`/`base_column`.
- Reconcile with the existing `hasNullExtendedLineage` / `outerJoin` gate
  (consolidate or keep both, matching the prereq's `deriveViewInfo` structure).
- Add the cross-join and 3-table-join cases to `06.3.5-column-info.sqllogic`,
  each cross-checked against a rejected mutation; add the comma-join exclusion
  comment.
- Run logic tests, typecheck, and lint; confirm `ms_jv` / `oj_left` unchanged.
