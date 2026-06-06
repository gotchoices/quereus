description: |
  Emit a column-level `COLLATE <name>` clause from `formatColumnDef` in the
  canonical table DDL generator so a non-default column collation survives any
  re-parse of the canonical DDL — most importantly the @quereus/store
  persistence round-trip (closeAll → reopen → rehydrateCatalog). Today the table
  column path drops COLLATE entirely (only the index column path emits it), so a
  `... collate nocase` column silently reverts to BINARY on reopen, changing its
  comparison / sort / unique semantics.
files:
  - packages/quereus/src/schema/ddl-generator.ts                  # formatColumnDef — add COLLATE emission; mirror generateIndexDDL ~line 116
  - packages/quereus/src/util/comparison.ts                       # normalizeCollationName (canonical = trimmed, UPPERCASE; default 'BINARY')
  - packages/quereus/src/schema/column.ts                         # ColumnSchema.collation (default 'BINARY')
  - packages/quereus/src/schema/table.ts                          # columnDefToSchema (re-parse target; validateCollationForType); findPKDefinition uses column collation for synthesized key
  - packages/quereus/src/vtab/memory/layer/manager.ts             # checkUniqueByScanning honors schema.columns[i].collation (~line 1192) — proves restored collation changes enforcement
  - packages/quereus/test/ddl-generator-roundtrip-positions.spec.ts  # add table-column COLLATE reserved-word sweep + bare/quoted + elision asserts
  - packages/quereus-store/test/rehydrate-catalog.spec.ts         # add a collation-survives-reopen test (model after the no-PK introspection test, ~line 491)
prereq:
effort: medium
----

# Emit column-level COLLATE in canonical table DDL

## Problem

`generateTableDDL` → `formatColumnDef` (`ddl-generator.ts:285`) emits the column
name, logical type, nullability annotation, inline `PRIMARY KEY`, `DEFAULT`, and
`WITH TAGS` — but **never** `COLLATE`. The index column path
(`generateIndexDDL`, `ddl-generator.ts:114-119`) *does* emit COLLATE. Because
`@quereus/store` persists each table as its canonical DDL and rehydrates by
re-parsing that string (`rehydrateCatalog`), a non-default column collation does
not survive a close → reopen: the column silently reverts to `BINARY`.

```sql
create table t (name text collate nocase) using store;
-- ...closeAll + new Database + rehydrateCatalog...
-- name is now BINARY: case-insensitive uniqueness / ordering silently lost
```

This is **pre-existing** (not introduced by
`lens-no-pk-nullable-column-deploy-mismatch`) and also weakens the
"byte-identical schema on re-parse" guarantee for any collated column, including
a collated column that participates in a synthesized all-columns key.

## Design (resolved)

### Emission site & condition

In `formatColumnDef`, emit `COLLATE <quoteIdentifier(col.collation)>` when the
column carries a **non-default** collation:

```
emit when  col.collation && normalizeCollationName(col.collation) !== 'BINARY'
```

- The default (`BINARY`) is **elided** — matches the index convention and keeps
  the common form readable / byte-stable. `ColumnSchema.collation` defaults to
  `'BINARY'` (`column.ts:59`, `columnDefToSchema` `table.ts`), but some synthetic
  schemas use `''` (e.g. the test helper `makeColumn` in
  `ddl-generator-roundtrip-positions.spec.ts`). The truthy guard treats both
  `''` and `'BINARY'` as default-and-elided; `normalizeCollationName` (trim +
  UPPERCASE) folds casing so `'binary'` / `'BINARY'` both elide.

### Quoting policy — match the index column path

Use the **conditional** `quoteIdentifier` (already imported from
`../emit/ast-stringify.js`), **not** the unconditional `quoteName`. This is the
deliberate split documented in the `quoteName` JSDoc (`ddl-generator.ts:28-44`):
the collation name is an *operand* identifier and stays bare unless it is a
reserved word / non-bare-valid. So `COLLATE NOCASE` stays bare; `COLLATE
"select"` (a reserved-word collation) quotes. This is identical to what
`generateIndexDDL` already does at `ddl-generator.ts:116`.

### Placement within the column def

Column constraints re-parse order-independently (the parser loops column
constraints; `columnDefToSchema` switches on `constraint.type`), so position
does not affect round-trip. For a natural, SQLite-like spelling, place COLLATE
**after the nullability annotation and before the inline `PRIMARY KEY`** —
i.e. `"name" TEXT COLLATE NOCASE PRIMARY KEY DEFAULT ...`. (Any consistent
position works; this one reads naturally and keeps the byte output stable.)

### Import

Add `import { normalizeCollationName } from '../util/comparison.js';` to
`ddl-generator.ts` (it is already used widely across `schema/`).

### Why this is sufficient (re-parse path)

`columnDefToSchema` (`table.ts:225-253`) handles the `'collate'` column
constraint by calling `validateCollationForType` → `normalizeCollationName`,
storing the canonical UPPERCASE name back on `schema.collation`. So a generated
`COLLATE NOCASE` re-parses to `collation === 'NOCASE'`. No parser, AST, or
schema change is required — this is purely a generator gap.

### No default-elision config (both emit branches agree)

Unlike USING / nullability, collation has **no** session-default elision: the
no-db and db-context branches emit COLLATE identically, preserving the
byte-identical guarantee — same posture as the table-constraint emission added
earlier.

