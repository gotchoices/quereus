description: Review of schema management (catalog, tables, views, functions, assertions)
files:
  packages/quereus/src/schema/assertion.ts
  packages/quereus/src/schema/catalog.ts
  packages/quereus/src/schema/change-events.ts
  packages/quereus/src/schema/column.ts
  packages/quereus/src/schema/declared-schema-manager.ts
  packages/quereus/src/schema/function.ts
  packages/quereus/src/schema/manager.ts
  packages/quereus/src/schema/schema.ts
  packages/quereus/src/schema/schema-differ.ts
  packages/quereus/src/schema/schema-hasher.ts
  packages/quereus/src/schema/table.ts
  packages/quereus/src/schema/view.ts
  packages/quereus/src/schema/window-function.ts
----
## Findings

### defect: generateTableDDL produces syntactically incorrect DDL for temporary tables
file: packages/quereus/src/schema/catalog.ts:156
The DDL generator produced `CREATE TABLE TEMP "name"` instead of `CREATE TEMP TABLE "name"`.
Ticket: fixed in review

### defect: clearAll() and removeSchema() don't clear assertions
file: packages/quereus/src/schema/manager.ts:486, packages/quereus/src/schema/schema.ts
Schema had no `clearAssertions()` method, and `clearAll()`/`removeSchema()` left assertions in place.
Ticket: fixed in review

### defect: computeSchemaDiff and generateMigrationDDL ignore assertions
file: packages/quereus/src/schema/schema-differ.ts
SchemaDiff has assertion fields but they're never populated or used.
Ticket: tickets/fix/3-schema-differ-missing-assertions.md

### defect: isWindowFunctionSchema type guard can never return true
file: packages/quereus/src/schema/function.ts:164
WindowFunctionSchema is indistinguishable from ScalarFunctionSchema at runtime.
Ticket: tickets/fix/function-window-schema-type-guard-broken.md

### defect: findColumnPKDefinition ignores DESC direction for non-INTEGER PKs
file: packages/quereus/src/schema/table.ts:477
Only INTEGER columns get `desc: true`; all other types have DESC silently ignored. Also, `autoIncrement` is set for all INTEGER PKs regardless of explicit AUTOINCREMENT declaration.
Ticket: tickets/fix/3-table-pk-desc-integer-only.md

### smell: generateMigrationDDL uses unquoted identifiers; applyTableDefaults has unguarded JSON.parse
file: packages/quereus/src/schema/schema-differ.ts:155,254
Ticket: tickets/fix/schema-differ-unquoted-names-json-parse.md

### smell: dropView doesn't emit any change event
file: packages/quereus/src/schema/manager.ts:477
Tables emit `table_removed` on drop, but views emit nothing. No view event types exist in SchemaChangeEvent.
Ticket: note — design gap, no view events in the change event system.

### smell: Duplicate WindowFunctionSchema type names
file: packages/quereus/src/schema/function.ts, packages/quereus/src/schema/window-function.ts
Two different interfaces with the same name serve different purposes.
Ticket: tickets/fix/function-window-schema-type-guard-broken.md (combined)

## Trivial Fixes Applied
- catalog.ts:156-162 — Fixed TEMP keyword placement in `generateTableDDL`: `CREATE TEMP TABLE` instead of `CREATE TABLE TEMP`
- schema.ts:219 — Fixed misleading JSDoc on `clearFunctions` (removed "calling destructors if needed")
- schema.ts — Added `clearAssertions()` method
- manager.ts:486 — Added `schema.clearAssertions()` call to `clearAll()`
- manager.ts:269 — Added `schema.clearAssertions()` call to `removeSchema()`
- table.ts:126-139 — Fixed inconsistent switch case indentation in `columnDefToSchema`
- table.ts:260 — Removed stale `primaryKey` property from `createBasicSchema` (not in TableSchema interface)

## No Issues Found
- assertion.ts — clean
- change-events.ts — clean, well-typed event system with proper listener error isolation
- column.ts — clean
- declared-schema-manager.ts — clean, consistent case-insensitive lookups
- schema-hasher.ts — clean
- view.ts — clean
