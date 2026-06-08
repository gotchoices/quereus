# Schema Management

The schema subsystem manages database schemas, tables, views, functions, and indexes. It coordinates virtual table module lifecycle, resolves names across multi-schema search paths, and emits typed change events.

## Key Types

### SchemaManager

Central coordinator for all schema operations. Owns the schema collection, module registry, and change notifier. One instance per `Database`.

### Schema

A named logical grouping of tables, views, functions, and assertions. Every database has at least `main` and `temp` schemas; additional schemas can be attached.

### TableSchema

Describes a table's structure: columns, primary key definition, CHECK constraints, associated virtual table module, indexes, and mutation context definitions. All tables are virtual tables — `vtabModule` and `vtabModuleName` are always present. Optional `tags` field holds arbitrary key-value metadata (see `WITH TAGS`).

### ColumnSchema

Defines a single column: name, logical type, nullability, primary key membership, default value expression, collation, and whether the column is generated. Columns default to NOT NULL (Third Manifesto) unless `pragma default_column_nullability = 'nullable'` is set. Optional `tags` field holds arbitrary key-value metadata.

### IndexSchema / IndexColumnSchema

Describes a secondary index by name and an ordered list of column references (by index into `TableSchema.columns`) with optional sort direction and collation. Optional `tags` field holds arbitrary key-value metadata.

### RowConstraintSchema

A CHECK constraint with an AST expression, an operation bitmask (insert/update/delete), and deferral settings. Optional `tags` field holds arbitrary key-value metadata.

### ViewSchema

Describes a view: name, schema, SQL text, and parsed SELECT AST. Optional `tags` field holds arbitrary key-value metadata.

## SchemaManager API

### Schema Navigation

| Method | Description |
|--------|-------------|
| `getSchema(name)` | Returns a `Schema` by name, or `undefined` |
| `getSchemaOrFail(name)` | Returns a `Schema` or throws `QuereusError` |
| `getMainSchema()` | Shorthand for the `main` schema |
| `getTempSchema()` | Shorthand for the `temp` schema |
| `getCurrentSchemaName()` | Name of the current default schema |
| `setCurrentSchema(name)` | Sets the default schema for unqualified names |
| `addSchema(name)` | Creates a new schema (e.g. for ATTACH). Throws if name conflicts |
| `removeSchema(name)` | Removes a schema (e.g. for DETACH). Cannot remove `main` or `temp` |

### Table Lookup

| Method | Description |
|--------|-------------|
| `findTable(tableName, dbName?, schemaPath?)` | Finds a table across schemas. If `dbName` is provided, searches that schema only. If `schemaPath` is provided, searches those schemas in order. Otherwise uses default search order: `main`, then `temp` |
| `getTable(schemaName, tableName)` | Retrieves a table from a specific schema |
| `getView(schemaName, viewName)` | Retrieves a view definition |
| `getSchemaItem(schemaName, itemName)` | Returns a table or view by name (views take priority on name conflict) |
| `getTableTags(tableName, schemaName?)` | Returns metadata tags for a table, or `undefined` |
| `setTableTags(tableName, tags, schemaName?)` | Sets metadata tags on a table (pass `{}` to clear) |
| `findSchemasContainingTable(tableName)` | Returns all schema names containing the table — useful for error messages |
| `findFunction(funcName, nArg)` | Finds a function by name and argument count |

### DDL Operations

#### `createTable(stmt): Promise<TableSchema>`

Creates a new table from a parsed `CreateTableStmt` AST node:
1. Resolves the virtual table module (explicit `USING` or configured default)
2. Builds column schemas, primary key definition, and CHECK constraints
3. Validates determinism of DEFAULT expressions
4. Calls `module.create()` to initialize storage
5. Registers the table in the target schema
6. Emits `table_added` change event

Throws on duplicate name (unless `IF NOT EXISTS`), missing module, or module creation failure.

#### `createIndex(stmt): Promise<void>`

Creates a secondary index from a parsed `CreateIndexStmt`:
1. Validates the target table exists and its module supports `createIndex`
2. Builds `IndexSchema` from column references
3. Delegates to `module.createIndex()`
4. Appends the index to the table's schema
5. Emits `table_modified` change event

#### `dropTable(schemaName, tableName, ifExists?): Promise<boolean>`

Drops a table:
1. Removes the table from the schema
2. Emits `table_removed` change event
3. Awaits `module.destroy()` if the module supports it, so callers see fully torn-down storage before the promise resolves

Returns `true` if the table was removed. With `ifExists`, returns `false` silently when not found.

