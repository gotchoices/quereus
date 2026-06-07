description: Make CREATE INDEX DDL round-trip losslessly through the engine — generateIndexDDL must emit UNIQUE + partial WHERE, importIndex must reconstruct unique/predicate/per-column collation and synthesize the derived UNIQUE constraint, and importCatalog must accept multi-statement catalog entries (a table bundled with its indexes). Prerequisite for store-backed secondary-index persistence.
prereq:
files:
  - packages/quereus/src/schema/ddl-generator.ts          # generateIndexDDL: add UNIQUE + WHERE emission
  - packages/quereus/src/schema/manager.ts                # importIndex (~2433), importSingleDDL/importCatalog (~2351)
  - packages/quereus/src/schema/table.ts                  # IndexSchema (unique/predicate/columns[].collation), maybe shared add-index helper
  - packages/quereus/src/emit/ast-stringify.ts            # createIndexToString — compare clause ordering for differ stability
  - packages/quereus/src/parser/parser.ts                 # CreateIndexStmt: isUnique, where, indexedColumnList (collation folding)
  - packages/quereus/src/func/builtins/schema.ts          # index_info() — already surfaces unique/partial/collation/tags
  - packages/quereus/test/ddl-generator-roundtrip-positions.spec.ts  # extend, or add new spec
  - packages/quereus/test/declarative-equivalence.spec.ts # differ must stay stable for unique/partial indexes
  - docs/schema.md                                        # DDL-generation section
----

# Lossless CREATE INDEX DDL round-trip (engine)

## Why

The store catalog persists schema as canonical DDL and rehydrates by re-parsing
it (`SchemaManager.importCatalog`). For a secondary index to survive that round
trip, three engine-level facts must hold that do **not** today:

1. `generateIndexDDL` must emit a `CREATE INDEX` string that, when re-parsed,
   reconstructs the *same* index — including its UNIQUE flag and partial WHERE
   predicate. Today it emits neither (`parts = ['CREATE INDEX']`, no WHERE), so
   `CREATE UNIQUE INDEX` and partial indexes silently degrade to plain/full.
2. `SchemaManager.importIndex` must rebuild the full `IndexSchema` from the
   re-parsed AST — `unique` (`stmt.isUnique`), `predicate` (`stmt.where`), and
   per-column `collation` — and synthesize the `derivedFromIndex` UNIQUE
   constraint for a unique index, exactly as the live create path does. Today it
   builds only `{ index, desc }` columns and `{ name, columns, tags }`, dropping
   uniqueness, partiality, collation, and the derived constraint.
3. `importCatalog` must accept a catalog entry that contains **more than one**
   statement (a table immediately followed by its `CREATE INDEX`es). Today
   `importSingleDDL` throws when `parser.parseAll(ddl).length !== 1`.

This ticket is engine-only and independently testable. The store-side
persistence wiring lands in `store-secondary-index-persistence`, which depends
on all three behaviors here.

## Design

### generateIndexDDL (ddl-generator.ts)

Current emission order: `CREATE INDEX <name> ON <table> (<cols>) [WITH TAGS]`.
Change to match the parser's grammar (`parser.ts` createIndex: columns → WHERE →
WITH TAGS) and the AST emitter `createIndexToString`:

```
CREATE [UNIQUE] INDEX <name> ON <table> (<cols>) [WHERE <predicate>] [WITH TAGS (...)]
```

- Prefix `UNIQUE ` when `indexSchema.unique`.
- After the column list, when `indexSchema.predicate` is set, append
  `WHERE ${expressionToString(indexSchema.predicate)}` (reuse the same
  `expressionToString` already imported for DEFAULT/constraint emission — do
  **not** hand-roll predicate stringification).
- Leave the existing per-column `COLLATE`/`DESC`/index-level `WITH TAGS` emission
  unchanged.

Clause-ordering MUST match `createIndexToString` (ast-stringify.ts) byte-for-byte
so the declarative differ — which compares `generateIndexDDL` (catalog/actual)
against the declared-AST rendering — does not churn a spurious DROP/CREATE INDEX.
Confirm against `createIndexToString` before finalizing; if it differs, align to it.

### importIndex (manager.ts ~2433)

Rebuild the index from the re-parsed `CreateIndexStmt` with full fidelity:

- **collation** — mirror `buildIndexSchema` (manager.ts ~2031):
  `normalizeCollationName(indexedCol.collation || tableColSchema.collation || 'BINARY')`.
  ⚠️ The parser folds `("col" COLLATE x)` such that the collation may live on the
  indexed column's `expr` (a `collate` expression) rather than `col.collation`
  (see `collationOf` in `ddl-generator-roundtrip-positions.spec.ts`, which checks
  both `col.collation` and `col.expr.collation`). If `email COLLATE NOCASE`
  parses to an expr-wrapped column, the current `if (!colName) throw` arm
  (`Expression-based index columns are not supported during import`) would
  REJECT a perfectly ordinary collated index from the catalog. Handle the
  collate-wrapped form: when the column is a `collate` expr over a bare column
  reference, extract the underlying column name and the collation. (A genuine
  expression index — non-column — stays rejected.)
- **unique** — `stmt.isUnique`.
- **predicate** — `stmt.where` (the AST.Expression; `IndexSchema.predicate` holds
  the AST, compiled lazily by consumers).
