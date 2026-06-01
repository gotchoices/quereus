description: Ship per-column updateability (`information_schema.columns.is_updatable` per `docs/view-updateability.md` § Information Schema Surface) as a new `column_info(name)` TVF covering every column of every base table and plain view — the column-granular companion to the view-level `view_info()` surface.
files: packages/quereus/src/func/builtins/schema.ts, packages/quereus/src/func/builtins/index.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/test/logic/06.3.4-view-info.sqllogic, docs/view-updateability.md
effort: medium
----

## Surface decision (settled at plan time)

**Ship a dedicated `column_info(name)` TVF — do NOT extend `table_info`.**

The plan ticket left the choice open ("extend `table_info` with `is_updatable`, or
a dedicated `column_info(name)`"). The deciding asymmetry:

- `table_info(name)` resolves **base tables only** — it reads `db._findTable(name)`
  (a `TableSchema` from `Schema.tables`). Views live in a **separate** map
  (`Schema.views` / `getView` / `getAllViews`) and are **not** returned by
  `_findTable` (see `src/schema/schema.ts`, `src/schema/manager.ts` `_findTable`).
  `table_info('a_view')` throws `Table 'a_view' not found` today.
- The doc requires per-column updateability for **every view and base table**. To
  satisfy that by extending `table_info`, `table_info` would have to grow a whole
  second path that resolves a view, plans its body, and **synthesizes** every
  per-column metadata field it emits (`notnull` / `pk` / `dflt_value` / `collation`
  / `generated`) from the planned body's output type — none of which a view carries
  directly. That is exactly the "too coupling" case the plan ticket flagged.
- A dedicated `column_info(name)` resolves **either** a base table **or** a view and
  emits only the column-granular updateability facts, uniformly. It mirrors the
  shipped `view_info()` (the view-level companion) one-to-one: `view_info : schema()`
  :: `column_info : table_info`. It also churns **zero** existing `table_info`
  goldens.

So `column_info(name)` is the single column-granular updateability surface for both
tables and views. `table_info` is left untouched.

## `column_info(name)` shape

Required single name argument (`numArgs: 1`), matching the `table_info` family.
Resolves a base table first (`_findTable`), then a plain view; throws
`'<name>' not found` when neither matches (parity with `table_info` on an unknown
name — note this differs from `view_info()`'s empty-on-unknown-filter, because
`view_info` takes an *optional* filter whereas `column_info` takes a *required*
target).

| Column | Type | Meaning |
|---|---|---|
| `schema` | TEXT not null | schema name (`main`, `temp`, …) the object resolved in. |
| `name` | TEXT not null | the table / view name. |
| `cid` | INTEGER not null | column ordinal (0-based). Base table: column index. View: output-attribute index. Matches `table_info.cid` for base tables. |
| `column_name` | TEXT not null | the column's output name (the view's alias spelling for a renamed view column). |
| `is_updatable` | TEXT not null | `'YES'` if a write to this column propagates to a base column (a `base` `UpdateSite`); `'NO'` if read-only (computed / generated / null-extended-without-base). SQL-standard `'YES'`/`'NO'` text — consistent with `information_schema.columns.is_updatable` and the shipped `view_info` flags, **not** `table_info`'s integer 0/1. |
| `base_table` | TEXT null | owning base-table name for a `base` column; `null` for a read-only column. The per-column trace companion to `view_info.effective_targets`. |
| `base_column` | TEXT null | owning base-column name for a `base` column; `null` for a read-only column. |

