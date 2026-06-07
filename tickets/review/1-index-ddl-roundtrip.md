description: Review the lossless CREATE INDEX DDL round-trip — generateIndexDDL now emits UNIQUE + partial WHERE, importIndex reconstructs unique/predicate/per-column collation (incl. the collate-wrapped column form) and synthesizes the derived UNIQUE constraint via a shared helper, and importCatalog accepts multi-statement (table+indexes) entries. Engine-only; prerequisite for store-secondary-index-persistence.
prereq:
files:
  - packages/quereus/src/schema/ddl-generator.ts          # generateIndexDDL: UNIQUE prefix + WHERE emission
  - packages/quereus/src/schema/table.ts                  # NEW exported appendIndexToTableSchema (+ derived UNIQUE)
  - packages/quereus/src/schema/manager.ts                # importIndex rewrite, importDDL (multi-stmt), resolveImportedIndexColumn, createIndex now uses shared helper
  - packages/quereus/src/index.ts                         # export appendIndexToTableSchema
  - packages/quereus-store/src/common/store-module.ts     # createIndex now uses the shared helper
  - packages/quereus/test/index-ddl-roundtrip.spec.ts     # NEW spec (12 tests)
  - docs/schema.md                                        # Catalog Import + DDL Generation sections
----

# Review: Lossless CREATE INDEX DDL round-trip (engine)

## What this delivers

A secondary index now survives being persisted as canonical DDL and rehydrated
by re-parsing. Three engine facts that previously failed now hold:

1. **`generateIndexDDL` emits the full shape**
   `CREATE [UNIQUE] INDEX <name> ON <table> (<cols>) [WHERE <predicate>] [WITH TAGS (...)]`.
   - `UNIQUE` prefix when `indexSchema.unique`.
   - `WHERE <predicate>` via `expressionToString(indexSchema.predicate)` (the same
     emitter used for DEFAULT/CHECK — no hand-rolled stringification).
   - Clause order (columns → WHERE → WITH TAGS) matches the parser grammar and the
     AST emitter `createIndexToString`. Per-column `COLLATE`/`DESC`/`WITH TAGS`
     emission is unchanged (still always emits explicit `COLLATE`, incl. `BINARY`).

2. **`SchemaManager.importIndex` reconstructs with full fidelity** from the
   re-parsed `CreateIndexStmt`: per-column collation, `unique` (`stmt.isUnique`),
   `predicate` (`stmt.where`), and — for a unique index — the `derivedFromIndex`
   UNIQUE constraint. It now unwraps the **collate-wrapped column form**: the
   parser folds `col COLLATE x` into a `collate` expression over a column ref, so
   `col.name` is unset. Because `generateIndexDDL` always emits an explicit
   `COLLATE`, *every* generated index DDL re-parses into this form — so the old
   `if (!colName) throw "Expression-based index columns…"` previously rejected
   **every** generated index DDL, not just non-BINARY ones. A genuine expression
   index (`lower(email)`) is still rejected.

3. **`importCatalog` accepts multi-statement entries.** `importSingleDDL` (threw
   on `parseAll(ddl).length !== 1`) was replaced by `importDDL`, which imports
   every statement in document order so a `CREATE TABLE` precedes the
   `CREATE INDEX`es bundled after it. Unsupported statement types still throw
   (fail-loud, which `rehydrateCatalog` relies on). Empty string is a no-op.
   Single-statement entries remain valid (relaxation, not a breaking change).

### DRY: shared helper

`appendIndexToTableSchema(tableSchema, indexSchema)` is new in `table.ts`
(exported from the package entry point). It appends the index and synthesizes the
derived UNIQUE constraint, and is now the **single source of truth** for the three
sites that must agree: `SchemaManager.createIndex` (live DDL — the old private
`addIndexToTableSchema` was deleted), `SchemaManager.importIndex` (rehydrate), and
`StoreModule.createIndex` (store cache refresh — its inline block was replaced).
The symmetric removal still lives in `SchemaManager.dropIndex` / `StoreModule.dropIndex`.

## Validation performed

