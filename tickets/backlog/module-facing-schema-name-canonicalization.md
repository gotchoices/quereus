----
description: Module-facing vtab calls still receive the raw statement spelling of schema/object names — decide whether they should get canonical stored names like everything else
files:
  - packages/quereus/src/schema/manager.ts        # createIndex → vtabModule.createIndex(db, targetSchemaName, tableName, …); dropIndex → module.dropIndex(db, schemaName, …); importTable → module.connect(…, targetSchemaName, …)
  - packages/quereus-store/src/common/store-module.ts  # store keys derived from these args
----

# Module-facing schema/object names are raw, not canonical

Since `schema-event-name-casing-invalidation-misses`, the engine has a stated
naming contract (`SchemaManager.canonicalSchemaName`, docs/schema.md § Schema
Change Events): stored `schemaName` on tables/views/MVs is canonical
(lowercase), and every schema-change emitter fires stored names. One surface
was deliberately left out of that pass: arguments handed to virtual-table
modules.

- `SchemaManager.createIndex` calls `vtabModule.createIndex(db,
  targetSchemaName, tableName, indexSchema)` with the raw statement spelling
  of both schema and table (e.g. `MAIN`, `T`).
- `SchemaManager.dropIndex` calls `module.dropIndex(db, schemaName,
  ownerTable.name, indexName)` with the raw schema qualifier and the raw
  index spelling.
- `SchemaManager.importTable` calls `module.connect(…, targetSchemaName, …)`
  with the raw spelling from the persisted DDL (in practice canonical, since
  the DDL generator renders stored names — but not guaranteed by type or
  contract).

## Why it matters

A module that keys its own storage/registries by these arguments can end up
with create-time keys that differ in case from later canonical references
(events, stored schemas, other module calls). The store plugin has already
had one registry-keying bug in this neighborhood (its dropIndex registry
after a lens rename, fixed in triage 2026-06-10).

## Expectation to settle

Either:
1. Modules always receive canonical stored names (canonicalize at every
   module-call frontier in SchemaManager), and module authors may key by the
   arguments verbatim; or
2. Module-facing names are explicitly documented as "as-spelled", and module
   implementations (store, leveldb, indexeddb, …) must case-fold their own
   keys.

Option 1 matches the engine-wide convention but has store-keying blast
radius (existing persisted keys may carry old casing); audit
`quereus-store`'s key derivation before changing call args. Whatever the
choice, document it in docs/module-authoring.md.
