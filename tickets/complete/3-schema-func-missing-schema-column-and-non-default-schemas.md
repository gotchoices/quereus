description: Schema() TVF now has schema column and enumerates all schemas; function_info() also enumerates all schemas
prereq: none
files: packages/quereus/src/func/builtins/schema.ts, packages/quereus/src/schema/manager.ts, packages/quereus/test/logic/06.3.1-schema-all-schemas.sqllogic, docs/sql.md
----

## What was built

- Added `schema` (TEXT, non-null) as the first column of the `Schema()` TVF return type, containing the schema name (e.g. `'main'`, `'temp'`, or any declared schema).
- Both `schemaFunc` and `functionInfoFunc` now iterate all schemas via `schemaManager._getAllSchemas()` instead of hardcoding main+temp.
- Docs updated to reflect the new column and example queries.

## Key files

- `packages/quereus/src/func/builtins/schema.ts` — schema column at position 0; `processSchemaInstance` generator yields rows per schema; both TVFs iterate `_getAllSchemas()`.
- `packages/quereus/src/schema/manager.ts` — `_getAllSchemas()` returns all registered schemas.
- `docs/sql.md` — schema introspection section updated with `schema` column.

## Testing

- `packages/quereus/test/logic/06.3.1-schema-all-schemas.sqllogic` — 5 test cases:
  1. `schema` column exists and shows `'main'` for main-schema objects
  2. All rows have a non-null `schema` column
  3. Non-default (declared) schema objects appear with correct schema name
  4. Both main and declared schema tables appear with correct values
  5. Functions from all schemas appear (built-in in `'main'`)
- All 1415 existing tests pass — existing tests use named column access, so the new column at position 0 is non-breaking.

## Review notes

- Code is clean and DRY; `processSchemaInstance` is a well-scoped inner generator.
- Error row includes empty string for schema column, consistent with the new column position.
- `yieldFunctionRow` helper keeps function_info TVF tidy.
- No performance or resource cleanup concerns.
