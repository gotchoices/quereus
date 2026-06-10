----
description: Unqualified DDL lands objects in the CURRENT schema but unqualified reads resolve via schema_path (default main, temp) which ignores the current schema — objects created under a non-main current schema are invisible to unqualified references
files:
  - packages/quereus/src/schema/manager.ts                       # getCurrentSchemaName/setCurrentSchema; _findTable default search order
  - packages/quereus/src/planner/building/schema-resolution.ts   # resolveTableSchema search-path resolution
  - packages/quereus/src/core/database.ts                        # schema_path option plumbing
----

# Current-schema vs schema_path resolution split

Two different defaults govern unqualified names:

- **DDL landing**: `create table t` / `create view v` / `create index` /
  `drop table` / `drop view` / `drop index` / `alter … tags` all resolve an
  unqualified name against `SchemaManager.getCurrentSchemaName()`.
- **Read resolution**: an unqualified table reference in a query body
  resolves via `ctx.schemaPath` (the `schema_path` option), and when unset
  via the hardcoded default search order `main`, then `temp`
  (`SchemaManager._findTable`). The current schema is NOT consulted.

Consequence (observable today, current schema is settable via the
`setCurrentSchema` API only):

```ts
db.schemaManager.addSchema('aux');
db.schemaManager.setCurrentSchema('aux');
await db.exec(`create table t (id integer primary key)`); // lands in aux ✓
await db.exec(`select * from t`); // ERROR: Table 't' not found in schema path: main
```

The created object is invisible to unqualified reads unless the user also
sets `pragma schema_path` or qualifies every reference. The same applies to
a view body: `create view v as select id from t` fails at plan time even
though `t` was just created in the same (current) schema.

## Question to settle

Should the current schema be implicitly first in the default search path
(SQLite-style: unqualified resolution starts at the connection's default
schema)? Or is `schema_path` the single read-side authority, in which case
`setCurrentSchema` should probably also prepend/update the path — or the
split should be explicitly documented in docs/schema.md and docs/sql.md
(§ name resolution), which currently describe the default as "typically
`main`" without mentioning the DDL/read asymmetry.

Note: there is currently no SQL surface to change the current schema
(API-only), so this is latent for pure-SQL users; it bites embedders using
`setCurrentSchema`.
