----
description: Canonicalize stored schemaName on tables/views/MVs and make every schema-change emitter fire the stored names of the swapped object, so cached-plan invalidation never misses on name-casing differences. All four bug repros verified live at HEAD (fix stage).
files:
  - packages/quereus/src/schema/manager.ts                          # buildTableSchemaFromAST ~1553, commitTagUpdate ~690, dropTable ~1257, createIndex ~2069, dropIndex ~2191, createTable ~2294, importView ~2510, importMaterializedView ~2553, addAssertion/removeAssertion ~285-329
  - packages/quereus/src/planner/building/create-view.ts            # buildCreateViewStmt :49 — raw stmt.view.schema || 'main'
  - packages/quereus/src/planner/building/materialized-view.ts      # buildCreateMaterializedViewStmt :22 (stored), buildRefresh :90 / buildDrop :96 (event-only)
  - packages/quereus/src/runtime/emit/create-view.ts                # ViewSchema.schemaName + view_added from plan.schemaName
  - packages/quereus/src/runtime/emit/drop-view.ts                  # view_removed fires raw plan.schemaName :58
  - packages/quereus/src/runtime/emit/materialized-view.ts          # _added/_refreshed/_removed fire raw plan.schemaName/plan.viewName :59 :136 :184
  - packages/quereus/src/core/statement.ts                          # listener exact-compare :176-180 — stays exact (convention), do not touch
  - packages/quereus/test/plan/view-dependency-invalidation.spec.ts # pattern + home for the new regression pins
----

# Canonicalize stored schema names + fire stored names from every schema-change emitter

`Statement.compile()` invalidates its cached plan when a schema-change event
matches a recorded dependency by **exact** string compare on
`dep.schemaName === event.schemaName && dep.objectName === event.objectName`
(statement.ts ~176-180). Dependencies record the **stored** names off the
resolved schema object (`tableSchema.schemaName`/`.name`,
`view.schemaName`/`.name` — see `building/schema-resolution.ts`,
`view-mutation-builder.ts:63`, `runtime/emission-context.ts`). Any emitter
firing different casing than the stored value silently fails to invalidate.

The convention (established by `view-dependency-invalidation-unit-coverage`)
is: **canonicalize at the emitter, keep the listener compare exact.** This
ticket completes it with the robust resolution: make the *stored* `schemaName`
canonical at create/import time, and have every emitter fire the *stored*
names of the object it swapped. Once stored names are canonical, "stored" and
"canonical" coincide and the already-fixed view/MV tag emitters
(`updateViewTags` :910 / `updateMaterializedViewTags` :979, which fire
`schema.name` + `updated.name`) need no rework.

## Canonical form

`Schema.name` is invariantly lowercase — every construction site lowercases
(`new Schema('main')`, `new Schema('temp')` in the SchemaManager constructor;
`new Schema(lowerName)` in `addSchema` and `getOrCreateSchema`), and
`setCurrentSchema` lowercases, so `getCurrentSchemaName()` is already
canonical. Canonicalize a raw qualifier by resolving the Schema object and
using its `.name` (e.g. `this.getSchemaOrFail(raw).name`), not by ad-hoc
`toLowerCase()` — that keeps the invariant in one place. **Object names keep
their stored display casing** (`MyView` stays `MyView`); only emitters must
fire the stored `.name` rather than the raw statement-supplied spelling.

## Verified bugs this fixes (all reproduced live at HEAD during fix stage)

1. `create index idx2 on T (x)` after `create table t` — `createIndex`
   (manager.ts :2069) fires raw `objectName: 'T'`; dep records stored `'t'`.
   Cached read plan never re-optimizes to consider the new index.
2. `create view MAIN.v …` stores `schemaName: 'MAIN'`; the canonical-firing
   tag emitters fire `'main'`, so `alter view v set tags (…)` **never**
   invalidates a cached write-through plan on that view. Same class for MVs
   (`buildCreateMaterializedViewStmt` stores raw) and for the canonical-firing
   rename-propagation emitters in emit/alter-table.ts (:1339/:1363/:1467/:1496
   fire `schema.name` + stored object name).