#### `dropView(schemaName, viewName): boolean`

Removes a view definition from the schema.

#### `defineTable(definition: TableSchema): void`

Programmatic alternative to `CREATE TABLE` — registers a `TableSchema` object directly in the `main` schema. This is a `Database`-level method (not SchemaManager), useful when you have a `TableSchema` from parsing or programmatic construction.

Currently only supports the `main` schema; throws `MisuseError` for other schemas.

```typescript
db.defineTable({
  name: 'metrics',
  schemaName: 'main',
  columns: [ /* ... */ ],
  primaryKey: [ /* ... */ ],
  vtabModule: myModule,
  vtabModuleName: 'memory'
});
```

#### `clearAll()`

Clears all tables, functions, and views from all schemas. Does not call module disconnect/destroy.

### Virtual Table Modules

| Method | Description |
|--------|-------------|
| `registerModule(name, module, auxData?)` | Registers a virtual table module by name. Replaces any existing module with the same name |
| `getModule(name)` | Retrieves a registered module and its auxData |
| `setDefaultVTabModuleName(name)` | Sets the module used when `USING` is omitted in `CREATE TABLE`. Defaults to `'memory'` |
| `getDefaultVTabModuleName()` | Returns the current default module name |
| `setDefaultVTabArgs(args)` | Sets default module arguments (key-value) |
| `getDefaultVTabModule()` | Returns `{ name, args }` for the default module |

### Catalog Import

#### `importCatalog(ddlStatements): Promise<{ tables: string[]; indexes: string[] }>`

Imports existing schema objects without creating new storage. Used when connecting to a backend that already contains data. For each DDL statement:
- `CREATE TABLE` calls `module.connect()` instead of `module.create()`
- `CREATE INDEX` registers the index metadata without calling `module.createIndex()`
- Schema change events are not emitted (these are existing objects)

### DDL Generation

Canonical `TableSchema` → DDL and `IndexSchema` → DDL generators are exported from the package entry point:

```typescript
import { generateTableDDL, generateIndexDDL } from '@quereus/quereus';

const ddl = generateTableDDL(tableSchema, db?);        // CREATE TABLE ...
const idxDdl = generateIndexDDL(indexSchema, tableSchema, db?);  // CREATE INDEX ...
```

Both generators accept an optional `Database` argument that provides session context. Their emission behavior depends on whether `db` is supplied:

| Aspect | With `db` | Without `db` |
|--------|-----------|--------------|
| Schema qualification | Elided when it matches `db.schemaManager.getCurrentSchemaName()` | Always qualified (`"schema"."name"`) |
| Column nullability | Only the annotation that differs from `default_column_nullability` is emitted | Every column is explicitly annotated (`NULL` or `NOT NULL`) |
| `USING <module> (...)` | Elided when both module and args match `default_vtab_module` / `default_vtab_args` | Always emitted for any `vtabModuleName` |

Use the no-`db` form when persisting DDL to storage, so the output survives re-parsing under any session's `default_column_nullability` setting. Use the with-`db` form for display or round-trip within the same session to produce more readable output.

Feature coverage (both forms): `TEMP`, schema qualification, inline single-column `PRIMARY KEY`, table-level `PRIMARY KEY (...)` (including singleton `PRIMARY KEY ()`), `DEFAULT <expr>`, `USING <module>` with SQL-literal args, and `WITH TAGS (...)` at table, column, and index levels.

`@quereus/store` re-exports these symbols for backward compatibility:

```typescript
import { generateTableDDL } from '@quereus/store';
```

## Schema Path

The schema path controls the search order when resolving unqualified table names. These are `Database`-level methods:

| Method | Description |
|--------|-------------|
| `db.setSchemaPath(paths: string[])` | Sets the schema search order. Equivalent to `pragma schema_path` |
| `db.getSchemaPath(): string[]` | Returns the current schema search path as an array of schema names |

```typescript
db.setSchemaPath(['main', 'extensions', 'plugins']);
const path = db.getSchemaPath(); // ['main', 'extensions', 'plugins']
```

See the [Usage Guide](usage.md) for the consumer-facing declarative schema workflow, schema path resolution order, and `PRAGMA schema_path` syntax.

## Database Options Affecting Schema

The `db.setOption()` / `db.getOption()` methods control several schema-related behaviors:

| Option | Effect |
|--------|--------|
| `schema_path` | Default search order for unqualified table names |
| `default_column_nullability` | Column nullability default — `'not_null'` (Third Manifesto default) or `'nullable'` |

