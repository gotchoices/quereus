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

### TableDerivation / maintained tables

A table is a stored relation; a *derivation* is an optional maintenance contract attached to it. A **maintained table** — what `create materialized view` produces — is one ordinary `TableSchema`, registered under the view's own name, carrying a `derivation: TableDerivation` (`schema/derivation.ts`; `MaintainedTableSchema = TableSchema & { derivation: TableDerivation }`). One record, one catalog name, one physical incarnation: identity (name/schema), storage (`vtabModuleName`/`vtabArgs` — the backing-host module), tags, and the physical primary key all live on the owning table, and the canonical `create materialized view` DDL renders on demand via `generateMaterializedViewDDL`. `TableDerivation` carries:

- **`selectAst`** — the parsed body AST, which itself carries the trailing `with defaults (...)` clause on `SelectStmt.defaults` (consumed by the write-through rewrite — read it via `bodyDefaults`); **`columns`** — the explicit MV column list (`mv(a, b)`), when declared.
- **`bodyHash`** — `computeBodyHash` over the canonical definition (explicit column list + body, where the body string already carries any `with defaults (...)` clause, rendered by `viewDefinitionToCanonicalString`), used by the declarative-schema differ to detect "definition changed → rebuild" — so a defaults-only edit drifts the hash without a separately-itemized field.
- **`logicalKey`** — the body's logical key (the table's own `primaryKeyDefinition` stays the physical, order-by-seeded key); **`ordering`** — the captured body ordering; **`coarsenedKey`** — the collation-coarsened lineage key, when applicable.
- **`sourceTables`** — qualified names of the tables the body reads.
- **`stale`** / **`sourceScope`** — runtime maintenance state (never serialized): the staleness flag and the cached source-union change-scope a `select` from the table substitutes for `Database.watch`.
- **`covers`** — the covering-structure reverse link (below).

Full design: [Materialized Views](materialized-views.md).

### Covering-structure links