3. `alter index MAIN.idx set tags (…)` — emit/set-object-tags passes raw
   `plan.schemaName` → `updateIndexTags` :1037 → `commitTagUpdate` :690 fires
   raw `targetSchemaName`. Misses the stored-`'main'` table dep.
4. (New finding) `create table MAIN.t` then **unqualified**
   `create index idx1 on t (x)` — dep records stored `'MAIN'`, `createIndex`
   fires `getCurrentSchemaName()` = `'main'`. Misses with no casing in the
   CREATE INDEX statement at all.

Control verified during fix stage (must stay green): the ALTER TABLE tag path
is self-consistent today (`runSetTableTags` passes stored
`tableSchema.schemaName` through, alter-table.ts ~897-905) — a table created
as `MAIN.t` still invalidates on `alter table t set tags (…)` both before and
after this change.

## Audit results (fix-stage sweep of all `notifyChange` call sites)

Already firing stored/canonical names — no change needed, become fully
consistent once stored is canonical:
- emit/add-constraint.ts :67/:103, emit/analyze.ts :68, emit/alter-table.ts
  :179/:255/:533/:659/:707/:764/:871/:1049/:1099 (stored `tableSchema.*`),
  :1339/:1363/:1467/:1496 (canonical `schema.name` + stored object name)
- emit/materialized-view-helpers.ts :789 (`updated.schemaName`), :975
  (`mv.schemaName` + `backing.name`)
- database-materialized-views.ts :493 (`mv.schemaName` + stored backing name)
- manager.ts createBackingTable :2358 (stored `tableSchema.schemaName`)
- manager.ts updateViewTags :910 / updateMaterializedViewTags :979 (canonical
  + stored — the prior fix)

Firing raw statement-supplied names — change to the stored names of the
swapped object:
- manager.ts `createIndex` :2069-2075 → fire `updatedTableSchema.schemaName` /
  `updatedTableSchema.name`
- manager.ts `commitTagUpdate` :690-700 → fire `newSchema.schemaName` (the
  `objectName: newSchema.name` half is already stored). Covers ALTER INDEX
  TAGS and keeps table/column/constraint tag paths consistent.
- manager.ts `dropTable` :1257-1262 → fire `tableSchema.schemaName` /
  `tableSchema.name` (params are raw from emit/drop-table.ts :11-12)
- manager.ts `dropIndex` :2191-2197 → fire `ownerTable.schemaName` (the
  `objectName: ownerTable.name` half is already stored)
- manager.ts `createTable` :2294-2299 → fire `completeTableSchema.schemaName`
  / `.name` (self-consistent today, but stored is the rule)
- emit/drop-view.ts :56-61 → fire `existingView.schemaName`
- emit/materialized-view.ts :59/:136/:184 → fire `mv.schemaName` / `mv.name`
  instead of `plan.schemaName` / `plan.viewName`
- emit/create-view.ts :55-60 → becomes canonical automatically once the
  builder canonicalizes `plan.schemaName` (the ViewSchema it registers IS the
  stored object); optionally fire `viewSchema.schemaName` for uniformity

Stored-`schemaName` canonicalization points:
- manager.ts `buildTableSchemaFromAST` :1553 (covers `createTable` AND
  `importTable` — both route through it)
- planner/building/create-view.ts `buildCreateViewStmt` :49 — note it
  currently defaults to `'main'` rather than `getCurrentSchemaName()`; align
  with the other builders while here (use current schema as the default, then
  canonicalize)
- planner/building/materialized-view.ts `buildCreateMaterializedViewStmt` :22
  (flows into the MV schema and backing TableSchema via `materializeView`);
  `buildRefreshMaterializedViewStmt` :90 and `buildDropMaterializedViewStmt`
  :96 store nothing but their plan.schemaName feeds the emit/materialized-view
  events — canonicalizing at the builder fixes both ends
- manager.ts `importView` :2510 and `importMaterializedView` :2553

Out of scope / not bugs:
- The statement listener compare stays exact — every other listener already
  lowercases both sides (database-materialized-views.ts :430 + `mvKey` :2495,
  database-watchers.ts :95) or is type-only (database-assertions.ts :139,
  assertion-hoist-cache.ts :71-79).
