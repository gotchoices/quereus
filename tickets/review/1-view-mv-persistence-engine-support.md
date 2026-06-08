description: Review the engine-side support for persisting views / materialized views — view_added/view_removed schema-change events fired from the view DDL emitters, generateViewDDL/generateMaterializedViewDDL schema→DDL helpers, and a silent createView import arm in importCatalog. Store package was intentionally NOT touched.
prereq:
files:
  - packages/quereus/src/schema/change-events.ts              # ViewAddedEvent / ViewRemovedEvent added to the union
  - packages/quereus/src/runtime/emit/create-view.ts          # fires view_added after schema.addView
  - packages/quereus/src/runtime/emit/drop-view.ts            # fires view_removed after schema.removeView
  - packages/quereus/src/schema/ddl-generator.ts              # generateViewDDL / generateMaterializedViewDDL
  - packages/quereus/src/schema/manager.ts                    # importDDL/importCatalog createView arm; views[] in result; importView()
  - packages/quereus/src/index.ts                             # exports for the new event types + generators
  - packages/quereus/test/view-mv-ddl-persistence.spec.ts     # NEW: full spec for all three deliverables
  - packages/quereus/test/index-ddl-roundtrip.spec.ts         # updated one assertion for the additive views[] field
  - docs/schema.md                                            # event table, catalog-import, DDL-generation sections updated
----

# Review: engine support for view / materialized-view persistence

## What this delivers

Three engine primitives the sibling store ticket (`store-view-mv-persistence`,
currently in plan) will consume. **No store package code was changed** — the
store consumer (`quereus-store/src/common/store-module.ts`) reads only
`.tables`/`.indexes` from `importCatalog`, so the new `.views` field is additive
and backward-compatible (confirmed: `@quereus/store` builds clean).

1. **`view_added` / `view_removed` lifecycle events.** Added to the
   `SchemaChangeEvent` union in `change-events.ts`. Fired from the **runtime
   emitters** (`emitCreateView` / `emitDropView`), NOT from `Schema.addView` /
   `removeView` — this deliberately scopes the events to user/declarative DDL and
   excludes internally-registered views (lens effective bodies register via
   `schema.addView` directly — see `lens-compiler.ts:251` — and must not be
   persisted). Mirrors how the MV emitters fire `materialized_view_added`/`_removed`.

2. **`generateViewDDL` / `generateMaterializedViewDDL`.** In `ddl-generator.ts`,
   alongside `generateTableDDL`/`generateIndexDDL`. Lift the stored schema into
   the equivalent AST and render via the shared `ast-stringify` emitters
   (`createViewToString` / `createMaterializedViewToString`) — thin, drift-free
   wrappers. Emit fully-qualified names and **live tags** (so a SET TAGS that
   leaves stored `sql` stale round-trips). MV generator omits `using` (v1 backing
   is always memory). Both are a parse→generate→parse fixed point.

3. **Silent `createView` import arm.** `importDDL` now dispatches `createView` to
   a new private `importView()` that registers the view **without planning the
   body** (validation deferred to first reference, like `importTable` defers via
   `connect`). `importCatalog`'s result gained `views: string[]`.
   `createMaterializedView` still throws fail-loud (MV rehydration re-execs the
   create store-side; not imported here).

## Validation performed

- `yarn workspace @quereus/quereus build` — clean.
- `yarn workspace @quereus/quereus test` — **5265 passing, 9 pending, 0 failing.**
- `yarn workspace @quereus/quereus lint` — clean.
- `yarn workspace @quereus/store build` — clean (additive return field tolerated).
- New spec `test/view-mv-ddl-persistence.spec.ts` — 26 passing, covering all three
  deliverables.

## Use cases / behaviors the tests pin (the reviewer's floor, not ceiling)

**Lifecycle events** (`captureEvents` helper subscribes to the notifier):
- `create view v as select 1 as a with tags (...)` → exactly one `view_added`
  carrying the live `ViewSchema` (name, schema, tags).
