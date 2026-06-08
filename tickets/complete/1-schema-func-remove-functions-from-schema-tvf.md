description: Removed function rows from schema() TVF — functions belong in function_info() only
files:
  - packages/quereus/src/func/builtins/schema.ts
  - packages/quereus/test/basic.spec.ts
  - packages/quereus/test/logic/06.3-schema.sqllogic
----

## Summary

The `schema()` table-valued function was returning all 104 built-in functions alongside tables, indexes, and views. On a fresh database with no user objects, it returned *only* function rows. Since `function_info()` already exists as the dedicated TVF for function introspection, functions were removed from `schema()`.

## Changes

1. **schema.ts**: Removed the "Process Functions" loop from `processSchemaInstance` in `schemaFunc` (was lines 108-116).
2. **basic.spec.ts**: Updated first test to create a table and check for it in schema(), instead of checking for a built-in function.
3. **06.3-schema.sqllogic**: Removed `"function"` from expected distinct type outputs (2 locations).

## Test plan

- `schema()` on fresh DB returns 0 rows (was 104)
- `schema()` after CREATE TABLE/INDEX/VIEW returns only those schema objects
- `function_info()` still works for function introspection (unchanged)
- All 277 tests pass (1 pre-existing failure in 08.1-semi-anti-join.sqllogic, unrelated)
- Typecheck passes

## Usage

```sql
-- Schema objects (tables, indexes, views)
select * from schema();

-- Functions (use dedicated TVF)
select * from function_info();
```