- Assertion events (manager.ts :293/:301/:321) fire the raw `schemaName` arg,
  but no listener compares assertion names today. Cheap to canonicalize in
  `addAssertion`/`removeAssertion` (they already resolve the Schema — use
  `schema.name`); do it for consistency, no test needed.
- `emitAutoSchemaEventIfNeeded` / vtab auto schema events carry the same raw
  names to store-module persistence listeners. Aligning them with the notify
  names is harmless and keeps one truth — fold the same stored names in where
  they sit adjacent to a fixed notify (createIndex/dropIndex/createTable/
  dropTable), but do NOT chase store-side keying semantics here; if store
  tests surface a deeper keying issue, file a backlog ticket instead.

## Risk notes for the implementer

- Canonicalizing `TableSchema.schemaName`/`ViewSchema.schemaName` changes what
  introspection/error messages render for case-differing qualifiers (e.g.
  `MAIN.t` now reports `main.t`). Schema names only ever exist lowercase in
  the registry, so the stored raw casing was always a phantom — but run the
  full suite (`yarn test`) and grep failing assertions for schema-name
  literals before assuming a regression.
- `finalizeCreatedTableSchema` (manager.ts :1991) compares the module-returned
  schemaName case-insensitively and overwrites with `targetSchemaName` — after
  canonicalization it stamps the canonical name; no change needed there.
- Plan nodes (`CreateViewNode` etc.) carry the canonicalized schemaName after
  the builder change; all schema lookups are already case-insensitive
  (`schemas.get(name.toLowerCase())`), so lookup behavior is unchanged.

## Regression tests

Extend `test/plan/view-dependency-invalidation.spec.ts` (or a sibling
`schema-event-name-casing.spec.ts` if the casing pins outgrow the view file)
using its plan-identity pattern — every `!==` assert preceded by a `===`
cache-hit control so a never-caching compile cannot pass vacuously:

- `create index idx2 on T (x)` (after exact-case `idx1` control) invalidates a
  cached `select x from t where x = 5`
- `create table MAIN.t` + unqualified `create index` invalidates the cached
  read plan (bug 4)
- `create view MAIN.v` + `alter view v set tags (…)` invalidates a cached
  `insert into v …` write-through plan; mirror for
  `create materialized view MAIN.mv`
- `alter index MAIN.idx set tags (…)` invalidates (after exact-case control)
- control: `create table MAIN.t` + `alter table t set tags (…)` still
  invalidates (self-consistent stored-name path keeps working)

## TODO

- [ ] Add a small canonicalizer on SchemaManager (resolve via
      `getSchemaOrFail(raw).name`) and apply at the stored-schemaName points:
      `buildTableSchemaFromAST`, `importView`, `importMaterializedView`,
      `buildCreateViewStmt` (also switch its default from `'main'` to the
      current schema), `buildCreateMaterializedViewStmt`,
      `buildRefreshMaterializedViewStmt`, `buildDropMaterializedViewStmt`
- [ ] Switch the raw-firing emitters to the swapped object's stored names:
      `createIndex`, `commitTagUpdate`, `dropTable`, `dropIndex`,
      `createTable` in manager.ts; `drop-view.ts`, `materialized-view.ts`
      (×3), `create-view.ts` in runtime/emit
- [ ] Canonicalize the `schemaName` in `addAssertion`/`removeAssertion` events
      (use the already-resolved `schema.name`)
- [ ] Align the adjacent `emitAutoSchemaEventIfNeeded` payloads with the same
      stored names where touched (no deeper store-keying work)
- [ ] Add the regression tests listed above (plan-identity pattern with
      cache-hit controls)
- [ ] Update the now-stale "Canonical names (not the raw ALTER args)" comments
      in `updateViewTags`/`updateMaterializedViewTags` if the uniform rule
      ("emitters fire stored names; stored schemaName is canonical") lands —
      state the rule once, e.g. on the canonicalizer
- [ ] `yarn build` + `yarn test`; lint quereus. If store-path behavior is in
      doubt after the auto-event alignment, run `yarn test:store` once
- [ ] Check docs/schema.md for any schema-event naming contract worth a
      sentence on the canonical-stored-name invariant