- `drop view v` → exactly one `view_removed` carrying `oldObject`.
- `create view if not exists <existing>` → **no** `view_added` (no-op above the notify).
- `drop view if exists <missing>` → **no** `view_removed`.

**Silent import**:
- `importCatalog(["create view v as select 1 as a, 2 as b with tags (...)"])` →
  `.views === ['main.v']`, view registered **with tags**, queryable (`select a, b
  from v`), and **no** `view_added` event (import is silent).
- A view whose body references a not-yet-imported relation (`select * from missing`)
  imports without throwing.
- A view over a later-imported view (`v_outer` before `v_inner`) imports
  order-independently and is queryable.
- `create materialized view …` through `importCatalog` still throws
  `/does not support statement type/`.

**Generator fixed point** (matrix over no-tags / single / multiple / reserved
`quereus.update.*` quoted key / explicit column list / compound-SELECT / VALUES
body, for BOTH view and MV):
- generated DDL re-parses to the right statement type;
- `gen(gen(x)) === gen(x)` (fixed point);
- name is fully qualified (`main.v`, unquoted because bare-valid — quoting is
  conditional via `quoteIdentifier`);
- MV output omits `using`;
- tags / columns / body shape survive a parse-back.

## Known gaps / things to scrutinize (work treated as a starting point)

- **Store-side persistence is out of scope** and NOT done here. `docs/schema.md`
  still states view/MV tags do not round-trip for store-backed DBs — accurate until
  the sibling store ticket lands. There is no end-to-end close→reopen→rehydrate test
  in this ticket because the store wiring does not exist yet.
- **MV rehydration via importCatalog is intentionally absent** (fail-loud). The
  deferred backlog ticket `store-mv-rehydrate-via-importcatalog` tracks the
  alternative. Confirm the fail-loud arm is the desired contract.
- **`importView` creates the schema if missing** (mirrors `importTable`, lines
  ~2425), a deviation from `importIndex`'s `getSchemaOrFail`. Chosen for
  order-independence (a schema holding only views can rehydrate). Reviewer: confirm
  this is acceptable vs. fail-loud-on-missing-schema.
- **Deferred body validation**: a structurally-broken imported view body surfaces
  only when the view is referenced, never at import. By design (order-independence),
  but means import success ≠ a valid view.
- **Generator fixed-point tests use parser-derived schema scaffolding**
  (`viewSchemaFromDDL` / `mvSchemaFromDDL` in the spec) rather than live-created
  schemas, because live MV create gates on the covering-index shape and would reject
  the compound/VALUES matrix bodies. The generators only read name/schema/columns/
  selectAst/tags, so this faithfully exercises them — but it does NOT prove the
  generators against a *live* MV schema (whose body is the optimized form). A
  reviewer may want one live `create materialized view` → `getMaterializedView` →
  `generateMaterializedViewDDL` round-trip on a gating-compliant body for extra
  confidence.
- **Tag value fidelity**: the matrix covers string / int / boolean / reserved-key
  tag values (all round-trip via `parseTagValue` → `tagValueToString`). Blob / JSON
  tag values are untested; `tagValueToString` falls back to `String(value)` for
  those, which may not round-trip — a pre-existing `ast-stringify` limitation, not
  introduced here, but worth a glance if exotic tag values are in scope.
- **`statement.ts` ignores `view_added`/`view_removed`** (they fall through the
  `if/else-if` chain to `else return`). Verified there is no exhaustive
  `switch(event.type)` with a `never` assertion over `SchemaChangeEvent` (the only
  `never` exhaustiveness check near `.type` is over `MaintenancePlan.kind` in
  `database-materialized-views.ts:624`, unrelated). Confirmed intended: a fresh
  create/drop need not invalidate cached read plans. Reviewer: confirm no consumer
  needs to react to a plain create/drop.
- **No CREATE-OR-REPLACE path exists** for plain views (an existing view without
  `IF NOT EXISTS` throws), so there is no replace-fires-view_added case to handle.