See the [Usage Guide](usage.md) for the full options and pragmas reference.

## Schema Change Events

The `SchemaChangeNotifier` (accessed via `schemaManager.getChangeNotifier()`) provides a typed event system for observing schema mutations.

### Subscribing

```typescript
const notifier = db.schemaManager.getChangeNotifier();

const unsubscribe = notifier.addListener((event) => {
  switch (event.type) {
    case 'table_added':
      console.log(`New table: ${event.schemaName}.${event.objectName}`);
      console.log('Schema:', event.newObject); // TableSchema
      break;
    case 'table_removed':
      console.log(`Dropped: ${event.objectName}`);
      console.log('Was:', event.oldObject); // TableSchema
      break;
    case 'table_modified':
      console.log('Before:', event.oldObject);
      console.log('After:', event.newObject);
      break;
  }
});

// Later:
unsubscribe();
```

### Event Types

The `SchemaChangeEvent` discriminated union includes:

| Event Type | Payload | When |
|------------|---------|------|
| `table_added` | `newObject: TableSchema` | After `createTable` |
| `table_removed` | `oldObject: TableSchema` | After `dropTable` |
| `table_modified` | `oldObject`, `newObject: TableSchema` | After `createIndex` or table alteration |
| `function_added` | `newObject: FunctionSchema` | After function registration |
| `function_removed` | `oldObject: FunctionSchema` | After function removal |
| `function_modified` | `oldObject`, `newObject: FunctionSchema` | After function replacement |
| `assertion_added` | `newObject: IntegrityAssertionSchema` | After `CREATE ASSERTION` |
| `assertion_removed` | `oldObject: IntegrityAssertionSchema` | After `DROP ASSERTION` |
| `assertion_modified` | `oldObject`, `newObject: IntegrityAssertionSchema` | After assertion replacement |
| `module_added` | _(name only)_ | After module registration |
| `module_removed` | _(name only)_ | After module removal |
| `collation_added` | _(name only)_ | After collation registration |
| `collation_removed` | _(name only)_ | After collation removal |

All events carry `schemaName` and `objectName` fields.

Listener errors are caught and logged — a failing listener does not disrupt other listeners or the originating operation.

### Database-Level Events

The higher-level `db.onSchemaChange()` API aggregates schema events from all modules. Events from modules with native event support flow through the module's own emitter; for other modules, `SchemaManager` emits synthetic events automatically. See the [Usage Guide](usage.md) for the database-level event API.

## Error Handling

Schema operations throw `QuereusError` with these common status codes:

| Code | Scenario |
|------|----------|
| `StatusCode.ERROR` | Module not found, schema not found, invalid DDL, module create/connect failure |
| `StatusCode.CONSTRAINT` | Table or index already exists (without `IF NOT EXISTS`), multiple primary key definitions |
| `StatusCode.NOTFOUND` | Table not found during `dropTable` (without `ifExists`) |
| `StatusCode.INTERNAL` | Module did not return a `tableSchema` after create, unexpected removal failure |
| `StatusCode.MISUSE` | Invalid argument format (e.g. non-object JSON for default vtab args) |

Errors include source location (`line`, `column`) when available from the AST node. See [Error Handling](errors.md) for the full error model.

## Declarative Schema

The `declare schema` / `diff schema` / `apply schema` workflow provides order-independent, end-state schema declarations. The engine computes diffs against the current catalog (`computeSchemaDiff`) and generates migration DDL (`generateMigrationDDL`). Key diff types:

- `SchemaDiff` — tables/views/indexes/assertions to create, drop, alter, or rename
- `TableAlterDiff` — columns to rename, add, alter, or drop within an existing table; named-constraint renames