- `yarn workspace @quereus/quereus run build` — clean (tsc).
- `yarn workspace @quereus/store run build` — clean (confirms the new export
  resolves and the store change compiles).
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus run test` — **5164 passing, 9 pending**, no
  regressions (covers ddl-generator-roundtrip-positions, declarative-equivalence,
  catalog, and the `06.3` / `06.4.2` index sqllogic).
- New `test/index-ddl-roundtrip.spec.ts` — **12 passing**. Also type-checked via
  `tsc --noEmit -p tsconfig.test.json` (0 errors in the new file).

## Use cases / what the tests cover (the floor — extend as needed)

- **generateIndexDDL → parse**: unique, partial (WHERE), composite + DESC, tags;
  every generated DDL re-parses to an equivalent `createIndex` AST.
- **importCatalog reconstruction** (the core): build table + 5 representative
  indexes via `Database`, generate DDL, import the bundle into a fresh DB; assert
  `index_info()` and `unique_constraint_info()` round-trip **byte-for-byte** plus
  explicit spot-checks (unique=1, collation=NOCASE, partial=1, desc=1, tags JSON,
  two synthesized derived constraints, partial-derived carries partial=1).
- **collate-wrapped column** imports without the expression-index rejection
  (`CREATE INDEX i ON t (email COLLATE NOCASE)` → collation NOCASE).
- **genuine expression index** (`lower(email)`) still rejected.
- **multi-statement**: `CREATE TABLE … ; CREATE INDEX …` bundle imports both in
  order; empty string no-op; `select 1` throws.
- **declarative differ stability**: a declared UNIQUE index, applied then
  re-diffed against the catalog, produces no migration (the actual-side DDL now
  carries `UNIQUE`; index matching is name-based, so no churn).

## Known gaps — please scrutinize

- **Memory-module `connect` limitation shapes the tests.** A *genuinely fresh*
  table+index bundle (CREATE TABLE + CREATE INDEX with **no** pre-existing table)
  cannot be imported via the memory module: `MemoryTableModule.connect()` throws
  "Memory table definition not found" because memory requires a prior `create()`.
  The store module's `connect()` *is* the real rehydrate path and works on fresh
  storage — so the engine tests pre-create the table (memory manager exists) and
  the genuine fresh table-first ordering through `connect()` is exercised
  end-to-end only by the downstream `store-secondary-index-persistence` ticket.
  The engine-level ordering *logic* (table stmt before index stmt; index resolves
  the preceding table) **is** covered here. Reviewer: confirm you're comfortable
  that the fresh-`connect` path is deferred to the store ticket rather than
  forced through a throwaway test module.
- **Partial index is not expressible in the declarative `declare schema { … }`
  grammar** (`declareIndexItem` parses no WHERE). The differ-stability test
  therefore covers a UNIQUE index only. This is *safe* because the differ matches
  indexes by name + tags and never compares predicate/unique bodies (so partial
  can't churn either) — but that "differ ignores predicate drift" property is
  asserted only indirectly. Worth a second look at `schema-differ.ts` index loop.
- **Live `CREATE INDEX … COLLATE x` is still rejected** by `buildIndexSchema`
  (documented in `06.4.2-collation-extras.sqllogic`: "Indices on expressions are
  not supported"). I deliberately scoped the collate-unwrap to *import* only (per
  the ticket). The round-trip still works because a collated index is creatable
  via column-inherited collation (`name text collate nocase` + `create index on
  t(name)`), and `generateIndexDDL` emits the explicit `COLLATE` that importIndex
  unwraps. Whether `buildIndexSchema` should also accept the inline collate form
  for symmetry is a separate enhancement (would require updating that sqllogic
  test) — flagging in case the reviewer wants a follow-up ticket.
- **`test:store` not run** (slow; store wiring is the next ticket). The store
  package was *built* but its LevelDB tests were not executed in this ticket.

## Not in scope (downstream)

Store-side persistence wiring — bundling a table with its index DDLs into one
catalog entry and writing/loading it — lands in `store-secondary-index-persistence`,
which depends on all three behaviors above.
