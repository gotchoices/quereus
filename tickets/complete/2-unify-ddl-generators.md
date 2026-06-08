description: Unified canonical DDL generator with session-aware emission; downstream consumers rewired to a single implementation
prereq: none
files:
  - packages/quereus/src/schema/ddl-generator.ts (canonical implementation)
  - packages/quereus/src/schema/catalog.ts (imports canonical generator; threads db through)
  - packages/quereus/src/index.ts (exports generateTableDDL, generateIndexDDL)
  - packages/quereus-store/src/common/index.ts (re-exports from @quereus/quereus)
  - packages/quereus-store/src/common/store-module.ts (imports canonical generator)
  - packages/quoomb-web/src/worker/quereus.worker.ts (uses canonical export, private copy removed)
  - packages/quereus-store/test/ddl-generator.spec.ts (expectations updated; no-db regression test added)
  - packages/quereus/test/schema/catalog.spec.ts (full-feature roundtrip + nullability pragma roundtrip)
  - docs/schema.md ("DDL Generation" subsection under Catalog)
  - docs/architecture.md (plugin helpers list references canonical generator)
----

## What shipped

One canonical pair lives in `packages/quereus/src/schema/ddl-generator.ts`:

- `generateTableDDL(tableSchema, db?)` → `CREATE TABLE ...`
- `generateIndexDDL(indexSchema, tableSchema, db?)` → `CREATE INDEX ...`

Exported from `@quereus/quereus` and re-exported from `@quereus/store` for backward compatibility. The two drift copies (store's private `src/common/ddl-generator.ts` and the quoomb worker's private `generateTableDDL` method) are gone.

## Emission semantics

The optional `Database` parameter supplies session context (never read from globals):

| Aspect | With `db` | Without `db` |
|---|---|---|
| Schema qualification | Elided if matches `db.schemaManager.getCurrentSchemaName()` | Always qualified (`"schema"."name"`) |
| Column nullability | Only emits annotation that differs from `default_column_nullability` | Always explicit (`NULL` or `NOT NULL`) |
| `USING <module> (...)` | Elided if both module and args match `default_vtab_module` / `default_vtab_args` | Always emitted when `vtabModuleName` is set |

The no-`db` form is designed for persistence — its output re-parses identically under any session configuration.

Feature coverage (all three original copies' superset): `TEMP`, schema qualification, inline single-column `PRIMARY KEY`, table-level `PRIMARY KEY (...)` (including singleton `PRIMARY KEY ()`), `DEFAULT <expr>` (via `expressionToString`), `USING <module>` with SQL-literal args (strings quoted, numbers bare — not JSON), and `WITH TAGS (...)` at table, column, and index levels with reserved-word-safe quoted keys. Identifiers are consistently double-quoted.

## Testing notes

Run locally:
- `yarn build` — clean
- `yarn test` — 2420 quereus + 167 store passing (rest of monorepo green)

Key tests:

- `packages/quereus/test/schema/catalog.spec.ts "DDL roundtrip"` — covers single-col PK, composite PK, singleton PK (`PRIMARY KEY ()`), full-feature roundtrip (tags + defaults + mixed nullability), and the `default_column_nullability` pragma roundtrip (emission polarity under both `'not_null'` and `'nullable'` modes).
- `packages/quereus-store/test/ddl-generator.spec.ts "without db context: always qualifies, annotates, and emits USING with custom args"` — guards the persistence-safe (no-`db`) form.

Validated round-trip invariants:
```
tableSchema → generateTableDDL(schema, db) → db.exec(ddl) → new tableSchema
```
preserves singleton `PRIMARY KEY ()`, composite PKs, explicit `NOT NULL` / `NULL` under any session nullability default, table-/column-/index-level `WITH TAGS`, and `DEFAULT` expressions.

## Usage

```typescript
import { generateTableDDL, generateIndexDDL } from '@quereus/quereus';

// Persistence (no db): fully-qualified, explicit nullability, USING always emitted
const persistedDdl = generateTableDDL(tableSchema);

// Display / same-session round-trip: elides session-default redundancy
const displayDdl = generateTableDDL(tableSchema, db);
```

`@quereus/store` still re-exports `generateTableDDL` / `generateIndexDDL` from its public `index.ts` so external consumers continue working.

## Review notes

- Behavior deliberately changed for the no-`db` form: it now always emits nullability annotations and always qualifies the schema. Two store tests that implicitly relied on the prior "elide when default / elide when main" behavior were updated to match (substring-only changes; test intent preserved).
- `db` is threaded through `collectSchemaCatalog` into both generators so session context reaches catalog DDL emission; previously the catalog's private generator was context-free.
- No new lint errors; the one pre-existing unused-import warning in `stats/histogram-builder.ts` is unrelated.