Destructive changes (drops) require explicit acknowledgement. See the [SQL Reference](sql.md#20-declarative-schema-optional-order-independent) for full syntax and examples.

The equivalence guarantee that direct `create table` / `create view` DDL and the corresponding `declare schema` + `apply schema` body produce indistinguishable catalogs and runtime behaviour is enforced by `test/declarative-equivalence.spec.ts` (curated corpus) plus the `Declarative-schema equivalence (property)` block in `test/property.spec.ts` (`fast-check`-driven dragnet).

### Migration Order

`generateMigrationDDL` produces DDL in a fixed order:

1. **Renames first** — `ALTER TABLE ... RENAME TO` for objects with a stable identity hint (`quereus.id` / `quereus.previous_name`). This frees the old name before any create reuses it and lets the engine's rename rewriter propagate references through dependents.
2. **Drops second** — `DROP TABLE`, `DROP VIEW`, `DROP INDEX` for objects neither declared nor consumed by a rename.
3. **Creates third** — `CREATE TABLE`, `CREATE VIEW`, `CREATE INDEX` for new objects.
4. **Alters last** — within each `TableAlterDiff`: `RENAME COLUMN` first (so subsequent phases see post-rename names), then `ADD COLUMN`, `ALTER COLUMN`, `ALTER PRIMARY KEY`, `DROP COLUMN`.

This ordering ensures that dropped tables free their names before creates run, and that forward references between tables (e.g. foreign keys to later-declared tables) work because declarations are order-independent.

### Rename Detection

`computeSchemaDiff(declared, actual, policy?)` accepts an optional `RenamePolicy` (`'allow' | 'require-hint' | 'deny'`, default `'allow'`):

- Under `'allow'`, declared objects whose name doesn't match an actual object are tested for `quereus.id` then `quereus.previous_name` matches against the catalog. A hit emits a `RenameOp` and consumes the actual so it isn't dropped.
- Under `'require-hint'`, any unhinted name change is rejected: if the diff produces both a drop and a create of the same kind (table, view, index), `computeSchemaDiff` throws.
- Under `'deny'`, hints are ignored entirely — every mismatch becomes drop+create.

Conflicts (declared name and hint resolving to two distinct existing objects) always throw, independent of policy beyond `'deny'`.

The same resolution runs at column granularity inside `computeTableAlterDiff` and at named-constraint granularity. Column renames emit `ALTER TABLE ... RENAME COLUMN`. View, index, and named-constraint renames have no engine-level rename primitive and currently fall back to drop+recreate via the standard buckets.

### Module Batch Hooks

Virtual table modules may opt into a per-`apply schema` batch by implementing the optional `beginSchemaBatch` / `endSchemaBatch` callbacks on `VirtualTableModule`. When the migration loop has at least one DDL statement, the engine calls `beginSchemaBatch(db, schemaName)` on every registered module that defines it (in registration order), runs the migration loop, and then calls `endSchemaBatch(db, schemaName, error?)` on those same modules in reverse order — passing the loop error on failure or `undefined` on success.

This lets a storage-backed module fold the entire migration into a single substrate commit: open an in-memory overlay in begin, have subsequent `create` / `destroy` / `alterTable` calls join it, then commit (or discard) in end. Modules without the hooks pay nothing — they're skipped. The idempotent fast-path (no DDL to run) skips both hooks.

If `beginSchemaBatch` itself throws, already-started modules receive `endSchemaBatch(error)` with the begin failure and the error propagates out of `apply schema`. Errors from `endSchemaBatch` are rethrown only when no prior loop error exists; otherwise they are logged so the original cause survives.

### Seed Data

Declared schemas can include seed data (`seed <tableName> values ...`). When `apply schema ... with seed` is executed:

1. Existing rows in each seeded table are deleted (`DELETE FROM`)
2. Declared seed rows are inserted
3. This happens per-table, after all structural migrations complete (and after `endSchemaBatch` has fired)

### Schema Hashing

`explain schema [<name>]` returns a short hash of the declared schema, useful for versioning:

```sql
explain schema main;
-- Returns: hash:a1b2c3d4
explain schema main version '2.0';
-- Returns: version:2.0,hash:a1b2c3d4
```

### DeclaredSchemaManager API

The `DeclaredSchemaManager` (accessed via `db.declaredSchemaManager`) stores declared schema ASTs and seed data between `declare schema` and `apply schema` calls.

| Method | Description |
|--------|-------------|
| `setDeclaredSchema(schemaName, declaration)` | Stores a `DeclareSchemaStmt` AST |
| `getDeclaredSchema(schemaName)` | Retrieves stored declaration, or `undefined` |
| `hasDeclaredSchema(schemaName)` | Returns `true` if a declaration exists |
| `removeDeclaredSchema(schemaName)` | Removes declaration and its seed data |
| `setSeedData(schemaName, tableName, rows)` | Stores seed data rows (`SqlValue[][]`) for a table |
| `getSeedData(schemaName, tableName)` | Retrieves seed data for a specific table |
| `getAllSeedData(schemaName)` | Returns all seed data for a schema (`Map<string, SqlValue[][]>`) |
| `clearSeedData(schemaName)` | Clears all seed data for a schema |

All name lookups are case-insensitive. The manager is stateful — `declare schema` clears previous seed data then stores the new declaration, so re-declaring replaces earlier state.
