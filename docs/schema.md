# Schema Management

The schema subsystem manages database schemas, tables, views, functions, and indexes. It coordinates virtual table module lifecycle, resolves names across multi-schema search paths, and emits typed change events.

## Key Types

### SchemaManager

Central coordinator for all schema operations. Owns the schema collection, module registry, and change notifier. One instance per `Database`.

### Schema

A named logical grouping of tables, views, functions, and assertions. Every database has at least `main` and `temp` schemas; additional schemas can be attached. Each schema carries a `kind`:

- **`physical`** (default) — module-backed. Tables declare `using module(...)`, may carry indexes and storage tags.
- **`logical`** — design-only (`declare logical schema X { ... }`). Tables declare columns, types, and *logical* constraints (PK, UNIQUE, CHECK, FK, NOT NULL) plus `with tags`, and **nothing physical**: module association, `create index` / `unique index`, and materialized views are all rejected at apply (tags are allowed — they are engine-facing and survive into the compiled view). At `apply schema X` each logical table is aligned against a basis schema and compiled to an inlined view (the **lens layer**); the resulting body is registered as an ordinary `ViewSchema` and the logical spec is held in a per-`Schema` **lens slot**. See [Lenses and Layered Schemas](lens.md).

### TableSchema

Describes a table's structure: columns, primary key definition, CHECK constraints, associated virtual table module, indexes, and mutation context definitions. A module-backed (physical) table always has `vtabModule` / `vtabModuleName`; a **logical** table (`isLogical: true`, held only in a lens slot — never registered or executed) carries no module, so `vtabModule` is optional (use `requireVtabModule(table)` at module-backed sites). Optional `tags` field holds arbitrary key-value metadata (see `WITH TAGS`).

### ColumnSchema

Defines a single column: name, logical type, nullability, primary key membership, default value expression, collation, and whether the column is generated. Columns default to NOT NULL (Third Manifesto) unless `pragma default_column_nullability = 'nullable'` is set. Optional `tags` field holds arbitrary key-value metadata.

### IndexSchema / IndexColumnSchema

Describes a secondary index by name and an ordered list of column references (by index into `TableSchema.columns`) with optional sort direction and collation. Optional `tags` field holds arbitrary key-value metadata.

### RowConstraintSchema

A CHECK constraint with an AST expression, an operation bitmask (insert/update/delete), and deferral settings. Optional `tags` field holds arbitrary key-value metadata.

### UniqueConstraintSchema