## Edge cases & interactions

- **`''` vs `'BINARY'` collation** — both are the default and must produce **no**
  `COLLATE` token. (Covered by an elision assert.)
- **Reserved-word collation name** (e.g. a collation literally named `select`) —
  must emit `COLLATE "select"` and re-parse to that name. Mirror the existing
  index-path reserved-word sweep; do **not** regress to unconditional quoting
  (the "ordinary identifiers are never over-quoted" suite would catch that).
- **Case normalization** — the schema stores UPPERCASE; emitting the stored value
  and re-parsing (which re-normalizes) is idempotent. Asserting `=== 'NOCASE'`
  pins it.
- **Synthesized all-columns key** — `findPKDefinition` derives each synthesized
  key column's `collation` from `columns[colIndex].collation` (`table.ts:705-720`).
  Restoring the column COLLATE on reopen therefore also restores the synthesized
  key's comparison semantics — otherwise a collated no-PK table's key reverts to
  BINARY. Worth a sanity assert but not a separate behavioral test.
- **`validateCollationForType` on re-parse** — the emitted collation must remain
  valid for the column's logical type (`supportedCollations`). It came from an
  already-validated table, so this holds; a generated DDL that would fail
  re-validation would mean a pre-existing schema-build bug, not a generator bug.
- **Declarative differ churn** — `schema-differ.ts` `extractDeclaredCollation`
  already defaults absent → `'BINARY'` and compares the *parsed declared* column
  against the *actual catalog collation* (not against the canonical DDL string),
  so adding COLLATE to canonical DDL must NOT introduce spurious
  ALTER/DROP churn. Verify a `diff schema` of an unchanged collated table stays
  empty (a DIFF-no-op assert in the store spec, or rely on the existing
  no-op-APPLY test extended with a collated column).
- **Enforcement actually changes on reopen** — memory-vtab UNIQUE scanning uses
  `compareSqlValues(..., schema.columns[colIdx].collation)`
  (`manager.ts:1188-1192`) and `IsolatedTable.keysEqual` compares PK columns
  under their declared collation, so a restored NOCASE collation genuinely
  alters uniqueness/key semantics — the fix is observable, not cosmetic.
- **Store-path collation enforcement is out of scope** — whether the
  `@quereus/store` write path itself enforces a UNIQUE under column collation is
  a separate concern; the store round-trip test should assert the **rehydrated
  schema's** `collation` field (deterministic), not lean on store-side
  case-insensitive UNIQUE rejection.

## Validation

### Unit — generator (extend `ddl-generator-roundtrip-positions.spec.ts`)

- **Reserved-word COLLATE sweep (table column path):** mirror the existing
  `'COLLATE name (generateIndexDDL → parse)'` test but drive
  `generateTableDDL` of a single-column table whose column carries
  `collation: kw` for every reserved word; parse the result, assert
  `stmt.type === 'createTable'` and the column's `'collate'` constraint
  collation (lower-cased) `=== kw`. (The makeColumn helper already exists; set
  `collation` via the overrides arg.)
- **Bare vs quoted:** `generateTableDDL` of a `collate nocase` column includes
  `COLLATE NOCASE` and **not** `COLLATE "NOCASE"`; a reserved-word collation
  quotes.
- **Default elision:** a column with `collation: 'BINARY'` and one with
  `collation: ''` each emit **no** `COLLATE` substring.
- **Round-trip semantics:** `generateTableDDL(create table t (name text collate
  nocase))` → parse → `columnDefToSchema` yields `collation === 'NOCASE'`.

### Store round-trip (extend `rehydrate-catalog.spec.ts`)

Model after the no-PK introspection test (~line 491):

- Phase 1 (`db1`, `USING store`): `CREATE TABLE ci (id INTEGER PRIMARY KEY, name
  TEXT COLLATE NOCASE) USING store`; insert a row so the DDL is persisted.
- Phase 2 (`db2`, same provider): `rehydrateCatalog`; expect `errors` empty.
- **Primary (deterministic) assert:** `db2.schemaManager.findTable('ci')!`
  column `name` has `collation === 'NOCASE'` (before the fix it would be
  `'BINARY'`).
- **Optional behavioral assert (only if it holds through the store path):**
  case-insensitive `ORDER BY name` / UNIQUE rejection. Keep the introspection
  assert authoritative; do not let a store-enforcement gap fail this DDL ticket.

## TODO

- Add `normalizeCollationName` import to `ddl-generator.ts`.
- In `formatColumnDef`, emit `COLLATE ${quoteIdentifier(col.collation)}` after the
  nullability annotation and before the inline PRIMARY KEY, guarded by
  `col.collation && normalizeCollationName(col.collation) !== 'BINARY'`.
- Extend `ddl-generator-roundtrip-positions.spec.ts`: table-column COLLATE
  reserved-word sweep, bare/quoted asserts, default-elision asserts, and a
  `collation === 'NOCASE'` round-trip assert.
- Add the collation-survives-reopen test to `rehydrate-catalog.spec.ts`
  (schema-introspection primary assert).
- Run `yarn workspace @quereus/quereus test` and the store package tests; run
  lint for `packages/quereus`. (`yarn test:store` exercises the store DDL path
  but is slower — run it if the store round-trip behavior needs confirmation.)