A UNIQUE constraint is logical; the structure that enforces it is optional (see [Materialized Views § Covering structures](materialized-views.md#covering-structures)). Two schema fields record the constraint↔structure association:

- **`UniqueConstraintSchema.coveringStructureName`** — the **forward pointer** and **source of truth**: the name of the covering structure realizing this constraint (an auto-built secondary index, or an explicit covering materialized view — the maintained table's own name — recognized by the coverage prover). Set eagerly when a covering MV is created; cleared when that MV is dropped.
- **`TableDerivation.covers`** — the convenience **reverse link** `{ schemaName, tableName, constraintName? }` back to the covered constraint.

The `origin` vocabulary (`'implicit-from-unique-constraint'`, the auto-built secondary BTree described in covering-structure terms) lives only on the memory-table manager's `ImplicitCoveringStructure` association — it is not a catalog field.

These links are informational in the current release (enforcement still routes through the synchronously-maintained auto-index — see the materialized-views soundness note).

**Introspection.** The implicit covering structure (a UNIQUE constraint's auto-built index) is a backing detail and is **omitted from `collectSchemaCatalog` / schema export by default**. It is surfaced only when the originating constraint carries the tag `quereus.expose_implicit_index = true`. Indexes from an explicit `CREATE [UNIQUE] INDEX` are always shown.

Once exposed, the implicit index is **addressable and introspectable identically across backends** — it appears in `schema()` and `index_info()`, and `ALTER INDEX … {SET|ADD|DROP} TAGS` targets it. Backends differ only in *where the user tags live*: the memory backend materializes the implicit index as an `IndexSchema`, so its tags sit on `IndexSchema.tags`; backends that do not materialize it (the store, which enforces UNIQUE by full-scan over `uniqueConstraints`) derive a synthetic exposed index from the constraint in the read paths (`exposedImplicitIndexes` in `catalog.ts`) and route `ALTER INDEX … TAGS` onto a separate `UniqueConstraintSchema.exposedIndexTags` field. The asymmetry is internal; observable behavior is identical. A *hidden* implicit index (tag absent/false) stays unaddressable (`NOTFOUND`) on both — its tags live on the constraint, reached via `ALTER TABLE … ALTER CONSTRAINT … TAGS`. `exposedIndexTags` survives a store close→reopen: the table's catalog bundle carries a trailing `alter index … set tags (…)` line (see [Store catalog persistence](#store-catalog-persistence-bundled-index-ddl)) that `importDDL` re-applies silently on rehydrate. One deliberate divergence: tags are only addressable — and only *persisted* — while the constraint is exposed. Dropping the exposure flag (`ALTER TABLE … ALTER CONSTRAINT … DROP TAGS`) leaves `exposedIndexTags` dormant in-session (re-exposing resurrects it), but the bundle emits no `alter index` line for an unexposed constraint, so after a reopen taken while unexposed, re-exposing yields no tags.

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
| `getMaintainedTable(schemaName, name)` | Retrieves a [maintained table](#tablederivation--maintained-tables) (a derivation-bearing table — a materialized view) by name, or `undefined` for a plain table or no table |
| `getAllMaintainedTables()` | Returns every maintained table across all schemas |
| `attachDerivation(schemaName, tableName, derivation)` | Attaches (or replaces) a `TableDerivation` on an already-registered table, swapping the registered record. Fires no event — callers own the event discipline |
| `getView(schemaName, viewName)` | Retrieves a view definition |
| `getSchemaItem(schemaName, itemName)` | Returns a table or view by name (views take priority on name conflict) |
| `getTableTags(tableName, schemaName?)` | Returns metadata tags for a table, or `undefined` |
| `setTableTags(tableName, tags, schemaName?)` | Replaces a table's metadata tags (pass `{}` to clear); fires `table_modified` |
| `setColumnTags(tableName, columnName, tags, schemaName?)` | Replaces a column's metadata tags (pass `{}` to clear). Catalog-only — column nullability / type / default / PK membership are untouched. Throws `NOTFOUND` for an unknown table or column |
| `setConstraintTags(tableName, constraintName, tags, schemaName?)` | Replaces a **named** table-level constraint's metadata tags (pass `{}` to clear). Lookup order CHECK → UNIQUE → FOREIGN KEY; throws `NOTFOUND` for no match and `ERROR` for a name ambiguous across classes |
| `setViewTags(viewName, tags, schemaName?)` | Replaces a view's metadata tags (pass `{}` to clear). Catalog-only — re-registers the `ViewSchema`; throws `NOTFOUND` for an unknown view |
| `setMaterializedViewTags(name, tags, schemaName?)` | Replaces a materialized view's metadata tags (pass `{}` to clear). Catalog-only — re-registers the maintained `TableSchema` (the shared `derivation` object rides the swap) and fires `materialized_view_modified`; never touches the contents or re-materializes. Throws `NOTFOUND` for an unknown MV |
| `setIndexTags(indexName, tags, schemaName?)` | Replaces an index's metadata tags (pass `{}` to clear). Resolves the owning table from the index name, swaps the `IndexSchema`, and fires `table_modified`. Throws `NOTFOUND` for an unknown index or a hidden implicit covering index (its tags live on the originating constraint) |
| `findSchemasContainingTable(tableName)` | Returns all schema names containing the table — useful for error messages |
| `findFunction(funcName, nArg)` | Finds a function by name and argument count |

**Persistence of catalog-only tag swaps (store-backed tables).** The tag setters above (and the equivalent `ALTER … SET TAGS`) are catalog-only — they swap the in-memory schema and fire a change event but deliberately do **not** call `module.alterTable`. The generic store module (`@quereus/store`) still re-persists them: it subscribes to the engine's `table_modified` events and re-writes the table's catalog DDL (via `generateTableDDL`) whenever the serialized form changes. So **table**, **column**, and **named-constraint** tags now survive close → reopen → `rehydrateCatalog` for `using store` tables. The re-write is a read-compare-write keyed by `{schema}.{table}`: a table with no catalog entry (a memory table, or a store table never persisted) is skipped, and a structural ALTER — whose own `alterTable` already wrote the final DDL — produces identical bytes and is skipped (no double-write). The same subscription now also persists **views** and **materialized views**: the store listens for `view_added`/`view_removed`/`view_modified` and `materialized_view_added`/`_removed`/`_modified`/`_refreshed`, writing each object's DDL (via `generateViewDDL` / `generateMaterializedViewDDL`) under a reserved-prefix catalog key. So **view** and **materialized-view** tags (`setViewTags` / `setMaterializedViewTags`), as well as `CREATE`/`DROP VIEW` and `CREATE`/`DROP MATERIALIZED VIEW`, now round-trip too (see [Store catalog persistence](#store-catalog-persistence-bundled-index-ddl) for the key namespaces and rehydrate phasing). An *exposed implicit index*'s user tags (held on `UniqueConstraintSchema.exposedIndexTags`, with no `CREATE INDEX` line to ride) round-trip through the same listener: the regenerated bundle appends an `alter index … set tags (…)` statement per exposed implicit index with non-empty tags, and `importDDL` re-applies it silently on rehydrate.

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

**FOREIGN KEY collation validation (declaration time).** After the module
returns the finalized schema and **before** the table is registered, `createTable`
rejects any declared FK whose child column and parent key column carry a same-rank
conflicting collation — the exact conflict the synthesized `parent.k = child.fk`
enforcement comparison would raise at the first DML — resolved through the same
comparison-collation lattice (`schema/constraint-builder.ts`
`validateForeignKeyCollations`; see docs/types.md § Comparison collation
resolution). The same check runs on the universal `ALTER … ADD CONSTRAINT` and
`ALTER … ADD COLUMN` emit paths (so memory and store are covered with one
validator) and, transitively, on declarative apply. On every path the check runs
**before any persistence side effect**: `createTable` validates before `addTable`,
`ADD COLUMN` inside its validate-before-swap revert region, and `ADD CONSTRAINT`
**before** `module.alterTable` (the store backend's addConstraint arm
`saveTableDDL`'s the FK before returning, so a post-call throw would leave a
rejected FK on disk to rehydrate on the next reopen). It is **unconditional** —
unlike the FK existing-row scan it is *not* gated on `pragma foreign_keys`, since
a contradictory collation pairing is a malformed declaration (same class as a
child/parent column-count mismatch), not an enforcement concern. Two residuals
are intentional: a **forward-declared parent** (not yet created when the child is
declared) cannot be checked — its column types are unknown — so that conflict
stays caught at first DML; and reload / `importTable` does **not** re-validate, so
a legacy persisted conflicting FK reloads without error and surfaces only at DML.

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

When `pragma foreign_keys` is on, the drop is first gated by a referencing-child scan (a non-NULL FK row in any *other* table forbids the drop; self-FK rows go away with the table). That scan routes through the **reverse foreign-key index** rather than walking the whole catalog — see below.

#### Reverse foreign-key index

`getReferencingForeignKeys(parentSchemaName, parentTableName)` returns the FKs that reference a given parent `schema.table`, the shared primitive every parent-side referential scan uses to short-circuit. It is a lazily-built, event-invalidated derived cache on `SchemaManager`: a `Map` from the **referenced** `schema.table` (lowercased, resolved exactly as the scans compute their target: `fk.referencedSchema ?? childTable.schemaName` — so a declared FK keys under its **parent's** schema, which is the explicit `references <schema>.<table>` qualifier when one was written and otherwise defaults to the child's own schema for an unqualified parent) to the `{ childTable, fk }` entries that reference it. A table nothing references yields a shared frozen empty array — the O(1) gate that replaces an `O(tables × FKs)` catalog walk; the returned `fk` is the same object held in `childTable.foreignKeys` (identity preserved). Entries stay in schema-insertion → table → FK-declaration order so a first-surviving-child RESTRICT pre-check names the same child it did under the nested-loop scan.

The cache is `null`ed (rebuilt from the live catalog on next access) on every mutation that can add/drop/retarget an FK or add/remove a schema: a self-subscription to the `SchemaChangeNotifier` resets it on any `table_added` / `table_modified` / `table_removed` (the only events through which an FK enters/leaves/retargets — create-with-references, ALTER ADD/DROP CONSTRAINT, a parent/column-rename FK rewrite, and DROP TABLE), and `addSchema` / `getOrCreateSchema` / `removeSchema` reset it directly since ATTACH/DETACH fire no event. The silent catalog-rehydration path resets it too: `importTable` registers FK-bearing tables without firing `table_added` (and `getOrCreateSchema` only resets when it *creates* a schema), so it nulls the index directly — otherwise a re-import onto an already-built index would under-report. Under-reporting would silently drop enforcement, so invalidation is deliberately broad (over-reporting a since-dropped FK is harmless — the index key already enforces the `referencedTable` / target-schema match (so the consumers that route through it dropped those two filters), and each per-FK body still re-checks arity, its action gate, and the MATCH-SIMPLE NULL skip); the lazy first-access rebuild after a (rare) DDL amortizes across the many DML writes between DDLs.

#### Lens basis-FK gate

The **logical-FK analogue** of the reverse-FK index. A *logical* FK lives only on a child lens slot's `enforced-fk` obligation (on no basis table), so it is invisible to the reverse-FK index — which scans declared `TableSchema.foreignKeys`. Three basis-keyed lens FK paths reverse-map a written **basis** parent table to the logical parent slot(s) it backs, then walk every schema's lens slots for referencing logical FKs: the runtime cascade walker `executeLensForeignKeyActions`, the runtime RESTRICT pre-check `assertLensRestrictsForParentMutation`, and the divergent-basis-action suppression set `basisFksOverriddenByDivergentLensFk`. The gate gives all three the same O(1) short-circuit the index gives the physical paths.

`basisTableBacksLogicalParentFk(schemaName, tableName)` answers: does this basis `schema.table` back ≥1 logical parent slot referenced by ≥1 logical FK? It is a lazily-built, event-invalidated derived `Set<string>` on `SchemaManager` keyed by the **basis parent** `schema.table` (lowercased) — exactly the value each basis write carries. `buildLensBasisFkGate` (in `lens-fk-discovery.ts`) builds it by running, once, the same reverse-map slot scan the three paths perform per write: for each lens slot, resolve its single basis spine (`resolveSlotBasisSource`; a multi-source / decomposition parent resolves to none and contributes no key — *consistently* with the runtime `if (!basis) continue` skip), and add the basis key iff `findLogicalParentFkRefs(slot).length > 0`. A `false` answer early-returns each of the three paths; a `true` answer runs the full scan as the on-hit confirmation.

The gate is `null`ed (rebuilt on next access) on every event that can change that scan's result, across **two** dependencies — the lens-slot set and the basis-table catalog (`resolveSlotBasisSource` resolves a bare table name against it):

- **Lens deploy / redeploy** — the slots are mutated only by `lens-compiler.deployLogicalSchema`'s clear-and-rebuild, which fires **no** `SchemaChangeEvent` (there is no lens event in the union), so it calls `invalidateLensFkGate()` directly, sibling to the snapshot rotation.
- **Basis-table catalog** — the same `SchemaChangeNotifier` self-subscription that resets the reverse-FK index also resets the gate on `table_added` / `table_modified` / `table_removed` (a basis table created *after* the gate was built is the under-report vector; a drop or column-rename can change which slot resolves to which basis).
- **Schema attach/detach + reset + silent import** — `addSchema` / `getOrCreateSchema` / `removeSchema` / `clearAll` (ATTACH/DETACH/reset fire no event) and the silent `importTable` rehydration path all null the gate alongside the reverse-FK index.

The load-bearing invariant is the same as the index's, and **sharper**: a stale gate that **under-reports** would silently drop logical enforcement (cascade not propagated / RESTRICT not enforced / divergent basis action not suppressed) — so invalidation is exhaustive. Built from, and reset alongside, the same catalog state the three paths scan, the gate **never under-reports** for the current catalog; over-reporting (a stray key ⇒ an on-hit scan that finds nothing ⇒ same result, slower) is harmless. The gate is action-agnostic (keyed on *any* referencing logical FK), so a slot referenced only by a RESTRICT logical FK is a hit for all three paths — each then filters by action in its own body (the cascade walker on non-RESTRICT, the RESTRICT pre-check on RESTRICT), an over-report that is correct, not a miss.

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

#### `importCatalog(ddlStatements, options?): Promise<{ tables: string[]; indexes: string[]; views: string[]; materializedViews: string[] }>`

Imports existing schema objects without creating new storage. Used when connecting to a backend that already contains data. For each DDL statement:
- `CREATE TABLE` calls `module.connect()` instead of `module.create()`
- `CREATE INDEX` registers the index metadata without calling `module.createIndex()`, reconstructing the index with full fidelity from the re-parsed DDL — the `UNIQUE` flag, the partial `WHERE` predicate, and per-column collation (including the collate-wrapped column form the parser folds `COLLATE` into). A `CREATE UNIQUE INDEX` also re-synthesizes its `derivedFromIndex` UNIQUE constraint, exactly as the live create path does.
- `CREATE VIEW` registers a plain view **without planning the body** — body validation is deferred to first reference (mirroring how `importTable` defers create-time work via `connect`). This makes view rehydration order-independent: a view over another view, a materialized view, or a not-yet-imported relation registers regardless of phase order, and a broken body surfaces only when the view is queried. The imported view name appears in the `views` result array.
- `CREATE MATERIALIZED VIEW` **re-materializes** through the same `materializeView` core the create emitter uses (`runtime/emit/materialized-view-helpers.ts`): the body is re-planned against the already-imported sources, the maintained table is rebuilt and filled **in the declared `USING <module>(...)` backing-host module** (memory when the clause is absent; an unknown or capability-less module fails the entry), and row-time maintenance is re-registered — but no `materialized_view_added` fires (`table_added` for the maintained table still does, as on create). A pre-existing **derivation-less** table at the MV's **own name** in the entry's backing module (a durable module's phase-1 rehydration of the maintained table) is **adopted** when the options below allow and every adopt gate passes, and otherwise dropped and refilled from the body; a table there in a **different** module — or a maintained table already at the name — fails the entry without touching it. Unlike a plain view the body plans **eagerly** (the table cannot fill without running it), so MV import is order-dependent: sources — including another maintained table for MV-over-MV — must already be registered. A body that cannot plan, reads a still-pending maintained table (`pendingDerivations` below), fills with duplicate keys ("must be a set"), or fails the row-time eligibility gate throws after the half-built table is rolled back (a trusted pre-existing backing is instead preserved as a plain table — durable rows are not destroyed on a per-entry error). The imported MV name appears in the `materializedViews` result array.
- Schema change events are not emitted (these are existing objects)

**Options** (`ImportCatalogOptions`) — all default off; a plain `importCatalog(ddl)` always refills:
- `trustBackings` — caller-attested trust in pre-existing durable backings: the caller asserts no crash since they were last written (the store module sets this from its consumed clean-shutdown catalog marker). This is adopt gate 5; the full gate set and its rationale live in [`docs/materialized-views.md` § Cross-module atomicity](materialized-views.md#cross-module-atomicity).
- `adoptedBackings` — a shared `Set<string>` of lowercased qualified table names (`schema.<table>`) of every maintained table adopted so far this rehydration session (appended on each adopt). An MV whose body reads another maintained table adopts only when that upstream is in the set — pass ONE set across all of the session's `importCatalog` calls so trust composes through fixpoint rounds.
- `pendingDerivations` — lowercased qualified names of maintained tables whose own `create materialized view` entries have NOT yet imported this session. An entry whose body reads any of these is deferred (throws, to be retried in a later fixpoint round): the source already exists as a *plain* pre-rehydrated table, so the body would plan — and adopt/refill against content the upstream's own import may be about to replace.

Each entry in `ddlStatements` may hold **more than one** statement: a table can be bundled with the `CREATE INDEX`es that belong to it in a single string, imported in document order (so the table precedes its indexes). Single-statement entries remain valid. Any unsupported statement type throws (fail-loud), so the store's `rehydrateCatalog` records the failure rather than silently dropping the object.

### DDL Generation

Canonical schema → DDL generators are exported from the package entry point:

```typescript
import { generateTableDDL, generateIndexDDL, generateViewDDL, generateMaterializedViewDDL, generateIndexTagsDDL } from '@quereus/quereus';

const ddl = generateTableDDL(tableSchema, db?);                  // CREATE TABLE ...
const idxDdl = generateIndexDDL(indexSchema, tableSchema, db?);  // CREATE INDEX ...
const viewDdl = generateViewDDL(viewSchema);                     // CREATE VIEW main.v ...
const mvDdl = generateMaterializedViewDDL(maintainedTable);      // CREATE MATERIALIZED VIEW main.mv ...
const tagDdl = generateIndexTagsDDL(schemaName, indexName, tags); // alter index s.i set tags (...)
```

`generateViewDDL` / `generateMaterializedViewDDL` lift the stored schema back into the equivalent `CreateView` / `CreateMaterializedView` AST and render it through the shared `ast-stringify` emitter (the same schema→AST-lift strategy `generateTableDDL` uses for constraints), so the persistence path and the declarative AST→SQL path cannot drift. They emit a **fully-qualified** (`schema.name`) name so a re-parse registers into the correct schema regardless of the session's current schema, and read the **live** `tags` — so an `ALTER VIEW … SET TAGS` (which swaps the in-memory schema without rewriting the stored `sql`) round-trips. `generateMaterializedViewDDL` takes the maintained `TableSchema` (the unified record) and re-derives the `USING <module>(...)` clause from the table's own `vtabModuleName`/`vtabArgs` through `normalizeBackingModule`, which yields a clause only when the hosting module is non-default (`using memory()` with no args normalizes to nothing, so the memory default stays clause-free and canonical) — on reopen the import path honors the clause and rebuilds the table in the named module. Both are a `parse → generate → parse` fixed point.

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
first, then one `CREATE [UNIQUE] INDEX` line per persistable index, then one
`alter index … set tags (…)` line per *exposed implicit index* carrying user
tags:

```
CREATE TABLE "main"."t" (...) USING store
CREATE INDEX "ix_b" ON "main"."t" ("b")
CREATE UNIQUE INDEX "uq_email" ON "main"."t" ("email" COLLATE NOCASE) WHERE "email" IS NOT NULL
alter index main.uq_vin set tags (purpose = 'lookup')
```

`StoreModule.buildCatalogEntry` produces the bundle (table DDL + every index DDL,
both in the persistence-safe no-`db` form; the `alter index` lines via
`generateIndexTagsDDL`, the schema→AST-lift over the shared `alterIndexToString`
emitter — its lowercase keywords are cosmetic, both forms re-parse). Hidden
implicit covering indexes (the auto-built BTree backing a declared inline
`UNIQUE`) are excluded — they round-trip via the table's `UNIQUE` constraint,
not as a standalone `CREATE INDEX`. An *exposed* implicit index is likewise
never emitted as a `CREATE INDEX` (a re-import would materialize a real
`IndexSchema`, changing the store-mode shape); only its user tags
(`UniqueConstraintSchema.exposedIndexTags`) persist, as a whole-set
`alter index … set tags` statement (always the canonical replace form; empty tag
records emit no line). On reopen, `rehydrateCatalog` feeds each bundle to
`importCatalog`, whose `parser.parseAll` splits it by AST (never on `\n`, so a
newline inside a `DEFAULT` / `CHECK` / partial-predicate string literal is safe)
and imports table-before-indexes; the trailing `alter index` lines re-apply
silently (no change event, no entry in the import results) against the
just-imported table, whose `CREATE TABLE` earlier in the same bundle carries the
constraint and its exposure flag.

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
  `tableSchema.indexes`; exposed-implicit-index tags on the originating
  constraint's `exposedIndexTags`) with no index-specific plumbing.
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
  under it. This means the same DDL `create table t (x text primary key)` yields **BINARY
  under the memory module** (`'a'` and `'A'` are distinct rows) and **NOCASE under the
  store** (`'a'` and `'A'` collide). This is intentional — the memory side honors the
  session `default_collation` (BINARY out of box, via `resolveDefaultCollation` in
  `quereus/src/schema/table.ts`), while the store side preserves its on-disk NOCASE
  semantics for undecorated text PKs. An authored lens (bijection inverse) for a text PK
  will therefore be read-only under the store default but writable under memory, because
  the value-discriminating check requires BINARY-level distinct 'a'/'A' to prove
  injectivity. (The explicit-vs-implicit distinction rides on `ColumnSchema.collationExplicit`,
  set by `columnDefToSchema` for a `COLLATE` clause, and — for a **materialized-view backing
  column** — by `deriveBackingShape` (`materialized-view-helpers.ts`) when the body output
  column's collation provenance is `explicit` or `declared`. So an MV whose key column
  publishes a deliberate collation — an explicit `collate …` projection or a passthrough of
  a declared-collation source column — is keyed under that published collation across the
  reconcile, while a genuinely-implicit MV column keeps the store-default reconcile, exactly
  like an undecorated base-table PK.) Non-text PK columns (e.g.
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

**Index-derived UNIQUE enforcement collation.** A `CREATE UNIQUE INDEX … (col COLLATE x)`
synthesizes a `derivedFromIndex` UNIQUE constraint whose DML enforcement resolves each
column's comparison collation from the **index's** per-column `COLLATE` clause (falling
back to the declared column collation when the index column carries none) —
`StoreTable.uniqueEnforcementCollations`, matching memory's `checkUniqueViaIndex`, the
store's own `buildIndexEntries` build-time dedup, and SQLite (a unique index enforces
under the index's collation). So a *finer* index (`COLLATE BINARY` over a `NOCASE` column)
admits case-variants the column would unify, and a *coarser* index (`COLLATE NOCASE` over a
`BINARY` column) unifies case-variants the column would keep distinct. When **two** UNIQUE
indexes cover the same column-set with differing collations, each derived constraint enforces
under **its own** index's collation regardless of index creation order: memory's
`findIndexForConstraint` resolves the enforcing index BY NAME (`uc.derivedFromIndex`), matching
the store's by-name `uniqueEnforcementCollations` — a by-column-set resolution would collapse
both constraints onto the first-listed index and under-enforce the coarser one
(`memory-multi-index-unique-collation-resolution`). `ALTER COLUMN … SET
COLLATE` on a column under such an index propagates the new collation into the index
column (metadata-only — the store's index *key* bytes use the table-level collation K, so
no entry re-encode is required), mirroring the memory module; a non-derived (table-level /
column) UNIQUE always enforces under the declared column collation — even when a *finer*
same-column-set `CREATE UNIQUE INDEX` already exists (either DDL order). Memory does **not**
reuse such a finer index as the constraint's realizing structure: it builds the constraint's
own declared-collation covering index and `findIndexForConstraint` resolves the non-derived UC
to that structure BY NAME (via `getImplicitCoveringStructure`), so the two indexes coexist and
each enforces its own equivalence (matches SQLite and the store, which never reused the user
index) (`memory-nonderived-unique-reused-finer-index-under-enforcement`). When a row-time covering
materialized view is *also* linked to such a constraint, a finer/incomparable index collation
disqualifies the MV from answering it — see the [covering-MV collation eligibility
gate](materialized-views.md#enforcement-through-a-covering-mv) — so enforcement falls back to
this per-scan / auto-index path (still under the index collation). The gate reads the same
`index.columns[i].collation` this resolver does, so the two stay consistent across an `ALTER
COLUMN … SET COLLATE`.

### View and materialized-view persistence

Views and materialized views are engine-level catalog objects that never pass
through a vtab-module hook, so the store persists them by subscribing to their
engine schema-change events (the same `SchemaChangeNotifier` it already uses for
`table_modified`). Each object's DDL is written under a **reserved-prefix** catalog
key so it can never collide with a same-named table entry — essential for a
store-hosted materialized view, whose maintained table persists its own unprefixed
table bundle under the very same `{schema}.{name}`:

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
unconditionally. A **store-hosted** maintained table additionally persists its
ordinary (unprefixed) table bundle through the table channel — its rows and shape
reconnect as a plain table in rehydrate phase 1, for phase 3's MV entry to adopt
or refill. A **memory-hosted** maintained table's `table_*` events stay ignored
(memory tables are never persisted as bundles), so exactly one catalog entry —
the MV form — persists, and it always refills on reopen. All writes ride the same
serialized `persistQueue` drained by `closeAll`/`whenCatalogPersisted`.

**Subscription is established in `rehydrateCatalog`** (not just lazily off the first
table hook), so a reopened DB persists subsequent view/MV DDL even when its first
post-reopen statement is a view. Gap: a brand-new DB never rehydrated, whose very
first DDL is a view, still relies on a prior store-table create/connect to subscribe.

**Rehydrate phasing.** `rehydrateCatalog` first consumes the clean-shutdown
marker (the reserved `\x00meta\x00clean_shutdown` catalog entry `closeAll` writes
after every batch flushed — read and immediately deleted, single-use; its value is
the JSON set of `schema.mv` names that were **stale-at-close**), then loads
all entries once, classifies by key prefix (meta entries never reach DDL import;
`loadAllDDL` filters them too), then imports in dependency order — every phase
through `importCatalog`:
(1) **tables** (connect to storage — a store-hosted maintained table reconnects here
as a plain table); (2) **views** (engine silent-register — body
validation deferred to query time, so view-over-view and view-over-MV are
order-independent and no event fires); (3) **materialized views** per entry (engine
re-materialize via the shared `materializeView` core: rebuilds the table contents
from current source data, re-registers row-time maintenance, re-runs the eligibility
gate — or adopts the phase-1 table without a refill). Phase 3 threads
`{ trustBackings, adoptedBackings, pendingDerivations }` into each `importCatalog`
call — `trustBackings` is decided **per entry** (`<marker present> && this MV was not
stale-at-close`), enabling the store-hosted-backing **adopt fast path**
(no refill) when every gate passes — see
[`docs/materialized-views.md` § Cross-module atomicity](materialized-views.md#cross-module-atomicity).
Import is silent — no `materialized_view_added` fires — so rehydration writes
nothing back to the catalog and a second consecutive reopen yields identical catalog
bytes (adopt included: an adopted MV record is byte-identical to a refilled one).
MV-over-MV ordering uses a **fixpoint retry** rather than a static topological
sort — the resolved `sourceTables` are not serialized in the DDL, so they are
unavailable before import. Because a dependent's body *plans* against its
upstream's phase-1 plain table, plan failure cannot order the rounds; instead each
round's `importCatalog` call carries `pendingDerivations` (the names of every other
still-pending MV entry), and the engine defers — per-entry error, retried next
round — any entry whose body reads one. The one shared
`adoptedBackings` set composes across rounds: an upstream adopted in round 1
unlocks its dependent's adoption in round 2. A genuinely unbuildable
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

Note the deliberate asymmetry with DDL: unqualified DDL lands objects in the **current schema** (`schemaManager.setCurrentSchema(name)`, API-only), but unqualified read resolution consults only the schema path (default `main`, then `temp`) — never the current schema. An embedder setting a non-`main` current schema should set the schema path to match, or qualify references; see [SQL Reference § Schema Search Path](sql.md) for the user-facing statement of this rule.

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
| `view_modified` | `oldObject`, `newObject: ViewSchema` | After `ALTER VIEW … SET TAGS`, or when an `ALTER TABLE/COLUMN RENAME` rewrites a dependent view body or its `with defaults` clause (the clause rides inside the body select, so the body rewrite covers it) |
| `materialized_view_added` | `newObject: TableSchema` (the maintained table) | After `CREATE MATERIALIZED VIEW`; also under the new name when `ALTER TABLE … RENAME TO` re-keys a maintained table |
| `materialized_view_removed` | `oldObject: TableSchema` (the maintained table) | After `DROP MATERIALIZED VIEW` — or `DROP TABLE` on a maintained table (one record, one drop); also under the old name on a maintained-table rename |
| `materialized_view_modified` | `oldObject`, `newObject: TableSchema` (the maintained table) | After `ALTER MATERIALIZED VIEW … SET TAGS` (catalog-only, no re-materialize), or when an `ALTER TABLE/COLUMN RENAME` rewrites a dependent MV body or its `with defaults` clause (the clause rides inside the body select) |
| `materialized_view_refreshed` | `object: TableSchema` (the maintained table) | After `REFRESH MATERIALIZED VIEW` |
| `module_added` | _(name only)_ | After module registration |
| `module_removed` | _(name only)_ | After module removal |
| `collation_added` | _(name only)_ | After collation registration |
| `collation_removed` | _(name only)_ | After collation removal |

All events carry `schemaName` and `objectName` fields. **Naming contract:** events fire the *stored* names of the object that was swapped — `schemaName` is the canonical (lowercase) schema name (stored `schemaName` on tables/views/MVs is canonicalized at create/import time via `SchemaManager.canonicalSchemaName`), and `objectName` is the object's stored display casing, never the raw spelling from the triggering statement. Prepared statements rely on this: `Statement.compile()` invalidates its cached plan by comparing recorded dependencies (which carry stored names) against event names **exactly**, so a raw-cased name on either side would silently miss invalidation. The same stored-name guarantee holds for the **module-facing calls** the SchemaManager makes (`create`, `connect`, `createIndex`, `dropIndex`, `destroy`, `alterTable`, `renameTable`, …), not only for events — see [module authoring § Identifier casing in module-facing calls](module-authoring.md#identifier-casing-in-module-facing-calls).

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

- `SchemaDiff.maintainedModuleMigrations` — backing-module moves on maintained tables (a declared `using <module>(args)` change on a `materialized view` / `create table … maintained as`). Each is realized as a **destructive drop+recreate** (the DROP rides `tablesToDrop`; the recreate, which re-materializes the body into the new module, rides `tablesToCreate`), minting a new incarnation. Surfaced unconditionally by `diff schema`; **gated** at `apply schema` on `allow_destructive` (see below). See [Materialized Views § Declarative-schema integration](materialized-views.md#declarative-schema-integration).

Destructive changes require explicit acknowledgement. The maintained-table backing-module move is the one case currently **enforced**: `apply schema` aborts (before any DDL runs) unless re-run with `options (allow_destructive = true)`, since the new incarnation changes row identity for a replicated/synced table. Other drops are not yet gated (a general `allow_destructive` gate over all drops is future work). See the [SQL Reference](sql.md#20-declarative-schema-optional-order-independent) for full syntax and examples.

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

At `apply schema X` the lens prover emits **coded, sited advisories** (`lens.no-backing-index`, `lens.no-answering-structure`, `lens.partial-override`, `lens.getput-lossy`) onto the deploy report. A developer accepts one in source with a reserved tag on the logical table (or a constraint), so the suppression is version-controlled and reviewable rather than an out-of-band suppress-list:

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

1. **Renames first** — `ALTER TABLE ... RENAME TO` for **tables** with a stable identity hint (`quereus.id` / `quereus.previous_name`). This frees the old name before any create reuses it and lets the engine's rename rewriter propagate references through dependents. Hinted **view / index** renames emit no DDL in this phase (no rename primitive exists) — they are realized as drop(old) + recreate(declared) in the drop/create phases below; the non-table `RenameOp`s on `SchemaDiff.renames` are metadata only.
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

The same resolution runs at column granularity inside `computeTableAlterDiff` and at named-constraint granularity. Column renames emit `ALTER TABLE ... RENAME COLUMN`; named-constraint renames now emit the `ALTER TABLE ... RENAME CONSTRAINT` primitive (CHECK / UNIQUE / FOREIGN KEY). View and index renames have no engine-level rename primitive: a hinted (rename-matched) view/index resolves to drop(actual old name) + recreate(declared new name) emitted from the view/index buckets whether or not its definition changed — a definition-unchanged rename's recreate is rendered with the same diff's COLUMN renames inverse-applied NEW→OLD (creates run before `RENAME COLUMN` in migration order, and the live rename propagation then rewrites the freshly created body so the re-diff converges) while keeping declared TABLE names (table renames run first); an index rebuild on a pure rename is the accepted cost. These deliberate drop+create pairs are excluded from the `require-hint` counts.

Alongside renames, `computeTableAlterDiff` resolves the full **named-constraint lifecycle** by name: a user-named constraint in the catalog but absent from the declaration (and not consumed by a rename) → `TableAlterDiff.constraintsToDrop` → `DROP CONSTRAINT`; a declared user-named constraint absent from the catalog (and not a rename target) → `TableAlterDiff.constraintsToAdd` → `ADD <fragment>`. Declared constraints are gathered from **both** the table-level `constraints` list and column-level constraints carrying an explicit name (`qty int constraint chk_qty check (qty > 0)`), matching what the catalog's `namedConstraints` surfaces. Only **user-named** constraints participate: engine-synthesized auto-names (`_check_*` / `_fk_*` / `_uc_*`), PRIMARY KEY constraints (handled by `primaryKeyChange`), and UNIQUE constraints derived from a `CREATE UNIQUE INDEX` (`derivedFromIndex`, managed through their index) are excluded — keeping the diff stable/idempotent for unnamed and index-derived constraints. Under `require-hint`, a constraint add **and** drop on the same table with no rename hint is rejected, mirroring the table/column guard. **Note:** `ADD CONSTRAINT` routes all three classes through module `addConstraint`, which the built-in memory and store modules now implement (a CHECK on a module that omits `alterTable` keeps an engine-side fallback) — routing CHECK through the module too keeps the module-cached schema in lock-step with the catalog so a later `DROP/RENAME CONSTRAINT` resolves it. UNIQUE / FOREIGN KEY adds **re-validate the existing rows** and fail atomically with `CONSTRAINT` (schema unchanged) when the current data violates the new constraint, otherwise installing forward enforcement; a CHECK add is a schema-only append (no existing-row scan), enforced going forward. So a declarative add of a named UNIQUE / FK to an already-existing table now **converges** end-to-end (and a second apply is a no-op). FK existing-row validation is gated by `pragma foreign_keys` (off ⇒ the add skips the scan and defers enforcement to later writes); the store's UNIQUE existing-row check now honors each constrained column's per-column collation (`BINARY`/`NOCASE`/`RTRIM`), so a UNIQUE add — and the `CREATE UNIQUE INDEX` and `ALTER COLUMN … SET COLLATE` existing-row scans, which share the same `serializeRowKey` signature — correctly rejects pre-existing rows that collide only under that collation. (Residual: a *custom comparator-only* collation has no string normalizer and falls back to BINARY for the existing-row dedup, so it can under-reject at ALTER/add time even though write-time enforcement via the comparator is exact. A per-column **PRIMARY KEY** `SET COLLATE` on the store stays schema-only — the PK key bytes use a fixed table collation; its physical re-key is deferred to `store-set-collate-pk-physical-rekey`.) ADD / DROP / RENAME now all work for the three classes.

#### Constraint body-change detection (drop+recreate)

A constraint whose **name is unchanged but whose body changed** — an edited CHECK expression, a changed FK action / referenced table / columns, a changed UNIQUE column set or `ON CONFLICT` — is realized as **drop-old + add-new** (there is no in-place "redefine" primitive). For **UNIQUE / FOREIGN KEY** the re-add re-validates existing rows against the new rule (a violating row aborts the apply with `CONSTRAINT`, schema unchanged); for **CHECK** the re-add is **forward-enforcing only** and does **not** re-validate existing rows (a pre-existing limitation of the CHECK add path — the module `addConstraint` CHECK arm, with its engine-side fallback in `runtime/emit/add-constraint.ts runAddCheckEngineSide`), so a pre-existing row that violates the new CHECK is not re-checked until its next write. The two statements (DROP then ADD) are **not atomic** on the memory backend: a failed re-add leaves the old constraint already dropped (the spec/sqllogic tests assert only "apply aborts + data survives", not "old constraint restored"). **Rename reconciliation (no redundant drop+recreate):** the `definition` is rendered with the *current* column/table names on the actual side and the *declared* names on the declared side, so a name-matched constraint whose body differs *only* because of an identifier renamed in the **same** diff would naively register as a body change. To avoid a redundant drop+recreate **on top of** the rename, `computeTableAlterDiff` first compares the raw `definition` strings (the common no-rename case short-circuits) and, on a mismatch, re-compares a **rename-reconciled** declared body built by `reconciledDeclaredBody`: a surgical clone of the declared constraint AST with the in-diff renames *inverse*-applied — each renamed identifier rewritten from its new name back to the actual pre-rename name. CHECK expressions first inverse-rewrite **every in-diff table rename** over the expression — a table-qualified self-reference's qualifier (`check (t2.qty > 0)` declared after a `t`→`t2` rename reconciles to `t.qty > 0`) and a cross-table reference inside a subquery (`check (qty <= (select max(cap) from lim2))` declared after a `lim`→`lim2` rename) alike — via the runtime `renameTableInAst` rewriter — the exact inverse of the forward rewriter the rename migration runs over **all** tables' CHECKs, so the diff-side reconcile and the executed migration cannot drift; sequential application over the one clone is order-independent because `resolveRenames` makes rename chains/swaps unrepresentable (every rename's new name is absent from the actual catalog while every old name is present), so no rename's inverse output can match another's inverse input — and then inverse-apply the in-diff **column** renames in two passes mirroring the forward `rewriteTableForColumnRename` branch split: the **owning table's** renames reuse the runtime `renameColumnInCheckExpression` rewriter seeded with the OLD (actual) table name (correct unconditionally, since qualifiers are pre-normalized to OLD by the qualifier pass) and threaded with a **declared-side scope resolver** — the diff-time analogue of the live-catalog `ResolveColumnInSource` hook the forward propagation passes — which answers "does this inner FROM source expose the renamed NEW column name in the *declared* world?" from the declared column sets (mapping the walk's pre-normalized OLD table names back to declared names first), so an unqualified ref inside a subquery that legitimately binds to a like-named column on its own FROM source (e.g. renaming `a.qty → cap` where the referenced `lim` also has a `cap`) is not falsely inverse-captured by the owning seed; then **other tables'** renames (from the same cross-table pre-resolution map the FK branch uses, each walk's table seed mapped back to that table's OLD name) via the plain scope-aware `renameColumnInAst` — no seed frame, no resolver, exactly the forward non-owning branch, so an unqualified ref only rewrites when the renamed table sits in an enclosing FROM frame — letting a CHECK subquery that references ANOTHER table's renamed column (`check (qty <= (select max(cap) from lim))` under a `lim.cap → capacity` rename) reconcile instead of churning a drop+recreate. **Ordering between the two column passes is load-bearing** (owning first): in a compound diff (owning `qty→cap` + referenced `lim.cap→capacity`) the reverse order would have the cross-table pass turn the inner `capacity` back into `cap` in time for the owning inverse to falsely capture it. All passes run over the one `cloneExpr` copy. Accepted limitations, all failing safe to a benign — still converging — drop+recreate: cross-schema FROM sources answer `false` from the declared-side resolver (the catalog is single-schema) where the forward path's live lookup could say yes, and pathological rename interleavings (another table's NEW name equal to the owning table's OLD name combined with correlated unqualified refs) retain the same scope-naïveté class the forward `renameColumnInAst` documents. UNIQUE / FK reconcile their column lists directly, and an FK additionally reconciles its referenced *parent table* against the table renames **and** its referenced *parent column* list against the parent table's column renames. Both are threaded in from `computeSchemaDiff` via a one-pass pre-resolution of every name-matched declared table's column renames, keyed by declared (new) table name — the same key an FK's `foreignKey.table` carries at diff time. A parent-table rename and a parent-column rename in the same diff reconcile together (look up the parent's column renames by the new parent name, then rewrite the table name back to old); a self-referential FK whose referenced column is renamed is covered by the current-table entry in that map. When the reconciled body matches the actual, only the rename is emitted (a metadata-only RENAME COLUMN / RENAME TABLE — no UNIQUE/FK re-validation scan, no non-atomic drop+add). A genuine body edit layered on a rename still differs after reconciliation, so the drop+recreate (and its RENAME suppression) is preserved. To see this, each entry of the catalog's `namedConstraints` carries a `definition`: a canonical **body fragment** (the `constraint <name>` prefix and `with tags (...)` suffix excluded) produced by `ddl-generator`'s `constraintToCanonicalDDL`. The declared side renders the same fragment from its AST via `ast-stringify`'s `constraintBodyToCanonicalString`; both funnel through one normalization so format/order-stable forms compare byte-equal. Normalization collapses parser-default-equivalent forms so they don't churn: a bare CHECK's default `INSERT|UPDATE` operation mask (vs an explicit `on insert, update`), a FK's default `RESTRICT` action, an elided referenced-column list, and the default `ON CONFLICT ABORT`. Bare column-name identifiers are **case-folded** (lowercased) throughout the canonical body — the UNIQUE / PRIMARY KEY column list, the FK local (child) **and** referenced (parent) column lists, the FK **referenced (parent) table** name, **and** the bare column references embedded in a CHECK *expression* (folded via a structural `lowerExprIdentifiers` clone that leaves string / blob / numeric / JSON literals, parameters, collation names, and cast/function names byte-exact) — matching Quereus's uniformly case-insensitive column resolution (the AST never records identifier quoting). So a constraint whose column reference, FK parent-table reference, or CHECK-embedded column reference case diverges from the *definition* case (or changes across re-declares) renders identically and does not churn a spurious drop+recreate; a literal-value change is still a genuine body edit and still recreates. The **FK parent-schema qualifier** is canonicalized symmetrically too (`canonicalForeignKeyClause`): it is rendered **iff** it differs (case-insensitively) from the **child** table's schema, so an explicit own-schema qualifier (`references main.t` on a child in `main`) elides to the unqualified form — matching the actual-catalog side, which already elides a parent == child schema — while a genuine **cross-schema** parent (`references main.m` on a child in `s2`) survives (case-folded) as a body-change channel. The child schema is threaded into `constraintBodyToCanonicalString` from `constraintToCanonicalDDL` (actual side, `tableSchema.schemaName`) and from `collectDeclaredNamedConstraints` / `reconciledDeclaredBody` (declared side, the differ's per-schema target); the parent schema is **not** a rename channel (renames are within-schema), so an FK rename reconcile carries it through the clone untouched. Net: re-declaring an unchanged cross-schema FK does not churn, an explicit own-schema qualifier is equivalent to the bare form, and editing the declared parent schema (`references s2.m` → `references main.m`) is detected as a body change (drop+recreate). (Subquery bodies inside a CHECK — `(select …)` / `exists` / `in (select …)` — pass through structurally rather than being descended into, a bounded limitation that stays symmetric on both diff sides.) For a name-matched (or rename-matched) constraint, `computeTableAlterDiff` compares `definition`; on drift it pushes the old name to `constraintsToDrop` and the declared fragment to `constraintsToAdd` (reusing the same buckets and `generateMigrationDDL` emission as the add/drop paths — DROP already orders before ADD within the table block). Crucially: a constraint's **tags are excluded from `definition`**, so a tag-only change yields an equal `definition` and takes the in-place `ALTER CONSTRAINT … SET TAGS` path — never a needless drop+recreate. When a constraint is both rename-matched **and** its body changed, the drop+recreate wins and the `RENAME CONSTRAINT` is suppressed (a rename-then-redefine is two ops where drop+recreate is one, and the new body must re-validate regardless); the recreate's `ADD` fragment carries the declared tags, so no separate `SET TAGS` is emitted. Body-change drop+adds are **excluded** from the `require-hint` add/drop count (they are deliberate recreates, not ambiguous renames). Body changes to *unnamed* constraints are not individually addressable (detection keys off names) and are out of scope.

#### Index body-change detection (drop+recreate)

An **index** whose name is unchanged but whose body changed — a flipped `UNIQUE`, an added/removed/reordered column, an `asc`↔`desc` direction flip, or an added/changed/removed partial `WHERE` predicate — is realized as **drop-old + recreate** (an index has no in-place "redefine" primitive), the same shape a materialized-view body change uses. Each `CatalogIndex` carries a `definition`: a canonical **body** string (`[unique ]index (<cols>)[ where <expr>]`) produced by `ddl-generator`'s `indexToCanonicalDDL`, which lifts the stored `IndexSchema` into a minimal `CreateIndexStmt` and renders it through `ast-stringify`'s `createIndexBodyToCanonicalString`; the declared side renders the same function over its AST, so the two are byte-comparable. Bare column-name identifiers in the index column list are **case-folded** (lowercased) in this body — the actual side lifts the column *definition* case (`tableSchema.columns[i].name`) while the declared side carries the as-written index reference case — so an index whose column reference case diverges from the definition (e.g. column `Email` indexed as `email`) renders identically and does not churn. The partial `WHERE` predicate's bare column references are likewise case-folded (via the shared `lowerExprIdentifiers`, which the constraint CHECK path also uses), so a predicate whose column-reference case changes across re-declares renders identically while its literals stay byte-exact — a genuine predicate edit still recreates. For a name- or rename-matched index, `computeSchemaDiff` compares the declared body against `matchedActual.definition`; on drift it pushes the actual (pre-rename) name to `SchemaDiff.indexesToDrop` and the declared `create [unique] index …` (with the declared tags) to `indexesToCreate` — `generateMigrationDDL` already orders index drops before creates, so the pair applies drop → recreate. A **rename-matched** index whose body is *unchanged* takes the same drop+recreate shape (rendered by `columnReconciledIndexStmt` with the same diff's column renames inverse-applied — see [Rename Detection](#rename-detection)); there is no `ALTER INDEX … RENAME TO` primitive, and the rebuild on a pure rename is the accepted cost. **Tags** are **excluded from the body**: a tag-only change takes the in-place `ALTER INDEX … SET TAGS` path, never a recreate — mutually exclusive with a body recreate per index, body drift winning. **Per-column collation IS included** in the body, but only as an already-*resolved* effective value: both sides pre-resolve each column's collation the way the engine does at create/import time (explicit index `COLLATE`, else the table column's collation, else `BINARY`; normalized) before rendering — the actual side in `indexToCanonicalDDL`, the declared side in `schema-differ`'s `declaredIndexCanonicalBody` — so an inherited / default-`BINARY` collation that is unchanged renders identically (no churn on an inherited-`NOCASE` unique index) while a genuine per-column collation change recreates. **Concurrent column renames are reconciled** like the constraint path: `declaredIndexCanonicalBody` inverse-applies the index table's in-diff column renames (threaded in from `computeSchemaDiff`'s one-pass pre-resolution, keyed by the index's *declared* / new table name — so a table renamed in the same diff still resolves its column renames) to the declared body, rewriting each resolved bare column name, **and** each renamed column reference inside the partial `WHERE` predicate (via the shared `renameColumnInCheckExpression` over a `cloneExpr` copy), from its new name back to the actual pre-rename name. So a same-named index over a column renamed in the **same** diff matches the actual body and emits **only** the column rename (`RENAME COLUMN`, no index drop+recreate, so it never trips the `require-hint` index guard), while a genuine body edit layered on the rename still recreates. **Ordering is load-bearing**: the collation is resolved on the **new** (declared) column name *first* — the declared `ColumnDef` is keyed by it — and only then is the emitted name mapped back to its old form (reversing the order would look the collation up under the old name and miss it). The index body excludes the structural `on <table>` reference, so a *table* rename alone never churns the column list (indexed columns carry bare names) — strictly simpler than the constraint FK case, which also reconciles a parent table / parent column. A partial `WHERE` predicate carrying a **table-qualified** self-reference (`where t.active = 1`) *does* embed the table name in the body, so ALL in-diff table renames are threaded in and every embedded table name is inverse-rewritten NEW→OLD (via `renameTableInAst`, the exact inverse of the forward rewriter the rename migration runs over all tables; a *cross*-table reference is unreachable today — the memory backend rejects subqueries and any cross-table reference in partial-index predicates at create time — but the all-renames scope mirrors the forward rewriter and the constraint CHECK path) **before** the per-column rewrites — which are seeded with the index table's OLD name (its own rename resolved inside `declaredIndexCanonicalBody`), matching the pre-normalized qualifiers, exactly as the constraint CHECK path does. So a pure table rename (with or without concurrent column renames) over a qualified predicate emits only the rename op(s), while a genuine predicate edit layered on the rename(s) still recreates. (Accepted scope-naïveté, symmetric with the forward path: a subquery alias inside the predicate that happens to equal a renamed table's new name can inverse-rewrite and cause a spurious — but valid — recreate.) Like the constraint path, body-change recreates are **excluded** from the `require-hint` index add/drop count (they are deliberate recreates, not ambiguous renames); a genuine unhinted create+drop of two distinctly-named indexes still trips the guard. Implicit covering indexes (the secondary BTree backing a UNIQUE constraint) never participate in the index buckets — their lifecycle is the originating constraint's, handled by the named-constraint diff path. A **hidden** implicit index (no `quereus.expose_implicit_index`) is absent from `actualCatalog.indexes` entirely, so it never name-matches. An **exposed** implicit index (constraint tagged `quereus.expose_implicit_index = true`) *is* present in `actualCatalog.indexes` for introspection (`schema()` / `index_info()`), but the catalog marks it `CatalogIndex.implicit = true` and `computeSchemaDiff` filters it out of `actualIndexes` before building the rename/create/drop view — so a converged schema with an exposed implicit index diffs **empty**, never emitting a phantom `DROP INDEX IF EXISTS <name>` (and `ALTER INDEX … SET TAGS` on the exposed name routes onto the originating constraint, not the index buckets).

**Primary-key column renames** reconcile the same way (PK changes flow through `primaryKeyChange`, not the named-constraint path). Before comparing the declared PK sequence against the actual key, `computeTableAlterDiff` inverse-applies the in-diff column renames to the declared PK column *names* (reusing `inverseRenameConstraintColumns`), so a pure PK-column rename — already emitted as a metadata-only `RENAME COLUMN` — does not also churn a redundant `ALTER PRIMARY KEY`. Only **this table's own** column renames participate (a PK references only local columns, so no cross-table table/column-rename threading, unlike the FK body case). The reconciliation rewrites **names only**: `pkSequencesEqual` still compares direction, so a genuine `asc`→`desc` change layered on a renamed PK column still emits the PK change. And `primaryKeyChange.newPkColumns` keeps the **new (declared)** names, so a genuine membership/order change still ALTERs to the correct post-rename columns. A default-PK table (no explicit `PRIMARY KEY` ⇒ all columns are the key) is covered for free — renaming any column no longer churns a spurious PK change.

#### View / materialized-view definition-change detection (drop+recreate)

A **view** — plain or materialized — whose name is unchanged but whose **definition** changed is realized as **drop-old + recreate** (neither has an in-place "redefine" primitive). The canonical definition covers the two definitional parts: the explicit column list (`v(a, b)` — for an MV it also names the maintained table's columns) and the body (`astToString` of the QueryExpr — which itself carries the trailing `with defaults (col = expr, …)` clause, so a defaults-only edit drifts the string without a separately-itemized part; a stale clause silently supplying an outdated default on insert was the original bug this detection closes). Name / schema / tags are excluded. One shared renderer — `ast-stringify`'s `viewDefinitionToCanonicalString` — produces it on **both** diff sides: the actual side from the live `ViewSchema` / maintained-table `TableDerivation` fields (`CatalogView.definition`, populated by the catalog collectors), the declared side from the declared statement's fields. Plain views compare the strings directly; materialized views compare **hashes** — `TableDerivation.bodyHash` is `computeBodyHash` over this same canonical definition, stamped at create (`materializeView`) and re-stamped by the rename-propagation rewrite (`applyMaterializedViewRewrite`), so a clause-only or explicit-columns-only MV change now re-materializes exactly as a body change does. (An MV persisted before this hash-formula change re-hashes differently **iff** it carries a clause or an explicit column list — a one-time rebuild on the next apply; acceptable, back-compat is explicitly deferred.) **Store-catalog spelling note:** a store catalog that persisted canonical DDL with the **old `insert defaults (…)` spelling** will **not re-parse** after this move (`insert defaults` is no longer grammar; the clause is now the select's trailing `with defaults (…)`). This is accepted under the project's transient-schema / no-backward-compat posture — re-create such objects under the new spelling. An MV's **backing-module identity** (`using <module>(...)`) is compared as a **separate field**, deliberately not folded into `bodyHash` (a formula change would spuriously rebuild every already-persisted MV): both sides normalize the name (absent ⇒ `memory`, `mem` aliased, lowercased) and args compare under a stable-key-order render, so `using memory()` vs an omitted clause never churns while a genuine module or args change takes the same drop+recreate path a body drift does — re-materializing the backing into the newly declared module. **Rename-coincident module move:** when the same apply BOTH renames a maintained table (via a `quereus.previous_name` / `quereus.id` hint) AND moves its backing module, the table RENAME op is *preserved* (dependents over the old name retarget through the `ALTER … RENAME` primitive) and the module-move's drop is retargeted to the **new** declared name — at apply the rename runs first, so dropping the old name would no-op and the recreate (rendered under the new name) would then collide; for a plain name match the two names coincide so non-rename module moves are unaffected. **Tags are excluded from the definition**: a tag-only change takes the in-place `ALTER VIEW / ALTER MATERIALIZED VIEW … SET TAGS` path, and a definition recreate carries the declared tags and suppresses any separate `SET TAGS` — mutually exclusive per object, as for indexes/constraints. **No identifier case-folding** is performed — a deliberate asymmetry vs the constraint/index canonical bodies (which fold to avoid *expensive* churn, since their recreates re-validate rows / rebuild structures): a case-only edit recreates a plain view (free — data-less) or rebuilds an MV (the pre-existing behavior of the old select-only hash), and both sides render parser-produced ASTs through the one emitter, so keyword case / whitespace cannot churn regardless. **Concurrent renames are reconciled** like the constraint/index paths: on a raw mismatch (only — the converged case short-circuits), `reconciledDeclaredViewDefinition` re-renders the declared definition from a clone with every in-diff table rename inverse-applied NEW→OLD (`renameTableInAst`), then each renamed table's column renames NEW→OLD (`renameColumnInAst` over the body — the body's own FROM provides the scope; the column rewrites are seeded with the table's OLD name since the qualifier pass pre-normalizes). The `with defaults` clause reconciles **for free as part of the body**: it now rides inside the select AST (`SelectStmt.defaults`), so the same `renameTableInAst` / `renameColumnInAst` body walk descends `select.defaults` — each entry's `column` target (a base column of the view's FROM table, often projected away) inverse-renames via the same scope-aware synthetic probe a `with inverse` target uses, and each entry's `expr` inverse-renames in the select's FROM scope frame (an inner-subquery ref binding a like-named column on its own FROM is kept un-rewritten by threading the **declared-side `resolveColumnInSource` resolver** into the body walk — the scope walk consults an inner FROM's column sets only when that resolver is supplied, so the subquery's pushed frame alone is not enough; this is the same role the resolver plays in the forward live-lookup propagation, keeping the two directions in parity). The earlier two-pass FROM-seeded/cross-table split and its standalone `renameColumnInInsertDefaults` helper are gone — the single body walk threads the resolver instead. The explicit column list names the view's **own output columns** — stable identity — and passes through untouched. When the reconciled definition matches the actual, only the rename op(s) emit. For **column renames this is correctness-critical, not just churn-avoidance**: `generateMigrationDDL` emits view creates *before* the table-alter block where `RENAME COLUMN` lives, and `CREATE VIEW` plans its body at create time — an unreconciled recreate naming the NEW column would fail at apply (whole-TABLE renames are safe: they emit first). A genuine definition edit layered on a rename still differs after reconciliation and recreates; a **rename-matched** view resolves to drop(actual old name) + create(declared new name) whether or not its definition changed — the definition-unchanged recreate is rendered by `columnReconciledViewStmt` with the same diff's COLUMN renames inverse-applied (see [Rename Detection](#rename-detection)). View definition recreates are **excluded** from the `require-hint` view create/drop count (deliberate recreates, not ambiguous renames). **Residual hazard (known, documented, unsolved):** a *genuine* view/MV definition edit that ALSO references a column renamed in the same diff still emits its CREATE before the RENAME COLUMN and fails at apply — the same create-before-alter ordering MV rebuilds have always had; split such a migration into two applies (rename first, then the definition edit).

#### Tag-drift detection

`computeTableAlterDiff` also detects **metadata-tag drift** at three sites — the table (`TableAlterDiff.tableTagsChange`), each surviving column (`ColumnAttributeChange.tags`, computed in `computeColumnAttributeChange`), and each name-matched named constraint (`TableAlterDiff.constraintTagsChanges`). The schema hash deliberately excludes tags, so drift is detected **structurally** (an order-independent `stableStringify` compare) rather than via the hash. The rename-hint keys `quereus.id` and `quereus.previous_name` are excluded from the comparison (they drive rename detection, not data state, so a declaration carrying only a hint does not churn out a `SET TAGS` after the rename completes); all other reserved tags (`quereus.lens.*`, `quereus.expose_implicit_index`, …) *are* compared. `generateMigrationDDL` emits the drift as `ALTER TABLE … SET TAGS (…)` / `ALTER TABLE … ALTER COLUMN … SET TAGS (…)` / `ALTER TABLE … ALTER CONSTRAINT … SET TAGS (…)` **after** the structural ALTER phases, so a tag set lands on the post-rename column / constraint name. These `SET TAGS` mutations are **catalog-only**: the runtime swaps the in-memory schema and fires `table_modified` without calling `module.alterTable`. Store-backed modules persist DDL from their own `alterTable` hook, which this path bypasses; the generic store module instead recovers the change by subscribing to these `table_modified` events and re-writing its catalog DDL, so table / column / named-constraint tag mutations survive reconnect for store tables — as do **index** tags (the regenerated bundle carries the changed `CREATE INDEX` line, or the exposed-implicit-index `alter index … set tags` line) and **view / materialized-view** tags (the `view_modified` / `materialized_view_modified` listeners re-write their reserved-prefix catalog entries). The same in-place catalog path backs the imperative per-key `ALTER TABLE … ADD TAGS` / `DROP TAGS` ergonomics, which the differ never emits (it always computes the full desired set and emits whole-set `SET TAGS`).

The differ detects the same drift on the other tagged catalog objects — **views**, **materialized views**, and **indexes** — on a name-matched object (no rename), surfacing it through `SchemaDiff.viewTagsChanges` / `materializedViewTagsChanges` / `indexTagsChanges`. `generateMigrationDDL` emits these as `ALTER VIEW … SET TAGS` / `ALTER MATERIALIZED VIEW … SET TAGS` / `ALTER INDEX … SET TAGS` (leaf metadata writes in the alter phase). Crucially, a view or materialized-view **tag-only** change takes this in-place path instead of a drop+recreate — an MV does **not** re-materialize the body; a definition change still drops+recreates (carrying the declared tags through the recreate — see [View / materialized-view definition-change detection](#view--materialized-view-definition-change-detection-droprecreate)), and the two are mutually exclusive per object. The view / MV setters re-register the in-memory schema object (firing `view_modified` / `materialized_view_modified` — distinct from the create events, so they invalidate cached write-through plans without re-registering maintenance); the index setter swaps the owning table's `IndexSchema` and fires `table_modified`. As at the table level, the same in-place catalog setters also back the imperative per-key `ALTER VIEW` / `ALTER MATERIALIZED VIEW` / `ALTER INDEX … ADD TAGS` / `DROP TAGS` ergonomics, which the differ never emits (it always computes the full desired set and emits whole-set `SET TAGS`).

#### Reserved-tag validation on the declarative path

`quereus.id` and `quereus.previous_name` are first-class entries in the typed reserved-tag registry (`src/schema/reserved-tags.ts`), not a differ-local allow-list. Before any rename resolution, `computeSchemaDiff` routes every declared object's tags through `validateReservedTags(tags, site)` at the physical declarative sites — `physical-table` (table), `physical-column` (column), `view-ddl` (view / materialized view), `physical-index` (index), `physical-constraint` (every table-level constraint, named or not — a table-level `WITH TAGS` clause is consumed even when the constraint is unnamed — **and** every inline column constraint's tags, which the parser populates only for a *named* inline constraint such as `qty integer constraint chk check (qty>0) with tags (...)`; an unnamed inline constraint defers its trailing tags to the column, so they validate at `physical-column` instead; rename detection still keys off named constraints only) — and raises the first error via the shared `raiseReservedTagDiagnostics` policy helper. This is the **same registry and the same hard-error-on-unknown severity** as the lens-compile, view-mutation, and advertisement paths: a misspelled or mis-sited `quereus.*` key (e.g. `quereus.previuos_name`, or a logical-column-only key like `quereus.lens.writable` on a physical table) now fails `apply schema` / `diff schema` loudly instead of being silently swallowed. The two rename hints carry value-schema `'string'` (a `quereus.id` may legitimately contain a hyphen, e.g. `'tbl-thing'`), so the existing rename flow is unchanged. An MV's `quereus.id` validates but is ignored (the differ supports no materialized-view rename).

The imperative `ALTER TABLE … SET TAGS` **and** `ALTER TABLE … ADD TAGS` paths route through the **same** registry at the matching site (`physical-table` / `physical-column` / `physical-constraint`) during plan-build (both carry `stmt.action.tags`, so they share the `setTags` build case), so a misspelled or mis-sited reserved key fails the statement loudly rather than being stored. `DROP TAGS` removes by key and carries no values, so it does **no** reserved-tag validation — dropping a reserved key is legitimate. The sibling `ALTER VIEW` / `ALTER MATERIALIZED VIEW` / `ALTER INDEX … SET TAGS` **and** `… ADD TAGS` statements validate at the `view-ddl` (view / MV) and `physical-index` (index) sites the same way (both carry `action.tags`, sharing the `setTags` build case); their `… DROP TAGS` forms, like the table-level one, carry no values and so do no reserved-tag validation — dropping a reserved key is legitimate.

The two imperative `ALTER TABLE … ADD` arms validate identically (`planner/building/alter-table.ts`), closing the last asymmetric gap on the authoring surface: `ADD CONSTRAINT … WITH TAGS` checks the constraint's tags at `physical-constraint`, and `ADD COLUMN … WITH TAGS` checks the new column's tags at `physical-column` **plus** each of its inline named constraints' tags at `physical-constraint`. The per-column accumulation is shared with the direct `CREATE TABLE` path via `columnTagDiagnostics` (`planner/building/tag-diagnostics.ts`), and all build-path surfaces (`CREATE TABLE` / `CREATE INDEX` / `ALTER … ADD` / `ALTER … SET TAGS`) raise through one sited helper, `raiseStmtTagDiagnostics`, so they can never drift. As on every other path, an unnamed inline constraint's trailing `WITH TAGS` defers to the column (the parser populates `ColumnConstraint.tags` only for a *named* inline constraint), so it validates once at `physical-column` with no double-validation.

The **direct** `CREATE TABLE … WITH TAGS` and `CREATE INDEX … WITH TAGS` paths validate identically at plan-build (`planner/building/ddl.ts`), mirroring the four physical surfaces the differ checks for a declared table — table-level tags at `physical-table`, each column's tags at `physical-column`, each table-level (named or unnamed) constraint's tags at `physical-constraint`, and each inline column constraint's tags (populated only for a *named* inline constraint) also at `physical-constraint` — plus `physical-index` for `CREATE INDEX`. The per-column legs (a column's own tags + its inline constraints' tags) come from the shared `columnTagDiagnostics` helper the `ALTER … ADD COLUMN` path also calls; diagnostics accumulate table → per-column → table-constraints and the first error is raised once with the statement's source location. So a typo'd or mis-sited reserved key (`"quereus.bogus"`, or a `logical-table`-only key like `quereus.lens.access.<col>` on a physical table) is rejected at create time on the most common authoring path, not silently stored. Validation fires even under `IF NOT EXISTS` (build-time, before the runtime existence check) and regardless of the `nondeterministic_schema` option (tags are not expressions). Free-form (non-`quereus.*`) tags are skipped untouched. Two scoping notes: (1) `CREATE VIEW` / `CREATE MATERIALIZED VIEW … WITH TAGS` are deliberately **not** eagerly validated — view tags are validated lazily on the view-mutation path (the keys legal at `view-ddl` are the inert differ rename hints **and** `quereus.sync.replicate` — the latter the one view-ddl key that carries behavior: it opts a materialized view's store backing into change-log replication, read off `getSchema().tags` by the store backing host. Because the imperative `CREATE MATERIALIZED VIEW … WITH TAGS` path is not eagerly validated, a typo'd `quereus.sync.replicate` on a direct create is silently inert; the **declarative** `diff` / `apply schema` path — the authoring path for migration targets — *does* validate it at `view-ddl`); (2) the catalog **import/load** path (`SchemaManager.buildTableSchemaFromAST` reached by `importTable` / `importCatalog`) is an authoring-time gate's blind spot by design — it re-loads already-persisted DDL and must not start rejecting an openable database.

### Module Batch Hooks

Virtual table modules may opt into a per-`apply schema` batch by implementing the optional `beginSchemaBatch` / `endSchemaBatch` callbacks on `VirtualTableModule`. When the migration loop has at least one DDL statement, the engine calls `beginSchemaBatch(db, schemaName)` on every registered module that defines it (in registration order), runs the migration loop, and then calls `endSchemaBatch(db, schemaName, error?)` on those same modules in reverse order — passing the loop error on failure or `undefined` on success.

This lets a storage-backed module fold the entire migration into a single substrate commit: open an in-memory overlay in begin, have subsequent `create` / `destroy` / `alterTable` calls join it, then commit (or discard) in end. Modules without the hooks pay nothing — they're skipped. The idempotent fast-path (no DDL to run) skips both hooks.

If `beginSchemaBatch` itself throws, already-started modules receive `endSchemaBatch(error)` with the begin failure and the error propagates out of `apply schema`. Errors from `endSchemaBatch` are rethrown only when no prior loop error exists; otherwise they are logged so the original cause survives.

### Seed Data

Declared schemas can include seed data (`seed <tableName> values ...`). When `apply schema ... with seed` is executed:

1. Each declared seed row is written with `INSERT OR IGNORE` — the application is **idempotent**: re-applying a schema whose tables already hold their seed rows skips the seed PKs rather than colliding on them. Both seed rows that were edited by users and non-seed rows are left in place, so a reopen never destroys user data and no `ON DELETE CASCADE` fires for unchanged parents.
2. This happens per-table, after all structural migrations complete (and after `endSchemaBatch` has fired).

> **Why OR IGNORE, not OR REPLACE or wipe-then-reseed?** The earlier implementation ran `DELETE FROM <tbl>` before the inserts, skipping the wipe only when it could detect the table as freshly created by diffing against the in-memory catalog. On a reopen where that catalog was not rehydrated (host-backed row data lives outside the ephemeral catalog), an already-seeded table was misclassified as fresh, the wipe was skipped, and bare `INSERT`s collided with the persisted rows (`UNIQUE constraint failed: <table> PK`). `OR REPLACE` removed the heuristic and fixed the collision, but `OR REPLACE` is delete-then-insert on a conflicting row — so re-seeding a parent table referenced by `ON DELETE CASCADE` children would fire that cascade on every reopen even when the replaced values were byte-for-byte identical. `OR IGNORE` avoids both problems: a point-key probe skips any already-existing row without deleting it, so a fresh table gets seeded on first apply, and every subsequent reopen is a true no-op for existing rows.

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
