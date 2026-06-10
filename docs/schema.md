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

**Primary-key nullability.** A column forced NOT NULL by primary-key membership is forced **only by an *explicitly-declared* PK** — a column-level `primary key` or a table-level `primary key (...)`. When a table declares no PRIMARY KEY, Quereus synthesizes an all-columns key (the whole row is the row identity); that **synthesized** key does *not* promote nullability — each column keeps its declared (or session-default) nullability. A nullable synthesized-key column is a valid row identity because NULL participates in keys on both backends (memory compares `NULL == NULL` as equal and orders NULL first; the store key codec encodes `TYPE_NULL` first), so two fully-identical rows collide as a duplicate key.

### IndexSchema / IndexColumnSchema

Describes a secondary index by name and an ordered list of column references (by index into `TableSchema.columns`) with optional sort direction and collation. Optional `tags` field holds arbitrary key-value metadata.

### RowConstraintSchema

A CHECK constraint with an AST expression, an operation bitmask (insert/update/delete), and deferral settings. Optional `tags` field holds arbitrary key-value metadata.

### UniqueConstraintSchema

A UNIQUE constraint over one or more columns (beyond the primary key): column indices, optional name, default conflict action, optional partial-index `predicate`, and `derivedFromIndex` (set when synthesized from `CREATE UNIQUE INDEX`). Carries an optional `coveringStructureName` — see [Covering-structure links](#covering-structure-links). Optional `tags` field holds arbitrary key-value metadata.

### ViewSchema

Describes a view: name, schema, SQL text, and parsed SELECT AST. Optional `tags` field holds arbitrary key-value metadata.

### MaterializedViewSchema

Describes a materialized view — a *keyed derived relation* stored in a hidden backing table. Carries the body AST, the inferred primary key, a `bodyHash` (a hash of the canonical definition — explicit column list + body + `insert defaults` clause — used by the declarative-schema differ to detect "definition changed → rebuild"), the backing-table name, and source-table dependencies. Registered in `Schema.materializedViews` (see `getMaterializedView` / `getAllMaterializedViews`), distinct from `views`. Optional `origin` / `covers` fields record a covering-structure link — see [Covering-structure links](#covering-structure-links). Full design: [Materialized Views](materialized-views.md).

### Covering-structure links

A UNIQUE constraint is logical; the structure that enforces it is optional (see [Materialized Views § Covering structures](materialized-views.md#covering-structures)). Two schema fields record the constraint↔structure association:

- **`UniqueConstraintSchema.coveringStructureName`** — the **forward pointer** and **source of truth**: the name of the covering structure realizing this constraint (an auto-built secondary index, or an explicit materialized view recognized by the coverage prover). Set eagerly when a covering MV is created; cleared when that MV is dropped.
- **`MaterializedViewSchema.origin`** — `'explicit'` (default; an ordinary user-declared MV) or `'implicit-from-unique-constraint'` (reserved for the auto-built secondary BTree, which is described in this vocabulary but held on the memory-table manager, never registered as an MV).
- **`MaterializedViewSchema.covers`** — the convenience **reverse link** `{ schemaName, tableName, constraintName? }` back to the covered constraint.

These links are informational in the current release (enforcement still routes through the synchronously-maintained auto-index — see the materialized-views soundness note).

**Introspection.** The implicit covering structure (a UNIQUE constraint's auto-built index) is a backing detail and is **omitted from `collectSchemaCatalog` / schema export by default**. It is surfaced only when the originating constraint carries the tag `quereus.expose_implicit_index = true`. Indexes from an explicit `CREATE [UNIQUE] INDEX` are always shown.

Once exposed, the implicit index is **addressable and introspectable identically across backends** — it appears in `schema()` and `index_info()`, and `ALTER INDEX … {SET|ADD|DROP} TAGS` targets it. Backends differ only in *where the user tags live*: the memory backend materializes the implicit index as an `IndexSchema`, so its tags sit on `IndexSchema.tags`; backends that do not materialize it (the store, which enforces UNIQUE by full-scan over `uniqueConstraints`) derive a synthetic exposed index from the constraint in the read paths (`exposedImplicitIndexes` in `catalog.ts`) and route `ALTER INDEX … TAGS` onto a separate `UniqueConstraintSchema.exposedIndexTags` field. The asymmetry is internal; observable behavior is identical. A *hidden* implicit index (tag absent/false) stays unaddressable (`NOTFOUND`) on both — its tags live on the constraint, reached via `ALTER TABLE … ALTER CONSTRAINT … TAGS`. (Known gap: because `exposedIndexTags` is held separately from the constraint's own `tags`, an exposed index's user tags do not yet survive a store close→reopen — see backlog `store-secondary-index-persistence`.)

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

**Persistence of catalog-only tag swaps (store-backed tables).** The tag setters above (and the equivalent `ALTER … SET TAGS`) are catalog-only — they swap the in-memory schema and fire a change event but deliberately do **not** call `module.alterTable`. The generic store module (`@quereus/store`) still re-persists them: it subscribes to the engine's `table_modified` events and re-writes the table's catalog DDL (via `generateTableDDL`) whenever the serialized form changes. So **table**, **column**, and **named-constraint** tags now survive close → reopen → `rehydrateCatalog` for `using store` tables. The re-write is a read-compare-write keyed by `{schema}.{table}`: a table with no catalog entry (a memory table, or a store table never persisted) is skipped, and a structural ALTER — whose own `alterTable` already wrote the final DDL — produces identical bytes and is skipped (no double-write). The same subscription now also persists **views** and **materialized views**: the store listens for `view_added`/`view_removed`/`view_modified` and `materialized_view_added`/`_removed`/`_modified`/`_refreshed`, writing each object's DDL (via `generateViewDDL` / `generateMaterializedViewDDL`) under a reserved-prefix catalog key. So **view** and **materialized-view** tags (`setViewTags` / `setMaterializedViewTags`), as well as `CREATE`/`DROP VIEW` and `CREATE`/`DROP MATERIALIZED VIEW`, now round-trip too (see [Store catalog persistence](#store-catalog-persistence-bundled-index-ddl) for the key namespaces and rehydrate phasing). The only remaining gap is an *exposed implicit index*'s user tags (held on `UniqueConstraintSchema.exposedIndexTags`, separate from the bundled index DDL) — tracked by backlog `store-exposed-implicit-index-tags-persistence`.

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

#### `importCatalog(ddlStatements): Promise<{ tables: string[]; indexes: string[]; views: string[]; materializedViews: string[] }>`

Imports existing schema objects without creating new storage. Used when connecting to a backend that already contains data. For each DDL statement:
- `CREATE TABLE` calls `module.connect()` instead of `module.create()`
- `CREATE INDEX` registers the index metadata without calling `module.createIndex()`, reconstructing the index with full fidelity from the re-parsed DDL — the `UNIQUE` flag, the partial `WHERE` predicate, and per-column collation (including the collate-wrapped column form the parser folds `COLLATE` into). A `CREATE UNIQUE INDEX` also re-synthesizes its `derivedFromIndex` UNIQUE constraint, exactly as the live create path does.
- `CREATE VIEW` registers a plain view **without planning the body** — body validation is deferred to first reference (mirroring how `importTable` defers create-time work via `connect`). This makes view rehydration order-independent: a view over another view, a materialized view, or a not-yet-imported relation registers regardless of phase order, and a broken body surfaces only when the view is queried. The imported view name appears in the `views` result array.
- `CREATE MATERIALIZED VIEW` **re-materializes** through the same `materializeView` core the create emitter uses (`runtime/emit/materialized-view-helpers.ts`): the body is re-planned against the already-imported sources, the memory backing table is rebuilt and filled, and row-time maintenance is re-registered — but no `materialized_view_added` fires (`table_added` for the backing table still does, as on create). Unlike a plain view the body plans **eagerly** (the backing cannot fill without running it), so MV import is order-dependent: sources — including another MV's backing for MV-over-MV — must already be registered. A body that cannot plan, fills with duplicate keys ("must be a set"), or fails the row-time eligibility gate throws after the half-built backing is rolled back. The imported MV name appears in the `materializedViews` result array.
- Schema change events are not emitted (these are existing objects)

Each entry in `ddlStatements` may hold **more than one** statement: a table can be bundled with the `CREATE INDEX`es that belong to it in a single string, imported in document order (so the table precedes its indexes). Single-statement entries remain valid. Any unsupported statement type throws (fail-loud), so the store's `rehydrateCatalog` records the failure rather than silently dropping the object.

### DDL Generation

Canonical schema → DDL generators are exported from the package entry point:

```typescript
import { generateTableDDL, generateIndexDDL, generateViewDDL, generateMaterializedViewDDL } from '@quereus/quereus';

const ddl = generateTableDDL(tableSchema, db?);                  // CREATE TABLE ...
const idxDdl = generateIndexDDL(indexSchema, tableSchema, db?);  // CREATE INDEX ...
const viewDdl = generateViewDDL(viewSchema);                     // CREATE VIEW main.v ...
const mvDdl = generateMaterializedViewDDL(mvSchema);             // CREATE MATERIALIZED VIEW main.mv ...
```

`generateViewDDL` / `generateMaterializedViewDDL` lift the stored schema back into the equivalent `CreateView` / `CreateMaterializedView` AST and render it through the shared `ast-stringify` emitter (the same schema→AST-lift strategy `generateTableDDL` uses for constraints), so the persistence path and the declarative AST→SQL path cannot drift. They emit a **fully-qualified** (`schema.name`) name so a re-parse registers into the correct schema regardless of the session's current schema, and read the **live** `tags` — so an `ALTER VIEW … SET TAGS` (which swaps the in-memory schema without rewriting the stored `sql`) round-trips. `generateMaterializedViewDDL` deliberately omits the `USING` clause: the backing is always a memory table in v1 and the clause is informational only — on reopen the backing rebuilds as memory regardless, and a re-parse with no `USING` still builds a valid MV. Both are a `parse → generate → parse` fixed point.

Both generators accept an optional `Database` argument that provides session context. Their emission behavior depends on whether `db` is supplied:

| Aspect | With `db` | Without `db` |
|--------|-----------|--------------|
| Schema qualification | Elided when it matches `db.schemaManager.getCurrentSchemaName()` | Always qualified (`"schema"."name"`) |
| Column nullability | Only the annotation that differs from `default_column_nullability` is emitted | Every column is explicitly annotated (`NULL` or `NOT NULL`) |
| `USING <module> (...)` | Elided when both module and args match `default_vtab_module` / `default_vtab_args` | Always emitted for any `vtabModuleName` |

Use the no-`db` form when persisting DDL to storage, so the output survives re-parsing under any session's `default_column_nullability` setting. Use the with-`db` form for display or round-trip within the same session to produce more readable output.

Feature coverage (both forms): `TEMP`, schema qualification, inline single-column `PRIMARY KEY`, table-level `PRIMARY KEY (...)` (including singleton `PRIMARY KEY ()`), non-default column `COLLATE <name>` (the default `BINARY` is elided, so a `COLLATE NOCASE` column survives a persistence re-parse instead of silently reverting to `BINARY`), `DEFAULT <expr>`, `USING <module>` with SQL-literal args, and `WITH TAGS (...)` at table, column, and index levels.

**Collation does NOT elide the session default.** The column-`COLLATE` emitter elides only a *literal* `BINARY` — never the session `default_collation`. This is deliberate and contrasts with nullability / `USING`, which DO elide their session defaults. The `default_collation` pragma (see `docs/sql.md` § 9.2.4) is a **create-time authoring convenience only**: it sets the collation an omitted-`COLLATE` column resolves to at `CREATE TABLE` time (text types only; non-text and JSON/temporal fall back to `BINARY`), but the catalog always stores the concrete resolved collation, and persisted DDL always carries an explicit `COLLATE` for any non-`BINARY` collation. So a `NOCASE` column authored under `default_collation = 'nocase'` round-trips unambiguously even when the database is reopened — or its DDL re-executed — under a different default. The rehydrate path (`SchemaManager.importTable`) resolves omitted-`COLLATE` columns to fixed canonical `BINARY` (it does **not** read the live pragma), relying on this non-elision so the explicit `COLLATE` in the persisted DDL is the single source of truth. The declarative differ resolves the declared side's omitted `COLLATE` via the **same** create-time rule (threading the live `default_collation`) so a fresh `apply` matches direct DDL and a re-apply stays idempotent (no spurious `SET COLLATE`). `ALTER TABLE ... ADD COLUMN` likewise honors `default_collation` — an ADD-COLUMN-ed text column resolves an omitted `COLLATE` exactly as a `CREATE`-d one would (non-text falls back to `BINARY`), and the differ emits an explicit resolved `COLLATE` on added columns so a migration authored under one default lands the same collation under any other. `RENAME COLUMN` deliberately does **not** consult the default: it is a derived-DDL path whose AST is reconstructed from the live column (carrying an explicit `COLLATE` only for a non-`BINARY` collation), so a renamed column preserves its existing collation — threading the default there would silently flip an existing `BINARY` column to the session default.

`generateIndexDDL` emits a **lossless** `CREATE INDEX`: `CREATE [UNIQUE] INDEX <name> ON <table> (<cols>) [WHERE <predicate>] [WITH TAGS (...)]`. The `UNIQUE` keyword and partial `WHERE` clause are reconstructed on import, so a `CREATE UNIQUE INDEX` / partial index round-trips without degrading to a plain/full index. Clause order matches the parser grammar and the AST emitter `createIndexToString` (columns → `WHERE` → `WITH TAGS`), so re-parsing yields the same shape and the declarative differ (which matches indexes by name) does not churn. A UNIQUE index's derived constraint round-trips via the index statement itself — `generateTableDDL` deliberately omits any `derivedFromIndex` UNIQUE constraint from the table DDL to avoid a double definition.

A **synthesized all-columns key** (a table with no declared PRIMARY KEY) emits **no** `PRIMARY KEY` clause — neither inline nor table-level. Naming it would make a re-parse treat it as an *explicitly-declared* PK and force its columns NOT NULL, silently dropping a nullable declaration on a store persistence round-trip; omitting it lets the re-parse re-synthesize the same key while preserving each column's declared nullability.

`@quereus/store` re-exports these symbols for backward compatibility:

```typescript
import { generateTableDDL } from '@quereus/store';
```

### Store catalog persistence (bundled index DDL)

`@quereus/store` persists each table's secondary indexes **inside the same
catalog entry as the table**, keyed `{schema}.{table}` (no per-index key
namespace). The entry is a newline-joined bundle — the `CREATE TABLE` statement
first, then one `CREATE [UNIQUE] INDEX` line per persistable index:

```
CREATE TABLE "main"."t" (...) USING store
CREATE INDEX "ix_b" ON "main"."t" ("b")
CREATE UNIQUE INDEX "uq_email" ON "main"."t" ("email" COLLATE NOCASE) WHERE "email" IS NOT NULL
```

`StoreModule.buildCatalogEntry` produces the bundle (table DDL + every index DDL,
both in the persistence-safe no-`db` form). Hidden implicit covering indexes (the
auto-built BTree backing a declared inline `UNIQUE`) are excluded — they
round-trip via the table's `UNIQUE` constraint, not as a standalone
`CREATE INDEX`. On reopen, `rehydrateCatalog` feeds each bundle to
`importCatalog`, whose `parser.parseAll` splits it by AST (never on `\n`, so a
newline inside a `DEFAULT` / `CHECK` / partial-predicate string literal is safe)
and imports table-before-indexes.

**Why bundle rather than a separate per-index key:** every existing re-persist
path carries the indexes for free —

- `CREATE INDEX` / `DROP INDEX` rewrite the bundle (`StoreModule.createIndex` /
  `dropIndex` call `saveTableDDL` after updating the connected table's schema).
- `DROP TABLE` deletes the single key, so the indexes vanish with it (no orphan
  catalog entries).
- `RENAME TABLE` regenerates the bundle under the new name (index DDL references
  the renamed table automatically).
- `ALTER INDEX … SET/ADD/DROP TAGS` fires `table_modified` on the *owning* table;
  the store's catalog listener regenerates the bundle (index tags live in
  `tableSchema.indexes`) with no index-specific plumbing.
- Structural ALTERs that reindex columns already re-persist the table, so the
  bundle's index lines track the reindexed columns.

**Reattach, not rebuild.** The physical index KV store survives a logical close,
so rehydrate does **not** scan rows to rebuild it. After the import loop,
`rehydrateCatalog` refreshes each connected `StoreTable`'s cached schema from the
now-current registry (import updates the registry but not the live table
instance), so DML maintains the rehydrated index and the derived `UNIQUE`
enforces. The backing store is reattached lazily on first access via
`provider.getIndexStore`. Partial indexes are maintained on DML too: the store's
index-update path honors the index `WHERE` predicate (only in-scope rows are
indexed), matching the build-time filtering.

**Best-effort durability.** Persistence follows the store's existing best-effort
contract: if the catalog write fails after a `CREATE INDEX` built the physical
index store, the in-memory schema has the index but the catalog does not, so on
reopen the index is missing and its store is orphaned. There is no two-phase
protocol here.

**Per-column PK key collation.** The store enforces PRIMARY KEY uniqueness/ordering
*physically* in the key bytes, encoding each PK column under its own declared collation
(`StoreTable.pkKeyCollations` — `BINARY` / `NOCASE` / `RTRIM`, the registered key
encoders). So **any** declared PK collation is honored natively: `x text collate binary
primary key` is keyed under BINARY, `collate nocase` under NOCASE, etc., reaching parity
with the memory module. The table-level key collation K (`config.collation`, one of
`BINARY` / `NOCASE`, default `NOCASE`) is now only a **default** for an undecorated text
PK column, plus the collation used for secondary-index *column* values. The schema entry
points:

- **CREATE.** `module.create` applies the store default K to an *implicit*-default text PK
  column (e.g. the engine's BINARY column default becomes NOCASE under K = NOCASE), so an
  undecorated text PK keeps the store's historical NOCASE-keyed behavior; an *explicit*
  `COLLATE` clause — even one diverging from K — is left exactly as declared and keyed
  under it. (The explicit-vs-implicit distinction rides on `ColumnSchema.collationExplicit`,
  set by `columnDefToSchema` only for a `COLLATE` clause.) Non-text PK columns (e.g.
  `integer primary key`) keep their declared collation — collation governs key bytes only
  for text.
- **Load path (`connect` / rehydrate).** The load path does **not** reconcile — the
  persisted DDL is the source of truth. The per-column key collation round-trips through
  the column's `COLLATE` clause (`generateTableDDL` elides the default `BINARY` and emits
  any non-`BINARY` collation explicitly), and the engine import path defaults a
  no-`COLLATE` column to `BINARY`, so the reloaded column collation matches the collation
  the physical keys were written under. (A genuinely *legacy* persisted DDL — written
  before per-column keying, whose declared collation may not match its key bytes — is
  loaded as-declared; the deferred reopen migration is tracked in
  `store-pk-collate-legacy-reopen-divergence`.)
- **`ALTER COLUMN … SET COLLATE` on a PK column** is honored by a **physical re-key**:
  `StoreTable.rekeyRows` re-encodes every data-store key under the column's new collation
  and `rebuildSecondaryIndexes` rebuilds each secondary index (whose keys embed the PK
  suffix). A re-key that would collide under the new collation (e.g. `'a'`/`'A'` distinct
  under BINARY but colliding under NOCASE) throws `CONSTRAINT` in the validation pass
  **without mutating the store** — all-or-nothing, mirroring `ALTER PRIMARY KEY`. A target
  equal to the column's current collation is a schema-only no-op (no re-key).

See [`docs/sql.md` § ALTER COLUMN](sql.md#27-alter-table-statement) for the
full SET COLLATE contract, including the non-PK UNIQUE re-validation and the
custom-comparator dedup residual (a comparator-only collation with no registered byte
encoder still keys/dedups under NOCASE bytes).

### View and materialized-view persistence

Views and materialized views are engine-level catalog objects that never pass
through a vtab-module hook, so the store persists them by subscribing to their
engine schema-change events (the same `SchemaChangeNotifier` it already uses for
`table_modified`). Each object's DDL is written under a **reserved-prefix** catalog
key so it can never collide with a same-named table entry (the engine enforces
name-disjointness, but the key namespace does not rely on it):

```
table key  =  encode(`{schema}.{table}`)             // unprefixed (unchanged)
view key   =  encode(`\x00view\x00{schema}.{view}`)
mv key     =  encode(`\x00mview\x00{schema}.{mv}`)
```

A leading `0x00` byte is a valid KV key byte for the in-memory, LevelDB, and
IndexedDB stores; table identifier keys never contain it, so `classifyCatalogKey`
routes each loaded entry to the right phase. `buildCatalogScanBounds()` is a full
range scan and returns the prefixed view/MV entries alongside table entries — that
is intended; rehydrate classifies and routes them.

**Incremental writes (the listener).** `view_added`/`view_modified` and
`materialized_view_added`/`_modified`/`_refreshed` regenerate the object's DDL
(`generateViewDDL` / `generateMaterializedViewDDL`, which read live tags) and
compare-write (skip identical); `view_removed`/`materialized_view_removed` delete
the entry. Unlike the table path there is no catalog-absent self-filter — one
`StoreModule` serves one `Database`, so its views/MVs belong in its catalog
unconditionally. The MV **backing** table (`_mv_<name>`, memory module) fires its
own `table_*` events, which the store keeps ignoring, so the backing is never
persisted (it is rebuilt on reopen). All writes ride the same serialized
`persistQueue` drained by `closeAll`/`whenCatalogPersisted`.

**Subscription is established in `rehydrateCatalog`** (not just lazily off the first
table hook), so a reopened DB persists subsequent view/MV DDL even when its first
post-reopen statement is a view. Gap: a brand-new DB never rehydrated, whose very
first DDL is a view, still relies on a prior store-table create/connect to subscribe.

**Rehydrate phasing.** `rehydrateCatalog` loads all entries once, classifies by key
prefix, then imports in dependency order — every phase through `importCatalog`:
(1) **tables** (connect to storage); (2) **views** (engine silent-register — body
validation deferred to query time, so view-over-view and view-over-MV are
order-independent and no event fires); (3) **materialized views** per entry (engine
re-materialize via the shared `materializeView` core: rebuilds the memory backing
from current source data, re-registers row-time maintenance, re-runs the eligibility
gate). Import is silent — no `materialized_view_added` fires — so rehydration writes
nothing back to the catalog and a second consecutive reopen yields identical catalog
bytes. MV-over-MV ordering uses a **fixpoint retry** (an MV whose body reads a
not-yet-built MV fails the round and succeeds once its dependency is built) rather
than a static topological sort — the resolved `sourceTables` (`_mv_<x>`) are not
serialized in the DDL, so they are unavailable before import. A genuinely unbuildable
MV — a missing (e.g. memory) source, an ineligible body, or an unresolvable cycle —
makes no progress in a round and is recorded in the `RehydrationResult.errors` array
(the result also gains additive `views` / `materializedViews` name arrays). An MV
over a non-persisted (memory) source is therefore an inherent limitation: its source
is absent on reopen, so it lands in `errors` and is not registered.

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
| `view_added` | `newObject: ViewSchema` | After `CREATE VIEW` (fired from the runtime emitter, not `Schema.addView`) |
| `view_removed` | `oldObject: ViewSchema` | After `DROP VIEW` |
| `view_modified` | `oldObject`, `newObject: ViewSchema` | After `ALTER VIEW … SET TAGS`, or when an `ALTER TABLE/COLUMN RENAME` rewrites a dependent view body |
| `materialized_view_added` | `newObject: MaterializedViewSchema` | After `CREATE MATERIALIZED VIEW` |
| `materialized_view_removed` | `oldObject: MaterializedViewSchema` | After `DROP MATERIALIZED VIEW` |
| `materialized_view_modified` | `oldObject`, `newObject: MaterializedViewSchema` | After `ALTER MATERIALIZED VIEW … SET TAGS` (catalog-only, no re-materialize) |
| `materialized_view_refreshed` | `object: MaterializedViewSchema` | After `REFRESH MATERIALIZED VIEW` |
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
- `ColumnAttributeChange` — per-column attribute drift within `columnsToAlter`: nullability, data type, default, **collation**, and tags. Each surfaces as the matching `ALTER COLUMN … SET …` statement. Column collation is projected into the diff catalog (`CatalogTable.columns[].collation`, default `'BINARY'`) so the differ detects a `COLLATE` change exactly as it does a type or default change; an absent `COLLATE` and an explicit `COLLATE BINARY` compare equal (no spurious diff). Unlike tags, collation is **behavioral** schema and participates in the schema hash.

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

Alongside renames, `computeTableAlterDiff` resolves the full **named-constraint lifecycle** by name: a user-named constraint in the catalog but absent from the declaration (and not consumed by a rename) → `TableAlterDiff.constraintsToDrop` → `DROP CONSTRAINT`; a declared user-named constraint absent from the catalog (and not a rename target) → `TableAlterDiff.constraintsToAdd` → `ADD <fragment>`. Declared constraints are gathered from **both** the table-level `constraints` list and column-level constraints carrying an explicit name (`qty int constraint chk_qty check (qty > 0)`), matching what the catalog's `namedConstraints` surfaces. Only **user-named** constraints participate: engine-synthesized auto-names (`_check_*` / `_fk_*` / `_uc_*`), PRIMARY KEY constraints (handled by `primaryKeyChange`), and UNIQUE constraints derived from a `CREATE UNIQUE INDEX` (`derivedFromIndex`, managed through their index) are excluded — keeping the diff stable/idempotent for unnamed and index-derived constraints. Under `require-hint`, a constraint add **and** drop on the same table with no rename hint is rejected, mirroring the table/column guard. **Note:** `ADD CONSTRAINT` applies a CHECK in place; a UNIQUE / FOREIGN KEY add routes through module `addConstraint`, which the built-in memory and store modules now implement — they **re-validate the existing rows** and fail atomically with `CONSTRAINT` (schema unchanged) when the current data violates the new constraint, otherwise installing forward enforcement. So a declarative add of a named UNIQUE / FK to an already-existing table now **converges** end-to-end (and a second apply is a no-op). FK existing-row validation is gated by `pragma foreign_keys` (off ⇒ the add skips the scan and defers enforcement to later writes); the store's UNIQUE existing-row check now honors each constrained column's per-column collation (`BINARY`/`NOCASE`/`RTRIM`), so a UNIQUE add — and the `CREATE UNIQUE INDEX` and `ALTER COLUMN … SET COLLATE` existing-row scans, which share the same `serializeRowKey` signature — correctly rejects pre-existing rows that collide only under that collation. (Residual: a *custom comparator-only* collation has no string normalizer and falls back to BINARY for the existing-row dedup, so it can under-reject at ALTER/add time even though write-time enforcement via the comparator is exact. A per-column **PRIMARY KEY** `SET COLLATE` on the store stays schema-only — the PK key bytes use a fixed table collation; its physical re-key is deferred to `store-set-collate-pk-physical-rekey`.) ADD / DROP / RENAME now all work for the three classes.

#### Constraint body-change detection (drop+recreate)

A constraint whose **name is unchanged but whose body changed** — an edited CHECK expression, a changed FK action / referenced table / columns, a changed UNIQUE column set or `ON CONFLICT` — is realized as **drop-old + add-new** (there is no in-place "redefine" primitive). For **UNIQUE / FOREIGN KEY** the re-add re-validates existing rows against the new rule (a violating row aborts the apply with `CONSTRAINT`, schema unchanged); for **CHECK** the re-add is **forward-enforcing only** and does **not** re-validate existing rows (a pre-existing limitation of the CHECK add path — see `runtime/emit/add-constraint.ts runAddCheck`), so a pre-existing row that violates the new CHECK is not re-checked until its next write. The two statements (DROP then ADD) are **not atomic** on the memory backend: a failed re-add leaves the old constraint already dropped (the spec/sqllogic tests assert only "apply aborts + data survives", not "old constraint restored"). **Rename reconciliation (no redundant drop+recreate):** the `definition` is rendered with the *current* column/table names on the actual side and the *declared* names on the declared side, so a name-matched constraint whose body differs *only* because of an identifier renamed in the **same** diff would naively register as a body change. To avoid a redundant drop+recreate **on top of** the rename, `computeTableAlterDiff` first compares the raw `definition` strings (the common no-rename case short-circuits) and, on a mismatch, re-compares a **rename-reconciled** declared body built by `reconciledDeclaredBody`: a surgical clone of the declared constraint AST with the in-diff renames *inverse*-applied — each renamed identifier rewritten from its new name back to the actual pre-rename name. CHECK expressions first inverse-rewrite **every in-diff table rename** over the expression — a table-qualified self-reference's qualifier (`check (t2.qty > 0)` declared after a `t`→`t2` rename reconciles to `t.qty > 0`) and a cross-table reference inside a subquery (`check (qty <= (select max(cap) from lim2))` declared after a `lim`→`lim2` rename) alike — via the runtime `renameTableInAst` rewriter — the exact inverse of the forward rewriter the rename migration runs over **all** tables' CHECKs, so the diff-side reconcile and the executed migration cannot drift; sequential application over the one clone is order-independent because `resolveRenames` makes rename chains/swaps unrepresentable (every rename's new name is absent from the actual catalog while every old name is present), so no rename's inverse output can match another's inverse input — and then reuse the runtime `renameColumnInCheckExpression` rewriter seeded with the OLD (actual) table name (correct unconditionally, since qualifiers are pre-normalized to OLD by the qualifier pass; both over one `cloneExpr` copy); UNIQUE / FK reconcile their column lists directly, and an FK additionally reconciles its referenced *parent table* against the table renames **and** its referenced *parent column* list against the parent table's column renames. Both are threaded in from `computeSchemaDiff` via a one-pass pre-resolution of every name-matched declared table's column renames, keyed by declared (new) table name — the same key an FK's `foreignKey.table` carries at diff time. A parent-table rename and a parent-column rename in the same diff reconcile together (look up the parent's column renames by the new parent name, then rewrite the table name back to old); a self-referential FK whose referenced column is renamed is covered by the current-table entry in that map. When the reconciled body matches the actual, only the rename is emitted (a metadata-only RENAME COLUMN / RENAME TABLE — no UNIQUE/FK re-validation scan, no non-atomic drop+add). A genuine body edit layered on a rename still differs after reconciliation, so the drop+recreate (and its RENAME suppression) is preserved. To see this, each entry of the catalog's `namedConstraints` carries a `definition`: a canonical **body fragment** (the `constraint <name>` prefix and `with tags (...)` suffix excluded) produced by `ddl-generator`'s `constraintToCanonicalDDL`. The declared side renders the same fragment from its AST via `ast-stringify`'s `constraintBodyToCanonicalString`; both funnel through one normalization so format/order-stable forms compare byte-equal. Normalization collapses parser-default-equivalent forms so they don't churn: a bare CHECK's default `INSERT|UPDATE` operation mask (vs an explicit `on insert, update`), a FK's default `RESTRICT` action, an elided referenced-column list, and the default `ON CONFLICT ABORT`. Bare column-name identifiers are **case-folded** (lowercased) throughout the canonical body — the UNIQUE / PRIMARY KEY column list, the FK local (child) **and** referenced (parent) column lists, the FK **referenced (parent) table** name, **and** the bare column references embedded in a CHECK *expression* (folded via a structural `lowerExprIdentifiers` clone that leaves string / blob / numeric / JSON literals, parameters, collation names, and cast/function names byte-exact) — matching Quereus's uniformly case-insensitive column resolution (the AST never records identifier quoting). So a constraint whose column reference, FK parent-table reference, or CHECK-embedded column reference case diverges from the *definition* case (or changes across re-declares) renders identically and does not churn a spurious drop+recreate; a literal-value change is still a genuine body edit and still recreates. (Subquery bodies inside a CHECK — `(select …)` / `exists` / `in (select …)` — pass through structurally rather than being descended into, a bounded limitation that stays symmetric on both diff sides.) For a name-matched (or rename-matched) constraint, `computeTableAlterDiff` compares `definition`; on drift it pushes the old name to `constraintsToDrop` and the declared fragment to `constraintsToAdd` (reusing the same buckets and `generateMigrationDDL` emission as the add/drop paths — DROP already orders before ADD within the table block). Crucially: a constraint's **tags are excluded from `definition`**, so a tag-only change yields an equal `definition` and takes the in-place `ALTER CONSTRAINT … SET TAGS` path — never a needless drop+recreate. When a constraint is both rename-matched **and** its body changed, the drop+recreate wins and the `RENAME CONSTRAINT` is suppressed (a rename-then-redefine is two ops where drop+recreate is one, and the new body must re-validate regardless); the recreate's `ADD` fragment carries the declared tags, so no separate `SET TAGS` is emitted. Body-change drop+adds are **excluded** from the `require-hint` add/drop count (they are deliberate recreates, not ambiguous renames). Body changes to *unnamed* constraints are not individually addressable (detection keys off names) and are out of scope.

#### Index body-change detection (drop+recreate)

An **index** whose name is unchanged but whose body changed — a flipped `UNIQUE`, an added/removed/reordered column, an `asc`↔`desc` direction flip, or an added/changed/removed partial `WHERE` predicate — is realized as **drop-old + recreate** (an index has no in-place "redefine" primitive), the same shape a materialized-view body change uses. Each `CatalogIndex` carries a `definition`: a canonical **body** string (`[unique ]index (<cols>)[ where <expr>]`) produced by `ddl-generator`'s `indexToCanonicalDDL`, which lifts the stored `IndexSchema` into a minimal `CreateIndexStmt` and renders it through `ast-stringify`'s `createIndexBodyToCanonicalString`; the declared side renders the same function over its AST, so the two are byte-comparable. Bare column-name identifiers in the index column list are **case-folded** (lowercased) in this body — the actual side lifts the column *definition* case (`tableSchema.columns[i].name`) while the declared side carries the as-written index reference case — so an index whose column reference case diverges from the definition (e.g. column `Email` indexed as `email`) renders identically and does not churn. The partial `WHERE` predicate's bare column references are likewise case-folded (via the shared `lowerExprIdentifiers`, which the constraint CHECK path also uses), so a predicate whose column-reference case changes across re-declares renders identically while its literals stay byte-exact — a genuine predicate edit still recreates. For a name- or rename-matched index, `computeSchemaDiff` compares the declared body against `matchedActual.definition`; on drift it pushes the actual (pre-rename) name to `SchemaDiff.indexesToDrop` and the declared `create [unique] index …` (with the declared tags) to `indexesToCreate` — `generateMigrationDDL` already orders index drops before creates, so the pair applies drop → recreate. **Tags** are **excluded from the body**: a tag-only change takes the in-place `ALTER INDEX … SET TAGS` path, never a recreate — mutually exclusive with a body recreate per index, body drift winning. **Per-column collation IS included** in the body, but only as an already-*resolved* effective value: both sides pre-resolve each column's collation the way the engine does at create/import time (explicit index `COLLATE`, else the table column's collation, else `BINARY`; normalized) before rendering — the actual side in `indexToCanonicalDDL`, the declared side in `schema-differ`'s `declaredIndexCanonicalBody` — so an inherited / default-`BINARY` collation that is unchanged renders identically (no churn on an inherited-`NOCASE` unique index) while a genuine per-column collation change recreates. **Concurrent column renames are reconciled** like the constraint path: `declaredIndexCanonicalBody` inverse-applies the index table's in-diff column renames (threaded in from `computeSchemaDiff`'s one-pass pre-resolution, keyed by the index's *declared* / new table name — so a table renamed in the same diff still resolves its column renames) to the declared body, rewriting each resolved bare column name, **and** each renamed column reference inside the partial `WHERE` predicate (via the shared `renameColumnInCheckExpression` over a `cloneExpr` copy), from its new name back to the actual pre-rename name. So a same-named index over a column renamed in the **same** diff matches the actual body and emits **only** the column rename (`RENAME COLUMN`, no index drop+recreate, so it never trips the `require-hint` index guard), while a genuine body edit layered on the rename still recreates. **Ordering is load-bearing**: the collation is resolved on the **new** (declared) column name *first* — the declared `ColumnDef` is keyed by it — and only then is the emitted name mapped back to its old form (reversing the order would look the collation up under the old name and miss it). The index body excludes the structural `on <table>` reference, so a *table* rename alone never churns the column list (indexed columns carry bare names) — strictly simpler than the constraint FK case, which also reconciles a parent table / parent column. A partial `WHERE` predicate carrying a **table-qualified** self-reference (`where t.active = 1`) *does* embed the table name in the body, so ALL in-diff table renames are threaded in and every embedded table name is inverse-rewritten NEW→OLD (via `renameTableInAst`, the exact inverse of the forward rewriter the rename migration runs over all tables; a *cross*-table reference is unreachable today — the memory backend rejects subqueries and any cross-table reference in partial-index predicates at create time — but the all-renames scope mirrors the forward rewriter and the constraint CHECK path) **before** the per-column rewrites — which are seeded with the index table's OLD name (its own rename resolved inside `declaredIndexCanonicalBody`), matching the pre-normalized qualifiers, exactly as the constraint CHECK path does. So a pure table rename (with or without concurrent column renames) over a qualified predicate emits only the rename op(s), while a genuine predicate edit layered on the rename(s) still recreates. (Accepted scope-naïveté, symmetric with the forward path: a subquery alias inside the predicate that happens to equal a renamed table's new name can inverse-rewrite and cause a spurious — but valid — recreate.) Like the constraint path, body-change recreates are **excluded** from the `require-hint` index add/drop count (they are deliberate recreates, not ambiguous renames); a genuine unhinted create+drop of two distinctly-named indexes still trips the guard. Implicit covering indexes (the secondary BTree backing a UNIQUE constraint) never participate in the index buckets — their lifecycle is the originating constraint's, handled by the named-constraint diff path. A **hidden** implicit index (no `quereus.expose_implicit_index`) is absent from `actualCatalog.indexes` entirely, so it never name-matches. An **exposed** implicit index (constraint tagged `quereus.expose_implicit_index = true`) *is* present in `actualCatalog.indexes` for introspection (`schema()` / `index_info()`), but the catalog marks it `CatalogIndex.implicit = true` and `computeSchemaDiff` filters it out of `actualIndexes` before building the rename/create/drop view — so a converged schema with an exposed implicit index diffs **empty**, never emitting a phantom `DROP INDEX IF EXISTS <name>` (and `ALTER INDEX … SET TAGS` on the exposed name routes onto the originating constraint, not the index buckets).

**Primary-key column renames** reconcile the same way (PK changes flow through `primaryKeyChange`, not the named-constraint path). Before comparing the declared PK sequence against the actual key, `computeTableAlterDiff` inverse-applies the in-diff column renames to the declared PK column *names* (reusing `inverseRenameConstraintColumns`), so a pure PK-column rename — already emitted as a metadata-only `RENAME COLUMN` — does not also churn a redundant `ALTER PRIMARY KEY`. Only **this table's own** column renames participate (a PK references only local columns, so no cross-table table/column-rename threading, unlike the FK body case). The reconciliation rewrites **names only**: `pkSequencesEqual` still compares direction, so a genuine `asc`→`desc` change layered on a renamed PK column still emits the PK change. And `primaryKeyChange.newPkColumns` keeps the **new (declared)** names, so a genuine membership/order change still ALTERs to the correct post-rename columns. A default-PK table (no explicit `PRIMARY KEY` ⇒ all columns are the key) is covered for free — renaming any column no longer churns a spurious PK change.

#### View / materialized-view definition-change detection (drop+recreate)

A **view** — plain or materialized — whose name is unchanged but whose **definition** changed is realized as **drop-old + recreate** (neither has an in-place "redefine" primitive). The canonical definition covers the three definitional parts: the explicit column list (`v(a, b)` — for an MV it also names the backing-table columns), the body (`astToString` of the QueryExpr), and the `insert defaults (col = expr, …)` clause (write-through behavior — a stale clause silently supplying an outdated default on insert was the original bug this detection closes). Name / schema / tags are excluded. One shared renderer — `ast-stringify`'s `viewDefinitionToCanonicalString` — produces it on **both** diff sides: the actual side from the live `ViewSchema` / `MaterializedViewSchema` fields (`CatalogView.definition`, populated by `viewSchemaToCatalog`), the declared side from the declared statement's fields. Plain views compare the strings directly; materialized views compare **hashes** — `MaterializedViewSchema.bodyHash` is `computeBodyHash` over this same canonical definition, stamped at create (`materializeView`) and re-stamped by the rename-propagation rewrite (`applyMaterializedViewRewrite`), so a clause-only or explicit-columns-only MV change now re-materializes exactly as a body change does. (An MV persisted before this hash-formula change re-hashes differently **iff** it carries a clause or an explicit column list — a one-time rebuild on the next apply; acceptable, back-compat is explicitly deferred.) **Tags are excluded from the definition**: a tag-only change takes the in-place `ALTER VIEW / ALTER MATERIALIZED VIEW … SET TAGS` path, and a definition recreate carries the declared tags and suppresses any separate `SET TAGS` — mutually exclusive per object, as for indexes/constraints. **No identifier case-folding** is performed — a deliberate asymmetry vs the constraint/index canonical bodies (which fold to avoid *expensive* churn, since their recreates re-validate rows / rebuild structures): a case-only edit recreates a plain view (free — data-less) or rebuilds an MV (the pre-existing behavior of the old select-only hash), and both sides render parser-produced ASTs through the one emitter, so keyword case / whitespace cannot churn regardless. **Concurrent renames are reconciled** like the constraint/index paths: on a raw mismatch (only — the converged case short-circuits), `reconciledDeclaredViewDefinition` re-renders the declared definition from a clone with every in-diff table rename inverse-applied NEW→OLD (`renameTableInAst`), then each renamed table's column renames NEW→OLD (`renameColumnInAst` over the body — the body's own FROM provides the scope; the column rewrites are seeded with the table's OLD name since the qualifier pass pre-normalizes). The `insert defaults` clause reconciles separately: its `column` names a **base-table** column of the view's FROM table (often projected away, so the body rewrite cannot catch it) and is inverse-renamed via the FROM tables' column renames — the lookup is FROM-scoped, so an unrelated table's rename cannot false-rewrite it — and its `expr` gets the same inverse rewriters, column renames via the CHECK-expression entry point seeded with the FROM table's OLD name (the expr has no FROM of its own, exactly like the constraint/index predicates). The explicit column list names the view's **own output columns** — stable identity — and passes through untouched. When the reconciled definition matches the actual, only the rename op(s) emit. For **column renames this is correctness-critical, not just churn-avoidance**: `generateMigrationDDL` emits view creates *before* the table-alter block where `RENAME COLUMN` lives, and `CREATE VIEW` plans its body at create time — an unreconciled recreate naming the NEW column would fail at apply (whole-TABLE renames are safe: they emit first). A genuine definition edit layered on a rename still differs after reconciliation and recreates; a definition-changed **rename-matched** view resolves to drop(actual old name) + create(declared new name), superseding the no-op rename (strictly better than the hint-matched silent no-op tracked in backlog `view-rename-hint-silent-noop`). View definition recreates are **excluded** from the `require-hint` view create/drop count (deliberate recreates, not ambiguous renames). **Residual hazard (known, documented, unsolved):** a *genuine* view/MV definition edit that ALSO references a column renamed in the same diff still emits its CREATE before the RENAME COLUMN and fails at apply — the same create-before-alter ordering MV rebuilds have always had; split such a migration into two applies (rename first, then the definition edit).

#### Tag-drift detection

`computeTableAlterDiff` also detects **metadata-tag drift** at three sites — the table (`TableAlterDiff.tableTagsChange`), each surviving column (`ColumnAttributeChange.tags`, computed in `computeColumnAttributeChange`), and each name-matched named constraint (`TableAlterDiff.constraintTagsChanges`). The schema hash deliberately excludes tags, so drift is detected **structurally** (an order-independent `stableStringify` compare) rather than via the hash. The rename-hint keys `quereus.id` and `quereus.previous_name` are excluded from the comparison (they drive rename detection, not data state, so a declaration carrying only a hint does not churn out a `SET TAGS` after the rename completes); all other reserved tags (`quereus.lens.*`, `quereus.expose_implicit_index`, …) *are* compared. `generateMigrationDDL` emits the drift as `ALTER TABLE … SET TAGS (…)` / `ALTER TABLE … ALTER COLUMN … SET TAGS (…)` / `ALTER TABLE … ALTER CONSTRAINT … SET TAGS (…)` **after** the structural ALTER phases, so a tag set lands on the post-rename column / constraint name. These `SET TAGS` mutations are **catalog-only**: the runtime swaps the in-memory schema and fires `table_modified` without calling `module.alterTable`. Store-backed modules persist DDL from their own `alterTable` hook, which this path bypasses; the generic store module instead recovers the change by subscribing to these `table_modified` events and re-writing its catalog DDL, so table / column / named-constraint tag mutations survive reconnect for store tables (index and view/MV tag persistence is still pending — backlog tickets `store-secondary-index-persistence` / `store-view-mv-persistence`). The same in-place catalog path backs the imperative per-key `ALTER TABLE … ADD TAGS` / `DROP TAGS` ergonomics, which the differ never emits (it always computes the full desired set and emits whole-set `SET TAGS`).

The differ detects the same drift on the other tagged catalog objects — **views**, **materialized views**, and **indexes** — on a name-matched object (no rename), surfacing it through `SchemaDiff.viewTagsChanges` / `materializedViewTagsChanges` / `indexTagsChanges`. `generateMigrationDDL` emits these as `ALTER VIEW … SET TAGS` / `ALTER MATERIALIZED VIEW … SET TAGS` / `ALTER INDEX … SET TAGS` (leaf metadata writes in the alter phase). Crucially, a view or materialized-view **tag-only** change takes this in-place path instead of a drop+recreate — an MV does **not** re-materialize the body; a definition change still drops+recreates (carrying the declared tags through the recreate — see [View / materialized-view definition-change detection](#view--materialized-view-definition-change-detection-droprecreate)), and the two are mutually exclusive per object. The view / MV setters re-register the in-memory schema object (firing `view_modified` / `materialized_view_modified` — distinct from the create events, so they invalidate cached write-through plans without re-registering maintenance); the index setter swaps the owning table's `IndexSchema` and fires `table_modified`. As at the table level, the same in-place catalog setters also back the imperative per-key `ALTER VIEW` / `ALTER MATERIALIZED VIEW` / `ALTER INDEX … ADD TAGS` / `DROP TAGS` ergonomics, which the differ never emits (it always computes the full desired set and emits whole-set `SET TAGS`).

#### Reserved-tag validation on the declarative path

`quereus.id` and `quereus.previous_name` are first-class entries in the typed reserved-tag registry (`src/schema/reserved-tags.ts`), not a differ-local allow-list. Before any rename resolution, `computeSchemaDiff` routes every declared object's tags through `validateReservedTags(tags, site)` at the physical declarative sites — `physical-table` (table), `physical-column` (column), `view-ddl` (view / materialized view), `physical-index` (index), `physical-constraint` (every table-level constraint, named or not — a table-level `WITH TAGS` clause is consumed even when the constraint is unnamed — **and** every inline column constraint's tags, which the parser populates only for a *named* inline constraint such as `qty integer constraint chk check (qty>0) with tags (...)`; an unnamed inline constraint defers its trailing tags to the column, so they validate at `physical-column` instead; rename detection still keys off named constraints only) — and raises the first error via the shared `raiseReservedTagDiagnostics` policy helper. This is the **same registry and the same hard-error-on-unknown severity** as the lens-compile, view-mutation, and advertisement paths: a misspelled or mis-sited `quereus.*` key (e.g. `quereus.previuos_name`, or a logical-column-only key like `quereus.lens.writable` on a physical table) now fails `apply schema` / `diff schema` loudly instead of being silently swallowed. The two rename hints carry value-schema `'string'` (a `quereus.id` may legitimately contain a hyphen, e.g. `'tbl-thing'`), so the existing rename flow is unchanged. An MV's `quereus.id` validates but is ignored (the differ supports no materialized-view rename).

The imperative `ALTER TABLE … SET TAGS` **and** `ALTER TABLE … ADD TAGS` paths route through the **same** registry at the matching site (`physical-table` / `physical-column` / `physical-constraint`) during plan-build (both carry `stmt.action.tags`, so they share the `setTags` build case), so a misspelled or mis-sited reserved key fails the statement loudly rather than being stored. `DROP TAGS` removes by key and carries no values, so it does **no** reserved-tag validation — dropping a reserved key is legitimate. The sibling `ALTER VIEW` / `ALTER MATERIALIZED VIEW` / `ALTER INDEX … SET TAGS` **and** `… ADD TAGS` statements validate at the `view-ddl` (view / MV) and `physical-index` (index) sites the same way (both carry `action.tags`, sharing the `setTags` build case); their `… DROP TAGS` forms, like the table-level one, carry no values and so do no reserved-tag validation — dropping a reserved key is legitimate.

The two imperative `ALTER TABLE … ADD` arms validate identically (`planner/building/alter-table.ts`), closing the last asymmetric gap on the authoring surface: `ADD CONSTRAINT … WITH TAGS` checks the constraint's tags at `physical-constraint`, and `ADD COLUMN … WITH TAGS` checks the new column's tags at `physical-column` **plus** each of its inline named constraints' tags at `physical-constraint`. The per-column accumulation is shared with the direct `CREATE TABLE` path via `columnTagDiagnostics` (`planner/building/tag-diagnostics.ts`), and all build-path surfaces (`CREATE TABLE` / `CREATE INDEX` / `ALTER … ADD` / `ALTER … SET TAGS`) raise through one sited helper, `raiseStmtTagDiagnostics`, so they can never drift. As on every other path, an unnamed inline constraint's trailing `WITH TAGS` defers to the column (the parser populates `ColumnConstraint.tags` only for a *named* inline constraint), so it validates once at `physical-column` with no double-validation.

The **direct** `CREATE TABLE … WITH TAGS` and `CREATE INDEX … WITH TAGS` paths validate identically at plan-build (`planner/building/ddl.ts`), mirroring the four physical surfaces the differ checks for a declared table — table-level tags at `physical-table`, each column's tags at `physical-column`, each table-level (named or unnamed) constraint's tags at `physical-constraint`, and each inline column constraint's tags (populated only for a *named* inline constraint) also at `physical-constraint` — plus `physical-index` for `CREATE INDEX`. The per-column legs (a column's own tags + its inline constraints' tags) come from the shared `columnTagDiagnostics` helper the `ALTER … ADD COLUMN` path also calls; diagnostics accumulate table → per-column → table-constraints and the first error is raised once with the statement's source location. So a typo'd or mis-sited reserved key (`"quereus.bogus"`, or a `logical-table`-only key like `quereus.lens.access.<col>` on a physical table) is rejected at create time on the most common authoring path, not silently stored. Validation fires even under `IF NOT EXISTS` (build-time, before the runtime existence check) and regardless of the `nondeterministic_schema` option (tags are not expressions). Free-form (non-`quereus.*`) tags are skipped untouched. Two scoping notes: (1) `CREATE VIEW` / `CREATE MATERIALIZED VIEW … WITH TAGS` are deliberately **not** eagerly validated — view tags are validated lazily on the view-mutation path (no reserved key carries view behavior; the only keys legal at `view-ddl` are the inert differ rename hints); (2) the catalog **import/load** path (`SchemaManager.buildTableSchemaFromAST` reached by `importTable` / `importCatalog`) is an authoring-time gate's blind spot by design — it re-loads already-persisted DDL and must not start rejecting an openable database.

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
