description: Store DDL generator emits WITH TAGS for table, column, and index tags
files:
  - packages/quereus-store/src/common/ddl-generator.ts
  - packages/quereus-store/test/ddl-generator.spec.ts
  - packages/quereus/src/index.ts
---

# Store DDL Generator — WITH TAGS Emission

## What was built

The store's `generateTableDDL()` and `generateIndexDDL()` in `ddl-generator.ts` now emit `WITH TAGS` clauses, fixing a round-trip bug where tags were silently dropped during persist/restore via the `__catalog__` KV store.

### Key changes

- `formatTagValue()` — formats tag values as SQL literals (booleans as TRUE/FALSE)
- `formatTagsClause()` — formats a tags record as `WITH TAGS (key = value, ...)`
- Column-level, table-level, and index-level `WITH TAGS` emission
- Tag keys are quoted via `quoteIdentifier()` to handle reserved words/special characters

### Review fix

During review, tag keys were found to be emitted bare (unquoted), inconsistent with `catalog.ts` and `ast-stringify.ts` which both use `quoteIdentifier()`. Fixed by:
- Exporting `quoteIdentifier` from `@quereus/quereus` main index
- Importing and using it in the store's `formatTagsClause`
- Added test for reserved-word tag keys (`select`, `order`)

## Testing

15 tests pass in `ddl-generator.spec.ts`:
- "emits table-level WITH TAGS"
- "emits column-level WITH TAGS"
- "emits index-level WITH TAGS"
- "quotes tag keys that are reserved words"
- "does not emit WITH TAGS when tags are empty"

Run: `node --import ./packages/quereus-store/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus-store/test/ddl-generator.spec.ts" --reporter min --colors`

Full store suite (155 tests) passes. Type-check clean.

## Scope note

Constraint-level tags (CHECK, FOREIGN KEY, UNIQUE) cannot be emitted because those constraint types themselves are not yet emitted by the DDL generator.