A UNIQUE constraint over one or more columns (beyond the primary key): column indices, optional name, default conflict action, optional partial-index `predicate`, and `derivedFromIndex` (set when synthesized from `CREATE UNIQUE INDEX`). Carries an optional `coveringStructureName` — see [Covering-structure links](#covering-structure-links). Optional `tags` field holds arbitrary key-value metadata.

### ViewSchema

Describes a view: name, schema, SQL text, and parsed SELECT AST. Optional `tags` field holds arbitrary key-value metadata.

### MaterializedViewSchema

Describes a materialized view — a *keyed derived relation* stored in a hidden backing table. Carries the body AST, the inferred primary key, a `bodyHash` (used by the declarative-schema differ to detect "body changed → rebuild"), the backing-table name, and source-table dependencies. Registered in `Schema.materializedViews` (see `getMaterializedView` / `getAllMaterializedViews`), distinct from `views`. Optional `origin` / `covers` fields record a covering-structure link — see [Covering-structure links](#covering-structure-links). Full design: [Materialized Views](materialized-views.md).

### Covering-structure links

A UNIQUE constraint is logical; the structure that enforces it is optional (see [Materialized Views § Covering structures](materialized-views.md#covering-structures)). Two schema fields record the constraint↔structure association:

- **`UniqueConstraintSchema.coveringStructureName`** — the **forward pointer** and **source of truth**: the name of the covering structure realizing this constraint (an auto-built secondary index, or an explicit materialized view recognized by the coverage prover). Set eagerly when a covering MV is created; cleared when that MV is dropped.
- **`MaterializedViewSchema.origin`** — `'explicit'` (default; an ordinary user-declared MV) or `'implicit-from-unique-constraint'` (reserved for the auto-built secondary BTree, which is described in this vocabulary but held on the memory-table manager, never registered as an MV).
- **`MaterializedViewSchema.covers`** — the convenience **reverse link** `{ schemaName, tableName, constraintName? }` back to the covered constraint.

These links are informational in the current release (enforcement still routes through the synchronously-maintained auto-index — see the materialized-views soundness note).

**Introspection.** The implicit covering structure (a UNIQUE constraint's auto-built index) is a backing detail and is **omitted from `collectSchemaCatalog` / schema export by default**. It is surfaced only when the originating constraint carries the tag `quereus.expose_implicit_index = true`. Indexes from an explicit `CREATE [UNIQUE] INDEX` are always shown.

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
| `addSchema(name, kind?)` | Creates a new schema (e.g. for ATTACH), `kind` defaulting to `'physical'` (`'logical'` for a logical schema). Throws if name conflicts |
| `removeSchema(name)` | Removes a schema (e.g. for DETACH). Cannot remove `main` or `temp` |

### Table Lookup

| Method | Description |
|--------|-------------|
| `findTable(tableName, dbName?, schemaPath?)` | Finds a table across schemas. If `dbName` is provided, searches that schema only. If `schemaPath` is provided, searches those schemas in order. Otherwise uses default search order: `main`, then `temp` |
| `getTable(schemaName, tableName)` | Retrieves a table from a specific schema |
| `getView(schemaName, viewName)` | Retrieves a view definition |
| `getSchemaItem(schemaName, itemName)` | Returns a table or view by name (views take priority on name conflict) |
| `getTableTags(tableName, schemaName?)` | Returns metadata tags for a table, or `undefined` |
| `setTableTags(tableName, tags, schemaName?)` | Replaces a table's metadata tags (pass `{}` to clear); fires `table_modified` |
| `setColumnTags(tableName, columnName, tags, schemaName?)` | Replaces a column's metadata tags (pass `{}` to clear). Catalog-only — column nullability / type / default / PK membership are untouched. Throws `NOTFOUND` for an unknown table or column |
| `setConstraintTags(tableName, constraintName, tags, schemaName?)` | Replaces a **named** table-level constraint's metadata tags (pass `{}` to clear). Lookup order CHECK → UNIQUE → FOREIGN KEY; throws `NOTFOUND` for no match and `ERROR` for a name ambiguous across classes |
| `setViewTags(viewName, tags, schemaName?)` | Replaces a view's metadata tags (pass `{}` to clear). Catalog-only — re-registers the `ViewSchema`; throws `NOTFOUND` for an unknown view |
| `setMaterializedViewTags(name, tags, schemaName?)` | Replaces a materialized view's metadata tags (pass `{}` to clear). Catalog-only — re-registers the `MaterializedViewSchema`; never touches the backing table or re-materializes. Throws `NOTFOUND` for an unknown MV |
| `setIndexTags(indexName, tags, schemaName?)` | Replaces an index's metadata tags (pass `{}` to clear). Resolves the owning table from the index name, swaps the `IndexSchema`, and fires `table_modified`. Throws `NOTFOUND` for an unknown index or a hidden implicit covering index (its tags live on the originating constraint) |
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
- `TableAlterDiff` — columns to rename, add, alter, or drop within an existing table; named-constraint rename / drop / add (`constraintsToRename` / `constraintsToDrop` / `constraintsToAdd`)

Destructive changes (drops) require explicit acknowledgement. See the [SQL Reference](sql.md#20-declarative-schema-optional-order-independent) for full syntax and examples.

The equivalence guarantee that direct `create table` / `create view` DDL and the corresponding `declare schema` + `apply schema` body produce indistinguishable catalogs and runtime behaviour is enforced by `test/declarative-equivalence.spec.ts` (curated corpus) plus the `Declarative-schema equivalence (property)` block in `test/property.spec.ts` (`fast-check`-driven dragnet).

### Logical schemas and lenses

`declare logical schema X { ... }` declares a design-only schema (`kind: 'logical'`) — columns and *logical* constraints, no module / index / storage. At `apply schema X` the lens compiler aligns each logical table against a basis schema and registers an inlined effective view body, so reads ride the standard view path and writes ride [view updateability](view-updateability.md).

`declare lens for X over Y { view T as <select> ... }` is a **sibling statement** (parsed to `DeclareLensStmt`, stored on `DeclaredSchemaManager` keyed by the logical schema name) that binds logical schema `X` to an **explicit basis** `Y` and supplies per-table sparse overrides:

```sql
declare logical schema X { table Car (id int primary key, maxSpeed int, color text); }
declare lens for X over Y {
  view Car as select id, speed as maxSpeed from Y.CarCore;   -- rename; color gap-filled
}
apply schema X;
```

The override projection covers some columns (by output name); the default mapper gap-fills the rest from the override's `FROM`, and every logical column must end up mapped (an uncovered column the basis cannot back is a compile error). `over Y` is the explicit basis (it resolves the auto-inference ambiguity that arises with multiple physical bases). Inspect the composed result with `quereus_effective_lens(schema, table)`. See [Lenses and Layered Schemas](lens.md) for the full model — including the name-based / re-read-from-source merge and the gap-fill fidelity boundary.

#### Acknowledging lens advisories (`quereus.lens.ack.*` / `quereus.lens.policy.*`)

At `apply schema X` the lens prover emits **coded, sited advisories** (`lens.no-backing-index`, `lens.no-answering-structure`, `lens.partial-override`) onto the deploy report. A developer accepts one in source with a reserved tag on the logical table (or a constraint), so the suppression is version-controlled and reviewable rather than an out-of-band suppress-list:

```sql
declare logical schema X {
  table Car (id int primary key, vin text, unique (vin))
    with tags (
      -- acknowledge the no-backing-index advisory for the vin constraint:
      "quereus.lens.ack.no-backing-index:vin" = 'low-write table; commit-time scan accepted',
      -- (optional) force a conscious decision on that code for this table:
      "quereus.lens.policy.require-ack" = 'lens.no-backing-index'
    );
}
```

- **`quereus.lens.ack.<code>[:<target>]`** — acknowledges the advisory whose `<code>` (the `lens.`-stripped advisory code) it names; the optional `:<target>` narrows to a column/constraint. The value is a **required rationale**; an empty rationale still suppresses but surfaces an empty-rationale meta-warning on the report.
  - **Fingerprint / re-surface (anti-fatigue).** The rationale may carry a trailing `#fp=<digest>` token — the recorded fingerprint of the advisory's coarse facts (constraint columns, covering-structure presence, a **banded** cardinality, the backing relation). A bare rationale (no `#fp=`) is honored *unconditionally* (record-on-first-sight). When a recorded fingerprint stops matching the recomputed one (constraint columns change, a covering structure drops, the cardinality crosses a band — `empty`/`small`<1e3/`medium`<1e6/`large`/`unknown`), the advisory **re-surfaces** flagged "previously acknowledged; situation changed". The token round-trips through DDL export (it is part of the tag value string).
- **`quereus.lens.policy.error-on` / `quereus.lens.policy.require-ack`** — a per-logical-table escalation policy (CSV of advisory codes, **default-empty**). `error-on` codes are always hard errors an ack cannot suppress; `require-ack` codes are hard errors only when *un*-acknowledged (a valid ack clears them). Escalation errors abort the deploy atomically alongside the prover's blocking errors.

The deploy summary tallies `acknowledged: N` (`LensDeployReport.acknowledged.length`); `select * from quereus_lens_advisories('x')` expands the full list — one row per advisory with its `status` (`active` / `re-surfaced` / `acknowledged` / `acknowledged-unconditional`), rationale, and current/recorded fingerprints. All `quereus.lens.*` tag shape/site validation lives in the typed registry `src/schema/reserved-tags.ts`.

### Migration Order

`generateMigrationDDL` produces DDL in a fixed order:

1. **Renames first** — `ALTER TABLE ... RENAME TO` for objects with a stable identity hint (`quereus.id` / `quereus.previous_name`). This frees the old name before any create reuses it and lets the engine's rename rewriter propagate references through dependents.
2. **Drops second** — `DROP TABLE`, `DROP VIEW`, `DROP INDEX` for objects neither declared nor consumed by a rename.
3. **Creates third** — `CREATE TABLE`, `CREATE VIEW`, `CREATE INDEX` for new objects.
4. **Alters last** — within each `TableAlterDiff`: `RENAME COLUMN` first (so subsequent phases see post-rename names), then `ADD COLUMN`, `ALTER COLUMN`, then the **constraint lifecycle** — `RENAME CONSTRAINT` then `DROP CONSTRAINT` (free / remove a name before any re-add, and drop a UNIQUE before the PK change so it can't strand a PK dependency) — then `ALTER PRIMARY KEY`, then `ADD CONSTRAINT` (after the PK change and the column adds it may reference), then `DROP COLUMN` last, then the tag-drift `SET TAGS` phase.

This ordering ensures that dropped tables free their names before creates run, and that forward references between tables (e.g. foreign keys to later-declared tables) work because declarations are order-independent. A constraint `ADD` lands after all `CREATE TABLE`s, so a declared FK constraint added to an existing table can reference a freshly-declared parent.

### Rename Detection

`computeSchemaDiff(declared, actual, policy?)` accepts an optional `RenamePolicy` (`'allow' | 'require-hint' | 'deny'`, default `'allow'`):

- Under `'allow'`, declared objects whose name doesn't match an actual object are tested for `quereus.id` then `quereus.previous_name` matches against the catalog. A hit emits a `RenameOp` and consumes the actual so it isn't dropped.
- Under `'require-hint'`, any unhinted name change is rejected: if the diff produces both a drop and a create of the same kind (table, view, index), `computeSchemaDiff` throws.
- Under `'deny'`, hints are ignored entirely — every mismatch becomes drop+create.

Conflicts (declared name and hint resolving to two distinct existing objects) always throw, independent of policy beyond `'deny'`.

The same resolution runs at column granularity inside `computeTableAlterDiff` and at named-constraint granularity. Column renames emit `ALTER TABLE ... RENAME COLUMN`; named-constraint renames now emit the `ALTER TABLE ... RENAME CONSTRAINT` primitive (CHECK / UNIQUE / FOREIGN KEY). View and index renames have no engine-level rename primitive and still fall back to drop+recreate via the standard buckets.

Alongside renames, `computeTableAlterDiff` resolves the full **named-constraint lifecycle** by name: a user-named constraint in the catalog but absent from the declaration (and not consumed by a rename) → `TableAlterDiff.constraintsToDrop` → `DROP CONSTRAINT`; a declared user-named constraint absent from the catalog (and not a rename target) → `TableAlterDiff.constraintsToAdd` → `ADD <fragment>`. Declared constraints are gathered from **both** the table-level `constraints` list and column-level constraints carrying an explicit name (`qty int constraint chk_qty check (qty > 0)`), matching what the catalog's `namedConstraints` surfaces. Only **user-named** constraints participate: engine-synthesized auto-names (`_check_*` / `_fk_*` / `_uc_*`), PRIMARY KEY constraints (handled by `primaryKeyChange`), and UNIQUE constraints derived from a `CREATE UNIQUE INDEX` (`derivedFromIndex`, managed through their index) are excluded — keeping the diff stable/idempotent for unnamed and index-derived constraints. Under `require-hint`, a constraint add **and** drop on the same table with no rename hint is rejected, mirroring the table/column guard. **Note:** `ADD CONSTRAINT` applies a CHECK in place; a UNIQUE / FOREIGN KEY add routes through module `addConstraint`, which the built-in memory and store modules now implement — they **re-validate the existing rows** and fail atomically with `CONSTRAINT` (schema unchanged) when the current data violates the new constraint, otherwise installing forward enforcement. So a declarative add of a named UNIQUE / FK to an already-existing table now **converges** end-to-end (and a second apply is a no-op). FK existing-row validation is gated by `pragma foreign_keys` (off ⇒ the add skips the scan and defers enforcement to later writes); the store's UNIQUE existing-row check is value-exact and does not honor a per-column NOCASE collation (matching the store's `CREATE UNIQUE INDEX` path). ADD / DROP / RENAME now all work for the three classes.

#### Tag-drift detection

`computeTableAlterDiff` also detects **metadata-tag drift** at three sites — the table (`TableAlterDiff.tableTagsChange`), each surviving column (`ColumnAttributeChange.tags`, computed in `computeColumnAttributeChange`), and each name-matched named constraint (`TableAlterDiff.constraintTagsChanges`). The schema hash deliberately excludes tags, so drift is detected **structurally** (an order-independent `stableStringify` compare) rather than via the hash. The rename-hint keys `quereus.id` and `quereus.previous_name` are excluded from the comparison (they drive rename detection, not data state, so a declaration carrying only a hint does not churn out a `SET TAGS` after the rename completes); behavioral reserved tags (`quereus.update.*`, `quereus.lens.*`, `quereus.expose_implicit_index`, …) *are* compared. `generateMigrationDDL` emits the drift as `ALTER TABLE … SET TAGS (…)` / `ALTER TABLE … ALTER COLUMN … SET TAGS (…)` / `ALTER TABLE … ALTER CONSTRAINT … SET TAGS (…)` **after** the structural ALTER phases, so a tag set lands on the post-rename column / constraint name. These `SET TAGS` mutations are **catalog-only**: the runtime swaps the in-memory schema and fires `table_modified` without calling `module.alterTable`. Store-backed modules re-persist DDL only from their `alterTable` hook, so a tag-only change on a store table is not yet re-persisted across reconnect — tracked by backlog ticket `tag-mutation-store-persistence`.

The differ detects the same drift on the other tagged catalog objects — **views**, **materialized views**, and **indexes** — on a name-matched object (no rename), surfacing it through `SchemaDiff.viewTagsChanges` / `materializedViewTagsChanges` / `indexTagsChanges`. `generateMigrationDDL` emits these as `ALTER VIEW … SET TAGS` / `ALTER MATERIALIZED VIEW … SET TAGS` / `ALTER INDEX … SET TAGS` (leaf metadata writes in the alter phase). Crucially, a materialized-view **tag-only** change takes this in-place path instead of a drop+recreate, so it does **not** re-materialize the body; a body change still drops+recreates (carrying the declared tags through the recreate), and the two are mutually exclusive per MV. The view / MV setters re-register the in-memory schema object (no event — mirroring the no-event view create path); the index setter swaps the owning table's `IndexSchema` and fires `table_modified`.

#### Reserved-tag validation on the declarative path

`quereus.id` and `quereus.previous_name` are first-class entries in the typed reserved-tag registry (`src/schema/reserved-tags.ts`), not a differ-local allow-list. Before any rename resolution, `computeSchemaDiff` routes every declared object's tags through `validateReservedTags(tags, site)` at the physical declarative sites — `physical-table` (table), `physical-column` (column), `view-ddl` (view / materialized view), `physical-index` (index), `physical-constraint` (table constraint, named or not — a table-level `WITH TAGS` clause is consumed even when the constraint is unnamed, so its tags are validated too; rename detection still keys off named constraints only) — and raises the first error via the shared `raiseReservedTagDiagnostics` policy helper. This is the **same registry and the same hard-error-on-unknown severity** as the lens-compile, view-mutation, and advertisement paths: a misspelled or mis-sited `quereus.*` key (e.g. `quereus.update.taget`, or `quereus.update.default_for.x` on a table rather than a view / projection / DML statement) now fails `apply schema` / `diff schema` loudly instead of being silently swallowed. The two rename hints carry value-schema `'string'` (a `quereus.id` may legitimately contain a hyphen, e.g. `'tbl-thing'`), so the existing rename flow is unchanged. An MV's `quereus.id` validates but is ignored (the differ supports no materialized-view rename).

The imperative `ALTER TABLE … SET TAGS` path routes through the **same** registry at the matching site (`physical-table` / `physical-column` / `physical-constraint`) during plan-build, so a misspelled or mis-sited reserved key fails the statement loudly rather than being stored. The sibling `ALTER VIEW` / `ALTER MATERIALIZED VIEW` / `ALTER INDEX … SET TAGS` statements validate at the `view-ddl` (view / MV) and `physical-index` (index) sites the same way.

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