- **derived UNIQUE constraint** — when `unique`, append to the table's
  `uniqueConstraints`:
  `{ name: indexName, columns: index column indices, predicate: stmt.where, derivedFromIndex: indexName }`.
  This is what store-backed UNIQUE enforcement (full-scan over `uniqueConstraints`)
  and `emitTableConstraints`' `derivedFromIndex` exclusion both key on. Mirror
  `StoreModule.createIndex` (store-module.ts ~372) and
  `SchemaManager.addIndexToTableSchema` exactly.

DRY: prefer extracting a single helper that appends an index + its optional
derived UNIQUE constraint to a `TableSchema`, used by `importIndex`, the live
`SchemaManager.createIndex` schema update, and referenced by store
`createIndex`. If the live path's helper isn't cleanly reusable, mirror it and
add a comment cross-linking the three sites so they cannot drift.

### importCatalog / importSingleDDL (manager.ts ~2351)

Allow multiple statements per DDL string. Parse all statements and import each in
document order (so a `CREATE TABLE` precedes the `CREATE INDEX`es that follow it
in the same bundle). Replace the `length !== 1` throw with a loop over
`parser.parseAll(ddl)`, routing each `createTable`/`createIndex` through the
existing `importTable`/`importIndex`, and still throwing on any unsupported
statement type. Update the method doc comment (it currently says "expects exactly
one statement per DDL"). Single-statement entries (today's catalog shape) remain
valid — this is a relaxation, not a breaking change.

Because each table's indexes are co-located with their table in one bundle, a
`CREATE INDEX` only ever references a table that precedes it in the *same* entry —
no global table-before-index ordering across catalog entries is required.

## Edge cases & interactions

- **Collate-wrapped index column** (above) — the highest-risk parse-shape; a plain
  `create index i on t (c collate nocase)` must import without the "expression
  index" rejection and land `collation === 'NOCASE'`.
- **Declarative differ stability** — a declared schema containing a UNIQUE or
  partial index, diffed against the same persisted/actual index, must produce
  zero migration statements. Adding UNIQUE/WHERE to `generateIndexDDL` changes
  the actual-side string; verify it now *matches* the declared-AST side
  (`createIndexToString`) rather than introducing a new mismatch
  (`declarative-equivalence.spec.ts`, `catalog.spec.ts`).
- **index_info() consistency** — `index_info` already reports
  `unique`/`partial`/`collation`/`tags` from the schema; after import these must
  reflect the reconstructed values (it's the assertion surface for the tests).
- **Derived-constraint double-emit** — `emitTableConstraints` skips
  `derivedFromIndex` UNIQUE constraints, so the table DDL must NOT also emit the
  unique constraint that the `CREATE UNIQUE INDEX` round-trips. Confirm a
  `CREATE UNIQUE INDEX` table's generated table DDL carries no UNIQUE clause for
  that index (only the index statement does).
- **DESC / multi-column / tags** — composite, descending, and tagged indexes must
  all round-trip; tags already flow through both `generateIndexDDL` and
  `importIndex`.
- **Non-column expression index** — still unsupported; the import rejection stays
  for genuine expression columns (only the collate-wrapped *column* form is
  accepted).
- **Empty / unsupported statement in a bundle** — a bundle containing an
  unsupported statement type still throws (no silent skip), preserving the
  fail-loud contract `rehydrateCatalog` relies on to record errors.

## TODO

- generateIndexDDL: emit `UNIQUE` prefix when `indexSchema.unique`.
- generateIndexDDL: emit `WHERE <predicate>` via `expressionToString` when
  `indexSchema.predicate` set, ordered columns → WHERE → WITH TAGS.
- Verify generateIndexDDL clause order matches `createIndexToString`; align if not.
- importIndex: reconstruct per-column `collation`, handling the collate-wrapped
  column form (read from `col.collation` or the `collate` expr); fall back to the
  table column's collation then `'BINARY'`.
- importIndex: set `unique` from `stmt.isUnique`, `predicate` from `stmt.where`.
- importIndex: synthesize the `derivedFromIndex` UNIQUE constraint when unique.
- Extract/mirror a shared "append index (+ derived UNIQUE)" helper across
  importIndex, live createIndex, and (referenced by) store createIndex.
- importCatalog/importSingleDDL: import all statements per DDL string in order;
  drop the one-statement restriction; update the doc comment.
- Tests: generateIndexDDL → parse round-trip for unique / partial(WHERE) /
  desc / collation / composite / tags.
- Tests: build table+index via `Database`, `generateIndexDDL`, import the bundle
  into a fresh `Database` via `importCatalog`; assert `index_info` shows
  unique=1 / partial=1 / collation / desc / tags and `unique_constraint_info`
  shows the synthesized derived constraint.
- Tests: `importCatalog` accepts a single string holding `CREATE TABLE` +
  `CREATE INDEX` and imports both (table before index).
- Tests: declarative differ produces no diff for a unique/partial index present
  on both declared and actual sides.
- Docs: update `docs/schema.md` DDL-generation section (and the README DDL bullet
  if needed) to note UNIQUE / partial-WHERE index round-trip and multi-statement
  catalog import.
