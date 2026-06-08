description: Metadata tags (WITH TAGS) on schema objects — reviewed and complete
files:
  - packages/quereus/src/parser/ast.ts
  - packages/quereus/src/parser/parser.ts
  - packages/quereus/src/schema/table.ts
  - packages/quereus/src/schema/column.ts
  - packages/quereus/src/schema/view.ts
  - packages/quereus/src/schema/manager.ts
  - packages/quereus/src/schema/catalog.ts
  - packages/quereus/src/schema/schema-hasher.ts
  - packages/quereus/src/emit/ast-stringify.ts
  - packages/quereus/src/planner/nodes/create-view-node.ts
  - packages/quereus/src/planner/building/create-view.ts
  - packages/quereus/src/runtime/emit/create-view.ts
  - packages/quereus/test/logic/metadata-tags.sqllogic
  - packages/quereus/test/emit-roundtrip.spec.ts
  - packages/quereus/test/schema-manager.spec.ts
  - docs/sql.md
  - docs/schema.md
---

# Metadata Tags on Schema Objects — Complete

## What was built

`WITH TAGS (key = value, ...)` syntax for arbitrary key-value metadata on tables, columns, constraints (CHECK/UNIQUE/FK), views, and indexes. Tags are informational only — they do not affect query behavior or schema hashing. `TAGS` is a contextual keyword that does not break its use as an identifier.

## Key design notes

- Tag values: string, number, boolean (true/false), null, negative numbers
- `WITH TAGS` can appear alongside `WITH CONTEXT` in any order
- After a column constraint (e.g. `PRIMARY KEY WITH TAGS (...)`), tags attach to the **constraint**, not the column. Column-level tags require a separate `WITH TAGS` after all constraints.
- Duplicate `WITH TAGS` clause detection in loop-based parser contexts (CREATE TABLE, DECLARE TABLE)

## Review findings

- **Code quality**: Clean, modular. Tag parsing (`parseTags`/`parseTagValue`) is a focused helper. Tag threading is consistent through all extraction paths (columns, CHECK, FK, UNIQUE, index, view).
- **Immutability**: All tag records are frozen via `Object.freeze({ ...tags })` — good defensive copies.
- **Schema hashing**: `stripTagsFromDeclaredSchema` correctly strips tags from all schema items (tables, columns, constraints, indexes, views) before hash computation.
- **DDL round-trip**: Tags survive parse → stringify → re-parse for all DDL types (verified by new round-trip tests).
- **Minor DRY note**: `tagValueToString` (ast-stringify.ts) and `formatTagValue` (catalog.ts) are near-duplicates differing only in keyword casing (lowercase vs uppercase). This is intentional — each matches its surrounding formatting convention. Not worth extracting a shared helper for 6 lines.
- **Docs**: sql.md has syntax, EBNF grammar, and examples. schema.md documents all schema interface additions and the programmatic API.

## Tests added during review

### emit-roundtrip.spec.ts
- Table-level tags, column-level tags, constraint tags (column + table), all value types, combined WITH TAGS + WITH CONTEXT (both orderings), CREATE INDEX with tags, CREATE VIEW with tags

### schema-manager.spec.ts
- `getTableTags` returns tags after creation / returns undefined without tags
- `setTableTags` replaces tags / clears with empty object / throws for nonexistent table
- Column-level tags preserved on column schema
- Constraint tags vs column tags distinction
- CHECK constraint tags preserved
- View-level tags preserved
- Schema hash unchanged by tags (table-level and column-level)
- Schema hash changes when structure differs (control test)

## Test results

- 1437 tests passing, 0 failures
- Build clean
- No new lint issues in source files
