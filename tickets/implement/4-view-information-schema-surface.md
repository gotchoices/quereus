----
description: Expose per-view updateability metadata as a `view_info()` table-valued function — `is_insertable_into`, `is_updatable`, `is_deletable`, `effective_targets` per `docs/view-updateability.md` § Information Schema Surface. A thin read-only projection over the substrate's `updateLineage` / `attributeDefaults` (threaded onto `PhysicalProperties` by `view-mutation-physical-lineage`) plus the base-table not-null/default schema; `effective_targets` is the distinct base set the substrate's `propagate()` reaches by default.
prereq: view-mutation-physical-lineage, view-mutation-substrate-orchestrator
files: packages/quereus/src/func/builtins/schema.ts, packages/quereus/src/func/builtins/index.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/runtime/emit/materialized-view-helpers.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/schema/view.ts, docs/view-updateability.md
----

Deferred out of `view-updateability-phase-1` so the core write-through machinery
reviews independently of the introspection surface. This ticket adds **only** the
read-only projection; it touches no propagation/execution path.

## Surface decision (settled — do not re-litigate)

`docs/view-updateability.md` § Information Schema Surface names the surface
`information_schema.views`. **Quereus has no `information_schema` namespace and no
registered `sqlite_schema`** — every introspection surface in the engine is a
table-valued function (`schema()`, `table_info(name)`, `foreign_key_info(name)`,
`index_info(name)`, `check_constraint_info(name)`, `unique_constraint_info(name)`,
`assertion_info()`, `function_info()` — all in `func/builtins/schema.ts`). The
`information_schema.views` name is SQL-standard *intent*; the engine-idiomatic
realization is a TVF. **This surface lands as `view_info()`**, consistent with the
existing introspection family and DRY against the established pattern. No new
schema-namespace / built-in-view subsystem is introduced.

> **Doc reconciliation (required, part of this ticket).** Update
> `docs/view-updateability.md` § Information Schema Surface so it documents the
> `view_info()` TVF as the realization (keep the SQL-standard column meanings; map
> `information_schema.views` → `view_info()`). Leave the per-column
> `information_schema.columns.is_updatable` paragraph as a forward note pointing at
> the parked backlog ticket (`view-column-updateability-surface`).

## Scope

- **In:** the four **view-level** columns over plain (non-materialized) views.
- **Out (parked):** per-column `is_updatable` (`information_schema.columns`) — see
  `tickets/backlog/view-column-updateability-surface.md`. Out because it touches the
  base-table introspection surface (`table_info`) too and is independently shippable.
- **Out:** materialized views — read-only at the user-write boundary
  (`materialized-view-core`, shipped); `view_info()` enumerates `getAllViews()` only.
  (If a later ticket wants MV rows they are trivially all-`NO`/`[]`; do not add now.)

## `view_info()` shape

A `createIntegratedTableValuedFunction` in `func/builtins/schema.ts`, registered in
the `BUILTIN_FUNCTIONS` list in `func/builtins/index.ts` next to the other
`*_info` functions. `numArgs: -1` (0-arg lists every view; optional 1-arg name
filter, mirroring `function_info`). `deterministic: false` (schema can change).

| Column | Type | Meaning |
|---|---|---|
| `schema` | TEXT not null | schema name (`main`, `temp`, …) |
| `name` | TEXT not null | view name |
| `is_insertable_into` | TEXT not null | `'YES'`/`'NO'` |
| `is_updatable` | TEXT not null | `'YES'`/`'NO'` |
| `is_deletable` | TEXT not null | `'YES'`/`'NO'` |
| `effective_targets` | TEXT not null | JSON array of base-table names (`'[]'` when none) |

`relationalAdvertisement`: `isSet: true`, key `[[{ index: 1 }]]` (view `name` unique
per row — single-schema today; if multi-schema name collisions are possible, key on
`(schema, name)` = `[[{ index: 0 }, { index: 1 }]]`). Use `'YES'`/`'NO'` text to match
the doc's SQL-standard convention; use `jsonStringify` (already imported in
`schema.ts`) for `effective_targets`.

## How each column is computed

The values are derived **statically from the planned view body's
`PhysicalProperties`** — no dry-run mutation. Per view (lazily, per `view_info()`
call — same re-plan-on-read posture as `deriveBackingShape`; caching is a later
optimization, not needed here):