`relationalAdvertisement`: `isSet: true`, key `[[{ index: 2 }]]` (`cid` is unique per
emitted row — one object's columns per call).

## Derivation

Reuse the lineage substrate `view_info` already reads (landed via
`view-mutation-physical-lineage`): `updateLineage?: ReadonlyMap<AttributeId, UpdateSite>`
on `PhysicalProperties`, and the file-local helpers already in `schema.ts`
(`baseSiteOf`, `collectBodyNodes`, the `tableRefsById` construction in
`deriveViewInfo`). No new planner state.

**Base table** (`_findTable(name)` hit) — every non-generated column is trivially
`base` (doc § Update Site Model / § Interaction with Constraints: "Generated columns
are `computed` lineage … read-only"). Per column `i`:
- `cid = i`, `column_name = col.name`.
- `is_updatable = !col.generated` → `'YES'`/`'NO'`.
- `base_table = name`, `base_column = col.name` when updatable; both `null` when generated.

**Plain view** (`getView(name)` hit) — plan the body **logically** the same way
`deriveViewInfo` does (`db._buildPlan([view.selectAst])`, `root = plan.getRelations()[0]`),
**not** `getPlan`: the logical Project/Filter/Join/TableReference tree threads
`updateLineage`, whereas the optimizer degrades a join's top-node lineage to
`computed` (docs § surface authority). Build `tableRefsById` over `collectBodyNodes(root)`.
For each `root.getAttributes()[i]`:
- `cid = i`, `column_name = attr.name`.
- `site = root.physical?.updateLineage?.get(attr.id)`; `bs = baseSiteOf(site)`
  (unwraps `null-extended` to the inner `base`; returns `undefined` for `computed`).
- `is_updatable = bs ? 'YES' : 'NO'`.
- When `bs`: `base_table = tableRefsById.get(bs.table)?.tableSchema.name`,
  `base_column = bs.baseColumn`. Else both `null`. (If a `base` site's id has no
  resolved `TableReferenceNode` — should not happen — emit `'NO'` / `null`,
  matching `deriveViewInfo`'s conservative fallback.)
- If `root` is absent (body did not plan) or has no attributes: emit nothing and,
  per-view, fall through the try/catch to yield no rows for that object (logged) —
  the same conservative posture `view_info` takes, but at row-granularity there is
  no all-`NO` row to emit, so a body that yields no relational output yields no
  `column_info` rows.

**Schema resolution.** `_findTable(name)` already follows the main→temp search
order. For the view fallback, search `db.schemaManager._getAllSchemas()` for the
first `getView(name)` hit (prefer `main`, then `temp`, then attached — mirror
`_findTable`'s order so a qualified-elsewhere view resolves deterministically).
Capture the resolving schema's name for the `schema` column.

**Materialized views** are not enumerable here: an MV name resolves to neither a
`getView` hit (MVs live in `materializedViews`) nor — by its user-facing name — a
`_findTable` hit (the backing table is the reserved `_mv_<name>`). So
`column_info('an_mv')` throws not-found, consistent with `view_info` excluding MVs
(read-only at the write boundary). Document; do not special-case.

## Why this is low-risk

Every value is derived **statically** from the planned body's backward
`updateLineage` plus base-column `generated` flags — no dry-run mutation, no new
planner pass, no new node type. The view path is `deriveViewInfo` minus the
spine-wide defaultable walk (which only `is_insertable_into` needs); the base path
is a one-line `!generated` read. The surface gains accuracy automatically as later
phases thread more lineage (a join's top node already degrades to `computed`, so a
view column fed by an un-threaded operator reads `'NO'` — the conservative, honest
reading), with no rework here.

## Tests (TDD targets)

New sqllogic `test/logic/06.3.5-column-info.sqllogic` (model on `06.3.4-view-info.sqllogic`):

- **Base table, all updatable.** `create table t (id integer primary key, name text)`
  → `column_info('t')` yields 2 rows, both `is_updatable='YES'`,
  `base_table='t'`, `base_column` = self, `cid` 0/1.
- **Base table with a generated column.**
  `create table g (id integer primary key, a integer, b integer generated always as (a + 1))`
  → `b`'s row is `is_updatable='NO'`, `base_table`/`base_column` `null`; `id`/`a` are `'YES'`.
  (Confirms the `generated`-flag read; check the generated-column SQL form the parser
  accepts — see existing generated-column tests / `table_info` `generated` golden.)
- **Identity view.** `create view v_identity as select id, name from t` → both columns
  `'YES'` with `base_table='t'`, `base_column` = `id`/`name`.
- **Rename view.** `select id as user_id, name as full_name from t` → `column_name`
  is `user_id`/`full_name`, `base_column` is `id`/`name` (the alias renames the output,
  the trace keeps the base column).
- **Computed column among passthroughs.**
  `create view cv as select name, name || '!' as banner from t` → `name` row `'YES'`
  (`base_table='t'`), `banner` row `'NO'` (`base_table`/`base_column` `null`).
- **Multi-source inner join** (reuse `ms_parent`/`ms_child`/`ms_jv` from `06.3.4`):
  `cid`/`note` rows trace to `ms_child`, `label` row to `ms_parent`, all `'YES'`.
- **Wholly read-only bodies** (VALUES, aggregate): each output column `is_updatable='NO'`,
  `base_table`/`base_column` `null` (rows are still emitted — one per output column —
  unlike `view_info`'s single conservative row).
- **Unknown name** throws (mirror `table_info`): `select * from column_info('nope')` errors.
- **Name filter cardinality.** `select count(*) from column_info('t')` → 2.

Optional spec cross-check in `test/quereus/` (mirror `view-info.spec.ts` style, only
if cheap): for a base table, the count of `is_updatable='YES'` rows equals the count
of non-generated columns; for the join view, each `'YES'` row's `base_table` is a
member of `view_info(view).effective_targets`.

## Docs

Update `docs/view-updateability.md` § Information Schema Surface:
- Replace the "Per-column updateability (parked)" blockquote (currently pointing at
  `tickets/backlog/view-column-updateability-surface.md`) with the **shipped**
  `column_info(name)` description: its shape table, the `base_table`/`base_column`
  trace, the base-table-`!generated` / view-`updateLineage` derivation, and the
  `'YES'`/`'NO'` (not 0/1) encoding rationale.
- Add `column_info(name)` to the § Implementation Surface bullet for
  `src/func/builtins/schema.ts` alongside `view_info()`.
- Note the rejected `table_info`-extension alternative and why (table_info is
  base-table-only; extending it to views over-couples it to body planning).

## TODO

- Add `columnInfoFunc` to `src/func/builtins/schema.ts`: the TVF definition (shape
  above) plus a `deriveColumnInfo(db, name)` helper returning the per-column rows for
  a base table or view. Reuse `baseSiteOf` / `collectBodyNodes`; factor the
  `tableRefsById` build out of `deriveViewInfo` into a tiny shared helper if it reads
  cleaner (optional — both live in this one file).
- Register `columnInfoFunc` in `src/func/builtins/index.ts` (import from `./schema.js`,
  add to `BUILTIN_FUNCTIONS` next to `viewInfoFunc`).
- Decide generated-column `base_column`: `null` (read-only ⇒ no base write target).
  Keep consistent: any `is_updatable='NO'` row has `null` base_table/base_column.
- Write `test/logic/06.3.5-column-info.sqllogic` per the targets above.
- Run `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/ci.log; tail -n 60 /tmp/ci.log`
  and `yarn workspace @quereus/quereus run lint` (single-quote globs on Windows).
- Update `docs/view-updateability.md` per § Docs above.
