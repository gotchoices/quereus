description: Review the shipped `column_info(name)` TVF — the per-column updateability surface (`information_schema.columns.is_updatable`) covering every column of every base table and plain view, the column-granular companion to `view_info()`.
files: packages/quereus/src/func/builtins/schema.ts, packages/quereus/src/func/builtins/index.ts, packages/quereus/test/logic/06.3.5-column-info.sqllogic, docs/view-updateability.md
----

## What shipped

A new `column_info(name)` table-valued function in
`src/func/builtins/schema.ts`, registered in `index.ts` next to `viewInfoFunc`.
It resolves **either** a base table (`db._findTable`) **or** a plain view (first
`getView` hit across schemas, main→temp→attached) and emits one row per output
column. `table_info` was left untouched (the settled surface decision — see the
implement ticket's rationale and the doc's "Why a dedicated TVF" note).

**Emitted shape** (`numArgs: 1`, `relationalAdvertisement` key `[[{index:2}]]`
on `cid`):

| Column | Type | Meaning |
|---|---|---|
| `schema` | TEXT not null | resolving schema |
| `name` | TEXT not null | table / view name |
| `cid` | INTEGER not null | 0-based column ordinal |
| `column_name` | TEXT not null | output name (view alias spelling) |
| `is_updatable` | TEXT not null | `'YES'`/`'NO'` (not 0/1) |
| `base_table` | TEXT null | owning base table for an updatable column, else null |
| `base_column` | TEXT null | owning base column for an updatable column, else null |

**Derivation.** Base table: `is_updatable = !col.generated`; base trace = the
column itself (null when generated). View: body planned **logically** (`_buildPlan`,
not `getPlan` — same lineage-preservation reason as `deriveViewInfo`), each
output attribute's backward `updateLineage` site read via the shared
`baseSiteOf` helper; a `base` site resolving to a `TableReferenceNode` (looked up
via the newly-extracted `buildTableRefsById` helper, shared with `deriveViewInfo`)
is `'YES'` with its trace, else `'NO'`/null. No dry-run mutation, no new planner
pass.

**Error/edge posture.** Unknown name throws `'<name>' not found` (required-target
parity with `table_info`). A view body that fails to plan or yields no relational
output produces *no rows* (logged), never throws the whole TVF. Materialized
views resolve to neither path → throw not-found (consistent with `view_info`).

## Validation done

- `yarn workspace @quereus/quereus run build` (tsc) — clean.
- `yarn workspace @quereus/quereus test` — **4236 passing, 9 pending** (full suite;
  includes the new `06.3.5-column-info.sqllogic`). No `view_info` / `table_info`
  goldens churned.
- `yarn workspace @quereus/quereus run lint` — clean.

## Test coverage (the floor, not the ceiling)

`test/logic/06.3.5-column-info.sqllogic` covers: base table all-updatable; base
table with a generated column (read-only, null trace); identity view; rename view
(alias renames `column_name`, trace keeps `base_column`); computed column among
passthroughs; multi-source inner join (per-source `base_table`); wholly read-only
bodies (VALUES, aggregate — rows still emitted, one per column); unknown-name
throw; name-filter cardinality.

## Known gaps / reviewer attention

- **No outer-join short-circuit (deliberate, per the implement ticket's derivation
  spec — but worth a hard look).** Unlike `deriveViewInfo`, `deriveColumnInfo` does
  **not** short-circuit a `null-extended` (LEFT/RIGHT/FULL outer-join) body. It
  runs `baseSiteOf` per attribute, which *unwraps* `null-extended` to the inner
  `base`. So a preserved-side column of an outer-join view would report
  `is_updatable='YES'` **even though `propagate()` rejects the whole outer join
  wholesale today** — a potential YES-when-NO over-report at the column grain that
  `view_info` explicitly guards against at the view grain. The implement ticket's
  "Plain view" derivation spec says to use `baseSiteOf` directly with no gate, and
  there is **no outer-join test** in `06.3.5`. Reviewer should decide whether
  column_info should mirror `view_info`'s conservative `null-extended` gate (e.g.
  treat any attribute whose site is `null-extended` as `'NO'`, or short-circuit the
  whole object) and add a covering test. This is the highest-risk judgment call.
- **No `test/quereus/` spec cross-check.** The implement ticket listed an optional
  `view-info.spec.ts`-style cross-check (count of `'YES'` rows == non-generated
  columns; each join-view `'YES'` row's `base_table` ∈ `view_info().effective_targets`).
  Not written — the sqllogic targets were judged sufficient. Cheap to add if the
  reviewer wants the invariant locked.
- **VALUES output-column names** asserted only loosely (the VALUES case selects
  `cid`/`is_updatable`/`base_table`/`base_column`, not `column_name`, to avoid
  coupling to the `column_N` naming detail). Fine, but noted.
- **Re-plans on every call** (same posture as `deriveViewInfo` / `deriveBackingShape`).
  No caching; acceptable for an introspection surface but worth confirming.
