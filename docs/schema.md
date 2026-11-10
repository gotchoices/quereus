# Schema Management

> **Stability: Beta** — see [Stability Tiers](stability.md#tiers).

The schema subsystem manages database schemas, tables, views, functions, and indexes: it coordinates virtual table module lifecycle, resolves names across multi-schema search paths, and emits typed change events.

## Topic documents

This document is the **hub**: key types, the change-event surface, the schema path, and DDL generation. The subsystems large enough to read on their own live in the topic documents below.

<!-- NOTE: a section that moved into a satellite left a one-line stub behind under its original
     heading, so its old anchor still resolves here. `yarn docs:check` therefore cannot tell a
     link deliberately left on a stub from one that should have been retargeted and was not.
     When linking real content that lives in a satellite, link the satellite — not the stub. -->

| Document | Covers |
| --- | --- |
| [Rename Detection](schema-rename-detection.md) | How the declarative differ pairs a declared object with an existing one across a rename; the body-change detection that overrides a rename with drop+recreate; tag-drift detection; and reserved-tag validation on the declarative path. |
| [Declarative Schema](schema-declarative.md) | The `declare schema` / `apply schema` pipeline: applied-state fast path, logical schemas, migration order, failure and restoration, batch hooks, seeds, hashing and the declared-schema API. |
| [Undo Plan](schema-undo-plan.md) | How the migration planner records, per step, the statements that take that step back (or why none can), and the two rules that keep an undo correct under renames. |
| [View and Materialized-View Persistence](view-persistence.md) | How `@quereus/store` durably persists views and materialized views: the catalog keys, the schema-change subscription that writes them, and the reopen rehydrate. |

## Key Types

### SchemaManager

Central coordinator for all schema operations: owns the schema collection, module registry, and change notifier. One instance per `Database`.

### Schema

A named logical grouping of tables, views, functions, and assertions. Every database has at least `main` and `temp`; additional schemas can be attached. Each schema carries a `kind`:

- **`physical`** (default) — module-backed. Tables declare `using module(...)`, may carry indexes and storage tags.
- **`logical`** — design-only (`declare logical schema X { ... }`). Tables declare columns, types, and *logical* constraints (PK, UNIQUE, CHECK, FK, NOT NULL) plus `with tags`, and **nothing physical**: module association, `create index` / `unique index`, and materialized views are all rejected at apply (tags are allowed — engine-facing, and they survive into the compiled view). At `apply schema X` each logical table is aligned against a basis schema and compiled to an inlined view (the **lens layer**); the body registers as an ordinary `ViewSchema` and the logical spec is held in a per-`Schema` **lens slot**. See [Lenses and Layered Schemas](lens.md).

### TableSchema

Columns, primary key definition, CHECK constraints, associated virtual table module, indexes, and mutation context definitions. A module-backed (physical) table always has `vtabModule` / `vtabModuleName`; a **logical** table (`isLogical: true`, held only in a lens slot — never registered or executed) carries no module, so `vtabModule` is optional (use `requireVtabModule(table)` at module-backed sites). An optional `tags` field holds arbitrary key-value metadata (see `WITH TAGS`) — likewise on the other schema-object types below.

**Primary-key member collation.**

> **Invariant:** [SCH-006](invariants.md#sch-006--a-primary-key-members-definition-collation-equals-its-columns)

Each `primaryKeyDefinition[i].collation` is a copy of its member column's `collation`; no DDL form gives a key member a collation of its own. A module that changes a key column's collation — the store's CREATE-time key default, `alter column … set collate` on either backend — rewrites the definition with it (`rederivePrimaryKeyCollations`, or `rekeySchemaPrimaryKey` for `alter primary key`), and `Schema.addTable` refuses a schema where the two disagree.

**Generated-column evaluation order.**

> **Invariant:** [SCH-007](invariants.md#sch-007--every-generated-column-is-in-the-tables-evaluation-order)

`generatedColumnDependencies` maps each generated column's index to the column indices its expression reads, and `generatedColumnTopoOrder` lists the generated columns dependencies-first; INSERT and UPDATE compute generated columns by walking that order. Both are derived by the engine (`withGeneratedColumnGraph`) from the column list, never supplied by a module: CREATE TABLE computes them, and every ALTER arm that registers a module's answer re-derives them first (`withEngineGeneratedColumnGraph`), because a module builds that answer from its own cached schema. `Schema.addTable` refuses a schema whose order does not cover exactly its generated columns, so a DDL path that forgets fails at the statement instead of writing NULL into the column on later writes.

### ColumnSchema

A single column: name, logical type, nullability, primary key membership, default value expression, collation, and whether it is generated. Columns default to NOT NULL (Third Manifesto) unless `pragma default_column_nullability = 'nullable'`.

**Primary-key nullability.** Primary-key membership does **not** force NOT NULL. `primary key` says "these columns are the row identity" and nothing more; each key column keeps the nullability it declared, or the one `pragma default_column_nullability` gave it. This is one rule for both spellings — a declared `primary key (x, y)` and the all-columns key Quereus synthesizes when a table declares no PRIMARY KEY produce identical schemas, so an undeclared key is exact syntactic sugar for the declared one.

Under the shipped default (`default_column_nullability = 'not_null'`) almost nothing looks different: `create table t (id integer primary key, …)` still yields a non-nullable `id`, because *every* column defaults to NOT NULL. The nullable case appears only where a column says so — `x integer null primary key` — or where the session default is `'nullable'`.

A nullable key column is a valid row identity because NULL participates in keys on both backends: memory compares `NULL == NULL` as equal and orders NULL first, and the store's key codec encodes NULL as an ordinary type tag (`TYPE_NULL`) that sorts first. So two rows with an all-NULL key collide as a duplicate primary key rather than both being admitted.

**Key equality and `UNIQUE` answer NULL differently, deliberately.** Key comparison treats NULL as a value equal to itself, so two NULL keys collide. SQL `UNIQUE` treats NULLs as distinct, so two rows with `null` in a UNIQUE column are both legal. Both rules are unchanged by the above — declaring a key merely widens where the existing key rule applies:

```sql
create table t (x integer null primary key, y integer null unique);
insert into t values (null, null);
insert into t values (1, null);     -- OK: UNIQUE is NULL-distinct
insert into t values (null, 2);     -- fails: duplicate primary key
```

A **parent key tuple containing NULL is unreferenceable** by a foreign key, under MATCH SIMPLE — see [Constraints § 7.6](sql-constraints.md#76-foreign-key-constraint).

**`alter column … set not null` on a key column is a key re-key.** Because a key column can hold NULLs, tightening it backfills those NULLs from the column's DEFAULT (see [ALTER TABLE](sql-ddl.md)) — and that moves the key values: `(NULL, 1)` and `(0, 1)` become the same row under `default 0`. Every backend therefore treats the backfill exactly like a primary-key re-key rather than a payload rewrite: before mutating anything it runs the same two-question collision check `set collate` on a key column runs, over the rows *as the backfill will leave them* — two rows the transaction can see converging on one key is `CONSTRAINT` (`primary key collides under the new key definition`); a collision confined to committed rows the transaction has deleted (which a rollback must restore) is `BUSY` (`still collide under the new key definition … Commit/rollback and retry`) — and an accepted backfill physically re-keys: memory re-derives each open transaction layer's staged deletion keys under the backfilled values, the store re-encodes every data key after the value rewrite, and the isolation overlay re-keys its staged deletion markers. A tightening that sees no NULL in the transaction's effective rows is metadata-only on every backend and moves no key. `drop not null` on a key column is permitted and is always metadata-only: it rewrites no value, so no key moves and the existing (non-NULL) rows stay exactly where they are. Pinned cross-backend by `test/logic/41.2.3-alter-column-set-not-null-pk-backfill.sqllogic` and `test/logic/43.3-nullable-primary-key.sqllogic`.

### IndexSchema / IndexColumnSchema

A secondary index: name plus an ordered list of column references (by index into `TableSchema.columns`) with optional sort direction and collation.

### RowConstraintSchema

A CHECK constraint with an AST expression, an operation bitmask (insert/update/delete), and deferral settings. The expression normally *passes* when truthy or NULL. A write-plan-time synthesizer may instead set the transient `messageValued` flag (never persisted to the catalog), which inverts that test: the expression yields NULL when satisfied and the violation-message text when violated, so one planned expression can decide several rules and still name the one that failed — see [Lens § Constraint Attachment](lens.md).

### UniqueConstraintSchema

A UNIQUE constraint over one or more columns beyond the primary key: column indices, optional name, default conflict action, optional partial-index `predicate`, and `derivedFromIndex` (set when synthesized from `CREATE UNIQUE INDEX`). Carries an optional `coveringStructureName` — see [Covering-structure links](#covering-structure-links).

### ViewSchema

A view: name, schema, SQL text, and parsed SELECT AST.

### TableDerivation / maintained tables

A table is a stored relation; a *derivation* is an optional maintenance contract attached to it. A **maintained table** — what `create materialized view` produces — is one ordinary `TableSchema` registered under the view's own name, carrying a `derivation: TableDerivation` (`schema/derivation.ts`; `MaintainedTableSchema = TableSchema & { derivation: TableDerivation }`). One record, one catalog name, one physical incarnation: identity (name/schema), storage (`vtabModuleName`/`vtabArgs` — the backing-host module), tags, and the physical primary key all live on the owning table; the canonical `create materialized view` DDL renders on demand via `generateMaterializedViewDDL`. `TableDerivation` carries:

- **`selectAst`** — the parsed body AST, which itself carries the trailing `with defaults (...)` clause on `SelectStmt.defaults` (consumed by the write-through rewrite — read it via `bodyDefaults`); **`columns`** — the explicit MV column list (`mv(a, b)`), when declared.
- **`bodyHash`** — `computeBodyHash` over the canonical definition (explicit column list + body, the body string already carrying any `with defaults (...)` clause, rendered by `viewDefinitionToCanonicalString`), used by the declarative-schema differ to detect "definition changed → rebuild" — so a defaults-only edit drifts the hash without a separately-itemized field.
- **`logicalKey`** — the body's logical key (the table's own `primaryKeyDefinition` stays the physical, order-by-seeded key); **`ordering`** — the captured body ordering; **`coarsenedKey`** — the collation-coarsened lineage key, when applicable.
- **`sourceTables`** — qualified names of the tables the body reads.
- **`stale`** / **`sourceScope`** / **`bodyFunctions`** — runtime maintenance state, never serialized: the staleness flag; the cached source-union change-scope a `select` from the table substitutes for `Database.watch`; and the registered function schemas the body's calls resolved to when the maintenance plan was built, which the read-side rewrite compares against the live registry by object identity before trusting a stored value — and which the *next* registration compares its own resolution against, marking the view stale when a body function changed meaning in between rather than letting maintenance mix two functions' answers into one backing (object identity cannot cross a process boundary, hence never serialized — see [Query resolution § Aggregate rollup](mv-query-rewrite.md#aggregate-rollup-indexed-view-matching) and [Schema-change staleness § Body-function drift](mv-schema-change.md#body-function-drift)).
- **`covers`** — the covering-structure reverse link (below).

Full design: [Materialized Views](materialized-views.md).

### Covering-structure links

A UNIQUE constraint is logical; the structure that enforces it is optional (see [Derived-Row Constraints § Covering structures](mv-constraints.md#covering-structures)). Two schema fields record the constraint↔structure association:

- **`UniqueConstraintSchema.coveringStructureName`** — the **forward pointer** and **source of truth**: the name of the covering structure realizing this constraint (an auto-built secondary index, or an explicit covering materialized view — the maintained table's own name — recognized by the coverage prover). Set eagerly when a covering MV is created; cleared when that MV is dropped.
- **`TableDerivation.covers`** — the convenience **reverse link** `{ schemaName, tableName, constraintName? }` back to the covered constraint.

The `origin` vocabulary (`'implicit-from-unique-constraint'`) lives only on the memory-table manager's `ImplicitCoveringStructure` association — it is not a catalog field. These links are informational in the current release (enforcement still routes through the synchronously-maintained auto-index — see the materialized-views soundness note).

**Introspection.** The implicit covering structure (a UNIQUE constraint's auto-built index) is a backing detail, **omitted from `collectSchemaCatalog` / schema export by default**. It is surfaced only when the originating constraint carries the tag `quereus.expose_implicit_index = true`. Indexes from an explicit `CREATE [UNIQUE] INDEX` are always shown.

Once surfaced, an exposed implicit covering index **describes itself as UNIQUE on every read surface and every backend** — `collectSchemaCatalog`'s `ddl` / `definition`, `schema()`'s rendered DDL, and `index_info().unique`. Its own `IndexSchema` carries no `unique` flag (memory materializes it without one; the store synthesizes it from the constraint), so a single helper, `indexSchemaForDisplay` in `catalog.ts`, supplies the flag rather than each consumer deciding for itself. All three reach it through one enumeration, `displayIndexesForTable`, which is also where the hidden structures are filtered out and the store-mode synthetics appended — a read surface calls that instead of repeating the recipe, and the backends cannot drift apart. The flag is a display fact only: uniqueness *enforcement* routes through `uniqueConstraints`, never through this index. The **persistence** path is deliberately excluded — `buildCatalogEntry` in `quereus-store` renders DDL meant to be re-imported, not read, and emits no `CREATE INDEX` line for these at all (see [Store catalog persistence](store-catalog-persistence.md)).

**Lifecycle.** The structure's lifecycle belongs to its constraint, not to `CREATE`/`DROP INDEX`, on **every** backend — exposed or not. `isImplicitCoveringIndex(tableSchema, name)` (`catalog.ts`, reading only `uniqueConstraints`, so it answers identically on memory and store) is the predicate the write paths consult: `createIndex` rejects the name as a same-table duplicate, and `SchemaManager.findIndexOwner` — the single by-name owner resolver behind `dropIndex`, `emitDropIndex`'s strict-DDL-policy gate, the `createIndex` uniqueness check and sync's replicated index DDL — skips past such a match and keeps searching at its default `'user-indexes'` scope. (`ALTER INDEX … TAGS` asks for the wider `'tag-addressable'` scope, which admits an *exposed* structure but still skips a hidden one.) `ALTER TABLE … DROP CONSTRAINT` is what removes the structure. See [sql-vtab.md §6.3](sql-vtab.md#63-indexes-on-virtual-tables) for the user-facing rules.

**One name, one structure.** The structure's name is the constraint's own name, or `_uc_<covered column names joined by _>` when unnamed (`implicitIndexNameForColumns` in `catalog.ts` is the single spelling of that rule; `quereus-store`'s `implicitUniqueIndexName`, `MemoryTableManager.implicitIndexNameFor` and `quereus-isolation`'s `installOverlayUniqueConstraint` mirror it). Two objects on one table may not derive it: `assertUniqueConstraintIndexNameFree` refuses a UNIQUE declaration whose structure name is already held by another UNIQUE constraint's structure (searching `uniqueConstraints`) or by an index (searching `.indexes`), in that order, and `assertNoDuplicateUniqueConstraintBackingNames` applies the constraint half pairwise at `CREATE TABLE`, where there is no table to compare against yet. Both read only backend-independent schema, so memory and store refuse the same declarations with the same message. `derivedFromIndex` constraints are skipped by the constraint half — their structure is the `CREATE UNIQUE INDEX` that synthesized them, already compared by the index half. The guards sit on the write paths only; `importTable` / `importDDL` stay unguarded so a catalog written before them still opens, and `ensureUniqueConstraintIndexes` adopting a held name is the damage limitation for exactly those.

Once exposed, the implicit index is **addressable and introspectable identically across backends** — it appears in `schema()` and `index_info()`, and `ALTER INDEX … {SET|ADD|DROP} TAGS` targets it. Backends differ only in *where the user tags live*: memory materializes the implicit index as an `IndexSchema`, so its tags sit on `IndexSchema.tags`; backends that do not materialize it (the store, which enforces UNIQUE by full-scan over `uniqueConstraints`) derive a synthetic exposed index from the constraint in the read paths (`exposedImplicitIndexes` in `catalog.ts`) and route `ALTER INDEX … TAGS` onto a separate `UniqueConstraintSchema.exposedIndexTags` field. The asymmetry is internal; observable behavior is identical. A *hidden* implicit index (tag absent/false) stays unaddressable (`NOTFOUND`) on both — its tags live on the constraint, reached via `ALTER TABLE … ALTER CONSTRAINT … TAGS`. `exposedIndexTags` survives a store close→reopen via a trailing `alter index … set tags (…)` line in the table's catalog bundle (see [Store catalog persistence](store-catalog-persistence.md)) that `importDDL` re-applies silently on rehydrate. One deliberate divergence: tags are addressable — and *persisted* — only while the constraint is exposed. Dropping the exposure flag (`ALTER TABLE … ALTER CONSTRAINT … DROP TAGS`) leaves `exposedIndexTags` dormant in-session (re-exposing resurrects it), but the bundle emits no `alter index` line for an unexposed constraint, so after a reopen taken while unexposed, re-exposing yields no tags.

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
| `findTable(tableName, dbName?, schemaPath?)` | Finds a table across schemas. `dbName` searches that schema only; `schemaPath` searches those schemas in order; otherwise the default order `main`, then `temp` |
| `getTable(schemaName, tableName)` | Retrieves a table from a specific schema |
| `getMaintainedTable(schemaName, name)` | Retrieves a [maintained table](#tablederivation--maintained-tables) (a derivation-bearing table — a materialized view), or `undefined` for a plain table or no table |
| `getAllMaintainedTables()` | Returns every maintained table across all schemas |
| `attachDerivation(schemaName, tableName, derivation)` | Attaches (or replaces) a `TableDerivation` on an already-registered table, swapping the registered record. Fires no event — callers own the event discipline |
| `getView(schemaName, viewName)` | Retrieves a view definition |
| `getSchemaItem(schemaName, itemName)` | Returns a table or view by name (views take priority on name conflict) |
| `getTableTags(tableName, schemaName?)` | Returns metadata tags for a table, or `undefined` |
| `setTableTags(tableName, tags, schemaName?)` | Replaces a table's metadata tags (pass `{}` to clear); fires `table_modified` |
| `setColumnTags(tableName, columnName, tags, schemaName?)` | Replaces a column's metadata tags (pass `{}` to clear). Catalog-only — column nullability / type / default / PK membership are untouched. Throws `NOTFOUND` for an unknown table or column |
| `setConstraintTags(tableName, constraintName, tags, schemaName?)` | Replaces a **named** table-level constraint's metadata tags (pass `{}` to clear). Lookup order CHECK → UNIQUE → FOREIGN KEY; throws `NOTFOUND` for no match and `ERROR` for a name ambiguous across classes |
| `setViewTags(viewName, tags, schemaName?)` | Replaces a view's metadata tags (pass `{}` to clear). Catalog-only — re-registers the `ViewSchema`; throws `NOTFOUND` for an unknown view |
| `setMaterializedViewTags(name, tags, schemaName?)` | Replaces an MV's metadata tags (pass `{}` to clear). Catalog-only — re-registers the maintained `TableSchema` (the shared `derivation` rides the swap) and fires `materialized_view_modified`; never touches contents or re-materializes. Throws `NOTFOUND` for an unknown MV |
| `setIndexTags(indexName, tags, schemaName?)` | Replaces an index's metadata tags (pass `{}` to clear). Resolves the owning table from the index name, swaps the `IndexSchema`, fires `table_modified`. Throws `NOTFOUND` for an unknown index or a hidden implicit covering index (whose tags live on the originating constraint) |
| `findSchemasContainingTable(tableName)` | Returns all schema names containing the table — useful for error messages |
| `findFunction(funcName, nArg)` | Finds a function by name and argument count |

**Persistence of catalog-only tag swaps (store-backed tables).** The tag setters above (and `ALTER … SET TAGS`, unless the table's module implements [`alterTags`](module-authoring-schema-changes.md#altertags-metadata-tag-edits)) are catalog-only — they swap the in-memory schema and fire a change event but deliberately do **not** call `module.alterTable`. The generic store module (`@quereus/store`) re-persists them anyway by subscribing to `table_modified` and re-writing the table's catalog DDL (`generateTableDDL`) whenever the serialized form changes, so **table**, **column**, and **named-constraint** tags survive close → reopen → `rehydrateCatalog` for `using store` tables. The re-write is a read-compare-write keyed by `{schema}.{table}`: a table with no catalog entry (a memory table, or a store table never persisted) is skipped, and a structural ALTER — whose own `alterTable` already wrote the final DDL — produces identical bytes and is skipped (no double-write). The same subscription persists **views** and **materialized views** (and, via a trailing `alter index … set tags` line, an exposed implicit index's tags) — see [Store catalog persistence](store-catalog-persistence.md) and [View and materialized-view persistence](view-persistence.md).

### DDL Operations

#### `createTable(stmt): Promise<TableSchema>`

Creates a table from a parsed `CreateTableStmt`:
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
resolution). The same validator runs on the universal `ALTER … ADD CONSTRAINT` and
`ALTER … ADD COLUMN` emit paths (covering memory and store at once) and,
transitively, on declarative apply. On every path it runs
**before any persistence side effect**: `createTable` before `addTable`,
`ADD COLUMN` inside its validate-before-swap revert region, and `ADD CONSTRAINT`
**before** `module.alterTable` (the store's addConstraint arm
`saveTableDDL`'s the FK before returning, so a post-call throw would leave a
rejected FK on disk to rehydrate on the next reopen). It is **unconditional** —
unlike the FK existing-row scan it is *not* gated on `pragma foreign_keys`, since
a contradictory collation pairing is a malformed declaration (same class as a
child/parent column-count mismatch), not an enforcement concern. Two residuals
are intentional: a **forward-declared parent** (not yet created when the child is
declared) cannot be checked — its column types are unknown — so that conflict
stays caught at first DML; and reload / `importTable` does **not** re-validate, so
a legacy persisted conflicting FK reloads without error and surfaces only at DML.

**Column `COLLATE` validation (declaration time).** An explicit `COLLATE <name>` on a
column is validated in `columnDefToSchema` → `validateCollationForType`
(`schema/table.ts`) against BOTH the column's logical type AND the connection's
collation registry. `BINARY` is always accepted; a name on the type's supported list
(TEXT's `BINARY`/`NOCASE`/`RTRIM`) is accepted; any other name is accepted **iff the
connection has it registered** via `db.registerCollation(...)` (probed with
`Database.isCollationRegistered`). So a registered custom collation (e.g. `collate REVERSE` after
`db.registerCollation('REVERSE', …)`) is accepted on any collatable column, while an
**unregistered** name is rejected for *every* type, including `INTEGER`/`REAL`/`BLOB`, with
`Unknown collation '<name>' for type '<type>' …`. Types that declare an *empty*
supported list (`JSON` and the temporal types) reject every non-`BINARY` name,
registered or not. Because catalog rehydrate (`importTable`) shares the same
`buildColumnSchemas` choke point, a persisted column declaring a custom collation
**re-validates against the registry on reopen**: it reloads cleanly only when the
embedder re-registers that collation, and otherwise throws `Unknown collation` — the
same loud, no-silent-fallback failure the key-collation resolver produces (docs/types.md §
Comparison collation resolution; the store's `validateKeyCollations`). Re-register the
collation before reopening a database whose schema names it. The implicit *default* collation (a column with no `COLLATE` clause)
is unaffected — it resolves via `resolveDefaultCollation` and never consults the
registry.

#### `createIndex(stmt): Promise<void>`

Creates a secondary index from a parsed `CreateIndexStmt`:
1. Validates the target table exists and its module supports `createIndex`
2. Rejects the name if it is taken on this table — by a materialized `IndexSchema` or by a UNIQUE constraint's implicit covering structure (`IF NOT EXISTS` skips instead) — or, unsuppressibly, by a user index on another table in the schema
3. Builds `IndexSchema` from column references
4. Delegates to `module.createIndex()`
5. Appends the index to the table's schema
6. Emits `table_modified` change event

#### `dropTable(schemaName, tableName, ifExists?): Promise<boolean>`

Drops a table:
1. Removes the table from the schema
2. Emits `table_removed` change event
3. Awaits `module.destroy()` when supported, so callers see fully torn-down storage before the promise resolves

Returns `true` if the table was removed. With `ifExists`, returns `false` silently when not found.

When `pragma foreign_keys` is on, the drop is gated by a referencing-child scan (a non-NULL FK row in any *other* table forbids it; self-FK rows go away with the table), routed through the **reverse foreign-key index** rather than a whole-catalog walk — see below.

#### Reverse foreign-key index

`getReferencingForeignKeys(parentSchemaName, parentTableName)` returns the FKs that reference a given parent `schema.table` — the shared primitive every parent-side referential scan short-circuits on. It is a lazily-built, event-invalidated derived cache on `SchemaManager`: a `Map` from the **referenced** `schema.table` (lowercased, resolved as the scans compute their target, `fk.referencedSchema ?? childTable.schemaName` — so a declared FK keys under its **parent's** schema: the explicit `references <schema>.<table>` qualifier when one was written, else the child's own schema) to the `{ childTable, fk }` entries that reference it. A table nothing references yields a shared frozen empty array — the O(1) gate replacing an `O(tables × FKs)` catalog walk; the returned `fk` is the object held in `childTable.foreignKeys` (identity preserved). Entries stay in schema-insertion → table → FK-declaration order, so a first-surviving-child RESTRICT pre-check names the same child the nested-loop scan did.

The cache is `null`ed (rebuilt from the live catalog on next access) on every mutation that can add/drop/retarget an FK or add/remove a schema: a self-subscription to the `SchemaChangeNotifier` resets it on any `table_added` / `table_modified` / `table_removed` (the only events an FK enters/leaves/retargets through — create-with-references, ALTER ADD/DROP CONSTRAINT, a parent/column-rename FK rewrite, DROP TABLE), and `addSchema` / `getOrCreateSchema` / `removeSchema` reset it directly since ATTACH/DETACH fire no event. The silent catalog-rehydration path nulls it directly too: `importTable` registers FK-bearing tables without firing `table_added` (and `getOrCreateSchema` only resets when it *creates* a schema), so a re-import onto an already-built index would otherwise under-report. Under-reporting would silently drop enforcement, so invalidation is deliberately broad; over-reporting a since-dropped FK is harmless, since the index key enforces the `referencedTable` / target-schema match (consumers that route through it therefore dropped those two filters) and each per-FK body still re-checks arity, its action gate, and the MATCH-SIMPLE NULL skip. The lazy first-access rebuild after a (rare) DDL amortizes across the many DML writes between DDLs.

#### Lens basis-FK gate

The **logical-FK analogue** of the reverse-FK index. A *logical* FK lives only on a child lens slot's `enforced-fk` obligation, on no basis table, so it is invisible to the reverse-FK index, which scans declared `TableSchema.foreignKeys`. Three basis-keyed lens FK paths reverse-map a written **basis** parent table to the logical parent slot(s) it backs, then walk every schema's lens slots for referencing logical FKs: the cascade walker `executeLensForeignKeyActions`, the RESTRICT pre-check `assertLensRestrictsForParentMutation`, and the divergent-basis-action suppression set `basisFksOverriddenByDivergentLensFk`. The gate gives all three the O(1) short-circuit the index gives the physical paths.

`basisTableBacksLogicalParentFk(schemaName, tableName)` answers: does this basis `schema.table` back ≥1 logical parent slot referenced by ≥1 logical FK? It is a lazily-built, event-invalidated derived `Set<string>` on `SchemaManager` keyed by the **basis parent** `schema.table` (lowercased) — the value each basis write carries. `buildLensBasisFkGate` (in `lens-fk-discovery.ts`) builds it by running once the same reverse-map slot scan the three paths perform per write: for each lens slot, resolve its single basis spine (`resolveSlotBasisSource`; a multi-source / decomposition parent resolves to none and contributes no key — *consistently* with the runtime `if (!basis) continue` skip), and add the basis key iff `findLogicalParentFkRefs(slot).length > 0`. A `false` answer early-returns each path; a `true` answer runs the full scan as confirmation.

The gate is `null`ed (rebuilt on next access) on every event that can change that scan's result, across **two** dependencies — the lens-slot set and the basis-table catalog (`resolveSlotBasisSource` resolves a bare table name against it):

- **Lens deploy / redeploy** — the slots are mutated only by `lens-compiler.deployLogicalSchema`'s clear-and-rebuild, which fires **no** `SchemaChangeEvent` (there is no lens event in the union), so it calls `invalidateLensFkGate()` directly.
- **Basis-table catalog** — the `SchemaChangeNotifier` self-subscription that resets the reverse-FK index also resets the gate on `table_added` / `table_modified` / `table_removed` (a basis table created *after* the gate was built is the under-report vector; a drop or column-rename can change which slot resolves to which basis).
- **Schema attach/detach + reset + silent import** — `addSchema` / `getOrCreateSchema` / `removeSchema` / `clearAll` (ATTACH/DETACH/reset fire no event) and the silent `importTable` rehydration path all null the gate alongside the reverse-FK index.

Invalidation is exhaustive for the index's reason, and **sharper**: a stale gate that **under-reports** would silently drop logical enforcement (cascade not propagated / RESTRICT not enforced / divergent basis action not suppressed). Built from — and reset alongside — the same catalog state the three paths scan, the gate **never under-reports** for the current catalog; over-reporting (a stray key ⇒ an on-hit scan that finds nothing) is harmless. The gate is action-agnostic (keyed on *any* referencing logical FK), so a slot referenced only by a RESTRICT logical FK hits for all three paths; each then filters by action in its own body — an over-report that is correct, not a miss.

#### `dropView(schemaName, viewName): boolean`

Removes a view definition from the schema.

#### `defineTable(definition: TableSchema): void`

Programmatic alternative to `CREATE TABLE` — registers a `TableSchema` directly in the `main` schema. A `Database`-level method (not SchemaManager), for a `TableSchema` obtained by parsing or built programmatically. Only the `main` schema is supported; throws `MisuseError` for others.

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

Imports existing schema objects without creating new storage — used when connecting to a backend that already holds data. For each DDL statement:
- `CREATE TABLE` calls `module.connect()` instead of `module.create()`
- `CREATE INDEX` registers the index metadata without calling `module.createIndex()`, reconstructing it with full fidelity from the re-parsed DDL — the `UNIQUE` flag, the partial `WHERE` predicate, and per-column collation (including the collate-wrapped column form the parser folds `COLLATE` into). A `CREATE UNIQUE INDEX` also re-synthesizes its `derivedFromIndex` UNIQUE constraint, as the live create path does.
- `CREATE VIEW` registers a plain view **without planning the body** — validation is deferred to first reference (as `importTable` defers create-time work via `connect`). View rehydration is therefore order-independent: a view over another view, a materialized view, or a not-yet-imported relation registers regardless of phase order, and a broken body surfaces only when the view is queried. The imported view name appears in the `views` result array.
- `CREATE MATERIALIZED VIEW` **re-materializes** through the same `materializeView` core the create emitter uses (`runtime/emit/materialized-view-helpers.ts`): the body is re-planned against the already-imported sources, the maintained table is rebuilt and filled **in the declared `USING <module>(...)` backing-host module** (memory when the clause is absent; an unknown or capability-less module fails the entry), and row-time maintenance is re-registered — but no `materialized_view_added` fires (`table_added` for the maintained table still does, as on create). A pre-existing **derivation-less** table at the MV's **own name** in the entry's backing module (a durable module's phase-1 rehydration) is **adopted** when the options below allow and every adopt gate passes, otherwise dropped and refilled from the body; a table there in a **different** module — or a maintained table already at the name — fails the entry without touching it. Unlike a plain view the body plans **eagerly** (the table cannot fill without running it), so MV import is order-dependent: sources, including another maintained table for MV-over-MV, must already be registered. A body that cannot plan, reads a still-pending maintained table (`pendingDerivations` below), fills with duplicate keys ("must be a set"), or fails the row-time eligibility gate throws after the half-built table is rolled back (a trusted pre-existing backing is instead preserved as a plain table — durable rows are not destroyed on a per-entry error). The imported MV name appears in the `materializedViews` result array.
- Schema change events are not emitted (these are existing objects)

**Options** (`ImportCatalogOptions`) — all default off; a plain `importCatalog(ddl)` always refills:
- `trustBackings` — caller-attested trust in pre-existing durable backings: the caller asserts no crash since they were last written (the store module sets this from its consumed clean-shutdown catalog marker). This is adopt gate 5; the full gate set and its rationale live in [`docs/mv-backing-host.md` § Cross-module atomicity](mv-backing-host.md#cross-module-atomicity).
- `adoptedBackings` — a shared `Set<string>` of lowercased qualified names (`schema.<table>`) of every maintained table adopted so far this rehydration session. An MV whose body reads another maintained table adopts only when that upstream is in the set — pass ONE set across all of the session's `importCatalog` calls so trust composes through fixpoint rounds.
- `pendingDerivations` — lowercased qualified names of maintained tables whose own `create materialized view` entries have NOT yet imported this session. An entry whose body reads one is deferred (throws, retried in a later fixpoint round): the source already exists as a *plain* pre-rehydrated table, so the body would plan — and adopt/refill against content the upstream's own import may be about to replace.

Each entry in `ddlStatements` may hold **more than one** statement: a table can be bundled with its `CREATE INDEX`es in one string, imported in document order (table before indexes). Single-statement entries remain valid. Any unsupported statement type throws (fail-loud), so the store's `rehydrateCatalog` records the failure rather than silently dropping the object.

### DDL Generation

> **Invariant:** [SCH-002](invariants.md#sch-002--the-per-column-primary-key-flags-mirror-primarykeydefinition)

Canonical schema → DDL generators are exported from the package entry point:

```typescript
import { generateTableDDL, generateIndexDDL, generateViewDDL, generateMaterializedViewDDL, generateIndexTagsDDL } from '@quereus/quereus';

const ddl = generateTableDDL(tableSchema, db?);                  // CREATE TABLE ...
const idxDdl = generateIndexDDL(indexSchema, tableSchema, db?);  // CREATE INDEX ...
const viewDdl = generateViewDDL(viewSchema);                     // CREATE VIEW main.v ...
const mvDdl = generateMaterializedViewDDL(maintainedTable);      // CREATE MATERIALIZED VIEW main.mv ...
const tagDdl = generateIndexTagsDDL(schemaName, indexName, tags); // alter index s.i set tags (...)
```

`generateViewDDL` / `generateMaterializedViewDDL` lift the stored schema back into the equivalent `CreateView` / `CreateMaterializedView` AST and render it through the shared `ast-stringify` emitter (the same schema→AST-lift `generateTableDDL` uses for constraints), so the persistence path and the declarative AST→SQL path cannot drift. They emit a **fully-qualified** (`schema.name`) name so a re-parse registers into the correct schema regardless of the session's current schema, and read the **live** `tags`, so an `ALTER VIEW … SET TAGS` (which swaps the in-memory schema without rewriting the stored `sql`) round-trips. `generateMaterializedViewDDL` takes the maintained `TableSchema` and re-derives the `USING <module>(...)` clause from its own `vtabModuleName`/`vtabArgs` through `normalizeBackingModule`, which yields a clause only for a non-default hosting module (`using memory()` with no args normalizes to nothing, keeping the memory default clause-free and canonical); on reopen the import path honors the clause and rebuilds the table in the named module. Both are a `parse → generate → parse` fixed point.

Both generators accept an optional `Database` argument for session context; emission depends on whether `db` is supplied:

| Aspect | With `db` | Without `db` |
|--------|-----------|--------------|
| Schema qualification | Elided when it matches `db.schemaManager.getCurrentSchemaName()` | Always qualified (`"schema"."name"`) |
| Column nullability | Only the annotation that differs from `default_column_nullability` is emitted | Every column is explicitly annotated (`NULL` or `NOT NULL`) |
| `USING <module> (...)` | Elided when both module and args match `default_vtab_module` / `default_vtab_args` | Always emitted for any `vtabModuleName` |

Use the no-`db` form when persisting DDL, so the output survives re-parsing under any session's `default_column_nullability`; use the with-`db` form for readable display or same-session round-trip.

Feature coverage (both forms): `TEMP`, schema qualification, inline single-column `PRIMARY KEY`, table-level `PRIMARY KEY (...)` (including singleton `PRIMARY KEY ()`), non-default column `COLLATE <name>` (the default `BINARY` is elided, so a `COLLATE NOCASE` column survives a persistence re-parse rather than reverting to `BINARY`), `DEFAULT <expr>`, `GENERATED ALWAYS AS (<expr>) STORED|VIRTUAL`, `USING <module>` with SQL-literal args, `ON CONFLICT` actions on keys and columns (below), `with context (...)`, and `WITH TAGS (...)` at table, column, and index levels.

**The generated-column storage keyword is always explicit.** `VIRTUAL` is the parser's default for an omitted keyword, so eliding it would round-trip correctly — but persisted DDL states it anyway, matching the no-`db` form's stance that persistence output must be unambiguous to any reader. `DEFAULT` and `GENERATED ALWAYS AS` are mutually exclusive on one column (`columnDefToSchema` rejects both), so the two clauses never co-emit.

**Collation does NOT elide the session default.** The column-`COLLATE` emitter elides only a *literal* `BINARY` — never the session `default_collation`, a deliberate contrast with nullability / `USING`, which DO elide theirs. The `default_collation` pragma (see `docs/sql.md` § 9.2.4) is a **create-time authoring convenience only**: it sets the collation an omitted-`COLLATE` column resolves to at `CREATE TABLE` time (text types only; non-text and JSON/temporal fall back to `BINARY`), while the catalog stores the concrete resolved collation and persisted DDL always carries an explicit `COLLATE` for any non-`BINARY` one. So a `NOCASE` column authored under `default_collation = 'nocase'` round-trips unambiguously under a different default. The rehydrate path (`SchemaManager.importTable`) resolves omitted-`COLLATE` columns to canonical `BINARY` — it does **not** read the live pragma — relying on this non-elision to make the persisted `COLLATE` the single source of truth. The declarative differ resolves the declared side's omitted `COLLATE` by the **same** create-time rule (threading the live `default_collation`), so a fresh `apply` matches direct DDL and a re-apply stays idempotent (no spurious `SET COLLATE`). `ALTER TABLE ... ADD COLUMN` likewise honors `default_collation` (non-text falls back to `BINARY`), and the differ emits an explicit resolved `COLLATE` on added columns so a migration authored under one default lands the same collation under any other. `RENAME COLUMN` deliberately does **not** consult the default: its AST is reconstructed from the live column (carrying an explicit `COLLATE` only for a non-`BINARY` collation), so a renamed column preserves its existing collation — threading the default there would silently flip an existing `BINARY` column to the session default.

`generateIndexDDL` emits a **lossless** `CREATE INDEX`: `CREATE [UNIQUE] INDEX <name> ON <table> (<cols>) [WHERE <predicate>] [WITH TAGS (...)]`. The `UNIQUE` keyword and partial `WHERE` clause are reconstructed on import, so a `CREATE UNIQUE INDEX` / partial index round-trips without degrading to plain/full. Clause order matches the parser grammar and the AST emitter `createIndexToString` (columns → `WHERE` → `WITH TAGS`), so re-parsing yields the same shape and the declarative differ (which matches indexes by name) does not churn. A UNIQUE index's derived constraint round-trips via the index statement itself: `generateTableDDL` omits any `derivedFromIndex` UNIQUE constraint from the table DDL, avoiding a double definition.

**Every primary key emits its clause**, with no exception — including the **synthesized all-columns key** a table gets when it declares no PRIMARY KEY. It emits inline when the key is a single column and table-level otherwise, exactly like a declared key. A declared all-columns PK and an omitted one therefore produce **identical DDL**: they are the same key (declaring a key does not change its columns' nullability — see **Primary-key nullability** above), and no test over the resulting schema can tell them apart. This keeps persisted DDL consistent with the no-`db` form's "state everything explicitly" stance. `packages/quereus/test/table-ddl-round-trip.spec.ts` pins it per primary-key shape, including a key over nullable columns emitted under `default_column_nullability = 'nullable'` and re-parsed under the stock `not_null`. Databases written before this change carry no clause for such a key; the re-synthesis path on import is unchanged, so they rehydrate to the same key (pinned by the same spec) and simply gain the clause on the next emission.

**Each `ON CONFLICT` record rides its own clause.** A table has two independent records, and consumers read them differently: a NOT NULL violation reads only the column's `ColumnSchema.defaultConflict`, while a duplicate key reads `TableSchema.primaryKeyDefaultConflict` first and then the first key column that declares an action (`resolvePkDefaultConflict`). The emitter never folds them together, so a re-parse reproduces both:

- **The column's action rides the column.** It appears on the inline `PRIMARY KEY` clause if the column carries one, otherwise on the nullability annotation (`NOT NULL ON CONFLICT <action>` / `NULL ON CONFLICT <action>`). A column's `primary key`, `not null` and `null` clauses share one slot, with the last one winning on re-parse, so only one clause carries it. In the with-`db` form this is the one exception to nullability elision: the annotation is emitted even when it matches the session default, because the action needs it.
- **The table's action rides the table-level clause**, `PRIMARY KEY (...) ON CONFLICT <action>`. A single-column key renders inline only when it has no table-level action to emit, since an inline clause would re-parse the action onto the column.
- **A declared `ABORT` is emitted like any other action.** It behaves like an absent action only until something else declares one. A column's `ABORT` matters because the key resolves to the first key column that declares anything: eliding `a`'s in `a … on conflict abort, b … on conflict replace, primary key (a, b)` would flip the key to `REPLACE`. A table-level `ABORT` matters because it outranks every column's action, including on a column that `ALTER PRIMARY KEY` later moves the key onto.

Text persisted before this rule still re-parses, with no migration, and simply gains the new spelling on the next emission. `packages/quereus/test/table-ddl-round-trip.spec.ts` compares both raw records across every shape, and `packages/quereus-store/test/pk-conflict-action-reopen.spec.ts` and `table-declaration-reopen.spec.ts` pin the behaviour across a store reopen.

**`with context (...)` is emitted between the `maintained as` clause and `WITH TAGS`.** It renders through the same `contextClauseToString` as the AST emitter. A bare variable is NOT NULL under any session default, because the parser always decides (the grammar's only marker is an optional `NULL`), so the clause needs no session-specific annotation. Without it, a table whose CHECK reads a variable refuses every write after a reopen, and one whose `DEFAULT` reads a variable fails to re-parse at all.

Emission is a `parse → generate → parse` fixed point: the second emission of a re-parsed schema is byte-identical to the first. `packages/quereus/test/table-ddl-round-trip.spec.ts` pins that across the primary-key shapes.

`@quereus/store` re-exports these symbols for backward compatibility:

```typescript
import { generateTableDDL } from '@quereus/store';
```

### Store catalog persistence

How `@quereus/store` durably persists table, index, constraint and tag state — the
bundled `CREATE TABLE` + index DDL catalog entry, its rehydration, and the rename
protocol that orders those writes — lives in
[Store catalog persistence](store-catalog-persistence.md).

### View and materialized-view persistence

How `@quereus/store` persists engine-level views and materialized views — the reserved-prefix
catalog keys, the schema-change subscription that writes them, the
`assertCatalogObjectPersistable` pre-flight veto, and the phased rehydrate that imports them —
lives in [view-persistence.md](view-persistence.md).

## Schema Path

The schema path controls search order for unqualified **relation** names — tables and views alike. Each entry's tables and views are checked together, so the first schema holding that name wins whatever its kind. `Database`-level methods:

| Method | Description |
|--------|-------------|
| `db.setSchemaPath(paths: string[])` | Sets the schema search order. Equivalent to `pragma schema_path` |
| `db.getSchemaPath(): string[]` | Returns the current schema search path as an array of schema names |

```typescript
db.setSchemaPath(['main', 'extensions', 'plugins']);
const path = db.getSchemaPath(); // ['main', 'extensions', 'plugins']
```

Note the deliberate asymmetry with DDL: unqualified DDL lands objects in the **current schema** (`schemaManager.setCurrentSchema(name)`, API-only), but unqualified read resolution consults only the schema path (default `main`, then `temp`) — never the current schema. An embedder setting a non-`main` current schema should set the schema path to match, or qualify references; see [SQL Reference § Schema Search Path](sql-select.md#211-schema-search-path-with-schema).

**Stored bodies resolve against their home schema.** A view or materialized-view body resolves its unqualified names against the *owning object's* schema first, then the database default path — independent of the referencing statement's path (a statement-level `with schema` never leaks into a stored body). This holds for reads and for write-through alike: an `insert` / `update` / `delete` through a view re-plans the body on the home path, so a write binds the same base tables the matching read does — including a subquery inside a body-derived expression the lowering copies into the base statement (see [View Updateability § Schema resolution during write-through](view-updateability.md)). So a view declared next to its tables in a non-`main` schema works under any session path, and `refresh materialized view` does not depend on the path at refresh time. An integrity assertion follows the same rule: it belongs to a schema (unique per schema, created/dropped by possibly-qualified name), and its stored CHECK body resolves unqualified table names against the assertion's own schema first — at create time, at commit-time enforcement, and in `explain_assertion`. Schema-authored expressions follow the same owner-first principle, but more strictly: a column `default`, a generated-column expression, a CHECK constraint and a foreign-key probe resolve against the owning table's schema *only*, with no default-path fallback, so one naming a relation in another schema must qualify it.

The same isolation applies to the **common-table-expression namespace**, not only the schema search path: a stored body binds only the `with` clause it declares itself, plus schema objects on its home path — a caller's `with` clause is invisible to it, so `with t as (…) select * from v` cannot substitute the caller's `t` for the base table `v` reads. Ephemeral write targets are excluded: a CTE-name DML target (`with c as (…) update c set …`) or an inline FROM-subquery target is part of the *caller's own statement*, so it keeps the caller's CTEs along with the caller's schema path.

**Schema-authored expressions never see the writing statement's namespace.** A column `default`, a generated-column expression, a `check` constraint and a foreign-key existence check are written in the *table's* definition, not in the statement doing the write, so their unqualified relation names always mean schema objects on the owning table's schema — never a `with` clause, whether the writing statement declared it itself or inherited it from an enclosing statement, and never a relation picked up from the writer's schema path. Given `create table temp.t (w integer default (select count(*) from c))`, both `with c as (…) insert into temp.t (id) values (1)` and an insert run under `pragma schema_path = 'main'` (or a per-statement `with schema main`) count rows of `temp.c`. All four kinds agree, so a table definition cannot disagree with itself about a bare name.

See the [Usage Guide](usage.md) for the consumer-facing declarative schema workflow, schema path resolution order, and `PRAGMA schema_path` syntax.

## Database Options Affecting Schema

`db.setOption()` / `db.getOption()` control several schema-related behaviors:

| Option | Effect |
|--------|--------|
| `schema_path` | Default search order for unqualified relation (table / view) names |
| `default_column_nullability` | Column nullability default — `'not_null'` (Third Manifesto default) or `'nullable'` |

See the [Usage Guide](usage.md) for the full options and pragmas reference.

## Schema Change Events

The `SchemaChangeNotifier` (via `schemaManager.getChangeNotifier()`) is a typed event system for observing schema mutations.

### Subscribing

```typescript
const notifier = db.schemaManager.getChangeNotifier();

const unsubscribe = notifier.addListener((event) => {
  // event.type, event.schemaName, event.objectName,
  // and (per type) event.oldObject / event.newObject
});

unsubscribe();   // when done
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
| `view_modified` | `oldObject`, `newObject: ViewSchema` | After `ALTER VIEW … SET TAGS`, or when an `ALTER TABLE/COLUMN RENAME` rewrites a dependent view body or its `with defaults` clause (which rides inside the body select, so the body rewrite covers it) |
| `materialized_view_added` | `newObject: TableSchema` (the maintained table) | After `CREATE MATERIALIZED VIEW`; also under the new name when `ALTER TABLE … RENAME TO` re-keys a maintained table |
| `materialized_view_removed` | `oldObject: TableSchema` (the maintained table) | After `DROP MATERIALIZED VIEW` — or `DROP TABLE` on a maintained table (one record, one drop); also under the old name on a maintained-table rename |
| `materialized_view_modified` | `oldObject`, `newObject: TableSchema` (the maintained table) | After `ALTER MATERIALIZED VIEW … SET TAGS` (catalog-only, no re-materialize), or when an `ALTER TABLE/COLUMN RENAME` rewrites a dependent MV body or its `with defaults` clause |
| `materialized_view_refreshed` | `object: TableSchema` (the maintained table) | After `REFRESH MATERIALIZED VIEW` |
| `module_added` | _(name only)_ | After module registration |
| `module_removed` | _(name only)_ | After module removal |
| `collation_added` | _(name only)_ | After collation registration |
| `collation_removed` | _(name only)_ | After collation removal |

All events carry `schemaName` and `objectName` fields. **Naming contract:** events fire the *stored* names of the swapped object — `schemaName` is the canonical (lowercase) schema name (canonicalized on tables/views/MVs at create/import time via `SchemaManager.canonicalSchemaName`), and `objectName` is the object's stored display casing, never the raw spelling from the triggering statement. Prepared statements rely on this: `Statement.compile()` invalidates its cached plan by comparing recorded dependencies (which carry stored names) against event names **exactly**, so a raw-cased name on either side would silently miss invalidation. The same stored-name guarantee holds for the **module-facing calls** the SchemaManager makes (`create`, `connect`, `createIndex`, `dropIndex`, `destroy`, `alterTable`, `renameTable`, …) — see [module authoring § Identifier casing in module-facing calls](module-authoring.md#identifier-casing-in-module-facing-calls).

Listener errors are caught and logged — a failing listener does not disrupt other listeners or the originating operation.

### Database-Level Events

The higher-level `db.onSchemaChange()` API aggregates schema events from all modules: a module with native event support emits its own; for others `SchemaManager` emits synthetic events. See the [Usage Guide](usage.md) for the database-level event API.

## Error Handling

Schema operations throw `QuereusError` with these common status codes:

| Code | Scenario |
|------|----------|
| `StatusCode.ERROR` | Module not found, schema not found, invalid DDL, module create/connect failure |
| `StatusCode.CONSTRAINT` | Table or index already exists (without `IF NOT EXISTS`), multiple primary key definitions |
| `StatusCode.NOTFOUND` | Table not found during `dropTable` (without `ifExists`) |
| `StatusCode.INTERNAL` | Module did not return a `tableSchema` after create, unexpected removal failure |
| `StatusCode.MISUSE` | Invalid argument format (e.g. non-object JSON for default vtab args) |

Errors carry source location (`line`, `column`) when the AST node has it. See [Error Handling](errors.md) for the full error model.

## Declarative Schema

Moved to [Declarative Schema](schema-declarative.md).

## Aggregate Function Algebra

`AggregateFunctionSchema.algebra` — the declared merge/negate/decode/decompose structure of an aggregate's accumulator — is documented in [Aggregate Function Algebra](aggregate-algebra.md).