1. **Plan the body.** Get the body SQL via `astToString(viewSchema.selectAst)` and
   `const plan = db.getPlan(bodySql); const root = plan.getRelations()[0];` — the
   same idiom `runtime/emit/materialized-view-helpers.ts` `deriveBackingShape` uses.
   Read `const lineage = root.physical?.updateLineage`,
   `const defaults = root.physical?.attributeDefaults`, `const keys = keysOf(root)`
   (`planner/util/fd-utils.ts`). Build a `tableId → TableReferenceNode` map by walking
   the plan (see `collectTableRefs` in `planner/analysis/binding-extractor.ts` for the
   walk shape) so `UpdateSite.table` ids resolve to base table names + schemas.
   **Wrap per-view in try/catch** — a VALUES-bodied / recursive / aggregate / set-op
   body may have no base lineage or fail to expose a writable root; emit the
   conservative all-`NO`, `'[]'` row rather than throwing (per-view, unlike
   `schemaFunc`'s single global error row).

2. **`effective_targets`** = distinct base tables reachable by default = the set of
   `UpdateSite.table` ids appearing as `kind: 'base'` (and the `inner` of
   `kind: 'null-extended'`) across `lineage`, resolved to table names, sorted for
   determinism, `jsonStringify`'d. This is the same base set the substrate's
   `propagate()` routes to by default (the source `ChangeScope` consumes) — a test
   cross-checks agreement (below).

3. **`is_updatable`** = `'YES'` iff **≥1** output attribute has `kind: 'base'`
   lineage (doc: "at least one output column has base lineage"). A wholly-computed /
   no-base-lineage body → `'NO'`.

4. **`is_insertable_into`** = `'YES'` iff **every** `not null`-without-declared-default,
   non-generated base column of **every** table in `effective_targets` has a
   recoverable value — i.e. it is either (a) the target of some output column's
   `base` `UpdateSite`, or (b) carries an `attributeDefault` entry
   (`constant-fd` / `base-default` / `tag-default`). Generated columns are excluded
   (computed/auto). If any not-null-without-default base column is neither projected
   nor defaultable → `'NO'`. (This is the static reading of the doc's insert
   default-fill chain; the substrate's `propagate()` insert path is the authoritative
   dynamic check — cross-checked by a test, not invoked here.)

5. **`is_deletable`** = `'YES'` iff the row-identifying predicate is constructible at
   **every** base in `effective_targets` — operationally, every reachable base table's
   PK columns are each the target of some output column's `base` `UpdateSite` (so
   `T.pk = <view value>` is buildable). A base that contributes columns but whose PK
   is not fully exposed through `base` lineage → `'NO'`. (`keysOf(root)` is the
   forward-key cross-check: a key the forward walk advertises must project onto each
   base's PK — assert this in a test rather than gating the column on it.)

### Non-updatable / read-only bodies

VALUES bodies, recursive CTEs, aggregates, window-only projections, set-ops not yet
propagatable → no `base` lineage at the root → naturally yield
`is_updatable='NO'`, `is_insertable_into='NO'`, `is_deletable='NO'`,
`effective_targets='[]'`. No special-casing; they fall out of the lineage read. The
surface gains accuracy as Phases 2–7 thread more lineage (per the ticket's "Out of
scope" note) — no rework needed here.

## Tests (sqllogic + spec)

Add a `view_info` sqllogic file under `packages/quereus/test/logic/` (sibling to the
`06.3-schema*` introspection tests) plus, if finer assertions are needed, a spec.

Key cases and expected outputs:

- **Identity/rename single-source view** — `create view v as select id, name from t`
  where `t(id pk, name)`:
  `is_updatable='YES'`, `is_deletable='YES'` (PK `id` exposed),
  `is_insertable_into` = `'YES'` iff `t` has no other not-null-without-default column,
  `effective_targets='["t"]'`.
- **Projected-away PK** — `create view v as select name from t`: `is_deletable='NO'`
  (PK not exposed), `is_updatable='YES'`, `effective_targets='["t"]'`.
- **Constant-FD default** — `create view greens as select name from men where color='green'`:
  insertable even though `color` is omitted (constant-FD `attributeDefault` supplies
  it) → `is_insertable_into='YES'` provided remaining not-null cols are covered.
- **Computed-only / VALUES / aggregate / recursive-CTE body** — all four → `'NO'`/`'[]'`,
  no throw.
- **Not-null-without-default base column not projected** — `is_insertable_into='NO'`.
- **Multi-source key-preserving equi-join view** (once the orchestrator lands) —
  `effective_targets` lists **both** base tables; `is_updatable='YES'`;
  `is_deletable`/`is_insertable_into` per the per-base rules above.
- **`view_info('v')` name filter** returns exactly the one row; `view_info()` lists all.

Cross-check tests (assert agreement, don't duplicate logic):

- `effective_targets` for a view equals the distinct base set the substrate's
  `propagate()` reaches for that view (ties this surface to the same source the doc
  says `effective_targets` / `ChangeScope` consume).
- For a view the forward walk advertises a key on (`keysOf(root)` non-empty),
  `is_deletable='YES'` and the advertised key projects onto each reachable base's PK.

## TODO

- [ ] Implement `viewInfoFunc` in `func/builtins/schema.ts` (helpers: plan-body +
      `tableId→name` resolution; the four-column derivation from `updateLineage` /
      `attributeDefaults` / `keysOf` + base-column not-null/default/generated flags).
- [ ] Register `viewInfoFunc` in `func/builtins/index.ts` `BUILTIN_FUNCTIONS`
      (+ the `from './schema.js'` import line) next to the other `*_info` funcs.
- [ ] Per-view try/catch → conservative all-`NO`/`'[]'` row; never throw the whole TVF.
- [ ] sqllogic test file (+ optional spec) covering the cases above incl. name filter.
- [ ] Cross-check tests: `effective_targets` vs `propagate()` base set; `keysOf` vs
      `is_deletable`.
- [ ] Reconcile `docs/view-updateability.md` § Information Schema Surface to document
      `view_info()`; keep the per-column note pointing at the backlog ticket.
- [ ] `yarn workspace @quereus/quereus test` + lint green.
