----
description: Cached-plan invalidation misses when schema/object name casing differs between stored schema objects and change-event payloads — verified for CREATE INDEX (raw table name in `table_modified`) and for views created with a case-differing schema qualifier (stored raw vs canonical-firing tag emitters).
files:
  - packages/quereus/src/schema/manager.ts                          # createIndex (~2069: raw targetSchemaName + raw tableName), updateIndexTags → commitTagUpdate (~690: raw targetSchemaName)
  - packages/quereus/src/core/statement.ts                          # listener compares dep.schemaName/objectName to event fields exactly (~176-180)
  - packages/quereus/src/planner/building/create-view.ts            # stores stmt.view.schema || 'main' verbatim into the plan/ViewSchema
  - packages/quereus/src/planner/building/materialized-view.ts      # same raw stmt.view.schema for MV create
  - packages/quereus/src/runtime/emit/create-view.ts                # registers ViewSchema with the raw plan.schemaName
  - packages/quereus/src/schema/manager.ts                          # buildTableSchemaFromAST (~1554) stores raw stmt.table.schema into TableSchema.schemaName
  - packages/quereus/test/plan/view-dependency-invalidation.spec.ts # existing pins for the view/MV ALTER-side fix; pattern to extend
----

# Cached-plan invalidation misses from inconsistent name casing in schema change events

`Statement.compile()` invalidates its cached plan when a schema change event
matches a recorded dependency, comparing `dep.schemaName === event.schemaName`
and `dep.objectName === event.objectName` **exactly** (statement.ts ~176-180).
Plan dependencies record the **stored** names off the resolved schema object
(`tableSchema.schemaName` / `.name`, `view.schemaName` / `.name`). Any event
emitter that fires a name with different casing than the stored value silently
fails to invalidate — a stale plan keeps serving.

The convention (established by `view-dependency-invalidation-unit-coverage`,
which fixed `updateViewTags` / `updateMaterializedViewTags` to fire canonical
`schema.name` + stored `updated.name`) is **canonicalize at the emitter, keep
the listener compare exact**. The remaining call sites are not yet consistent
with it, and the CREATE-side stored values are not canonical either, so
"canonical at the emitter" and "stored on the dep" can still diverge.

## Verified reproductions (both fail today, mocha + chai, fresh `Database`)

**1. CREATE INDEX fires raw names — case-differing table name misses:**

```ts
await db.exec('create table t (id integer primary key, x integer)');
const stmt = db.prepare('select x from t where x = 5');
const p1 = stmt.compile();
await db.exec('create index idx1 on t (x)');   // invalidates (control passes)
const p2 = stmt.compile();                      // !== p1 ✓
await db.exec('create index idx2 on T (x)');   // raw 'T' fired as objectName
stmt.compile();                                 // === p2 ✗ should have invalidated
```

`createIndex` (manager.ts ~2069) fires `schemaName: targetSchemaName,
objectName: tableName` — both raw from the CREATE INDEX statement, not the
stored `updatedTableSchema.schemaName` / `.name`. Consequence: a cached read
plan does not re-optimize to consider the new index until something else
invalidates it.

**2. A view created with a case-differing schema qualifier never invalidates:**

```ts
await db.exec(`create table t (id integer primary key);
               create view MAIN.v as select id from t;`);   // stores schemaName 'MAIN'
const stmt = db.prepare('insert into v (id) values (1)');
const p1 = stmt.compile();
await db.exec(`alter view v set tags (display_name = 'x')`); // fires canonical 'main'
stmt.compile();                                               // === p1 ✗ should have invalidated
```

`buildCreateViewStmt` stores `stmt.view.schema || 'main'` verbatim and the
create-view emitter registers it as-is, so the dep records `'MAIN'` while the
(fixed) tag emitters fire canonical `'main'`. Tag validation re-runs at plan
time, so this is the same correctness regime the view fix addressed: a
newly-added invalid tag must surface on the next run of a cached write-through
statement, and here it never does.

## Same mechanism, unverified (audit during fix)

- `ALTER INDEX … TAGS` → `updateIndexTags` → `commitTagUpdate` (manager.ts
  ~1037 → ~690) receives the raw `plan.schemaName` from the ALTER statement
  (emit/set-object-tags.ts passes it verbatim), so `alter index MAIN.idx set
  tags (…)` fires `schemaName: 'MAIN'` and misses. (`objectName` there is the
  stored owning-table name — fine.)
- `create table MAIN.t` stores raw `'MAIN'` in `TableSchema.schemaName`
  (`buildTableSchemaFromAST` ~1554). The `ALTER TABLE … TAGS` path is
  self-consistent (the runtime passes the **stored** `tableSchema.schemaName`
  through — see `runSetTableTags`, alter-table.ts ~897 — so dep and event agree
  whatever the stored casing), but any emitter that fires the *canonical* or
  *raw-ALTER* name against a raw-stored dep diverges. Other `notifyChange` call
  sites (drop/rename paths in emit/alter-table.ts, emit/add-constraint.ts,
  emit/analyze.ts, materialized-view-helpers.ts) should be swept for which name
  they fire vs. what deps record.

## Expected behavior / fix shape

Dep recording, stored schema objects, and event payloads must agree on one
casing. The robust resolution is to **canonicalize the stored `schemaName` at
create/import time** (store the canonical `Schema.name` — the lookup is already
case-insensitive via `schemas.get(name.toLowerCase())`) for tables, views, and
MVs, and have **every emitter fire the stored names** of the object it swapped.
Once stored names are canonical, "stored" and "canonical" coincide and the
already-fixed view/MV tag emitters need no rework. Per-emitter patching without
canonicalizing the stored side leaves the verified repro 2 class open.

Both repros above should become regression tests (plan-identity pattern of
`test/plan/view-dependency-invalidation.spec.ts`), plus an `ALTER INDEX
MAIN.idx … TAGS` case.

Severity context: requires case-differing schema qualifiers or table-name
casing in DDL — uncommon (only `main`/`temp` exist by default), but silent
when hit, and repro 1 (raw object name in CREATE INDEX) needs no schema
qualifier at all.
