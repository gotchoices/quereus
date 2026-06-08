description: Tests for under-covered built-in functions, type system, and conversion paths
files:
  packages/quereus/test/logic/97-json-function-edge-cases.sqllogic
  packages/quereus/test/logic/98-temporal-edge-cases.sqllogic
  packages/quereus/test/logic/99-conversion-edge-cases.sqllogic
  packages/quereus/test/property.spec.ts
  packages/quereus/test/visitor.spec.ts
----

## Summary

Added ~290 test assertions across three `.sqllogic` files covering edge cases in JSON functions,
temporal types, and type conversion paths. Extended property-based tests with temporal roundtrip
and conversion idempotency checks. Extended parser visitor tests with broad AST node type coverage.

## Key files

- **97-json-function-edge-cases.sqllogic** — ~150 assertions covering json_valid, json_schema,
  json_type, json_extract, json_quote, json_object, json_array, json_array_length, json_patch,
  json_insert, json_replace, json_set, json_remove, json_group_array/object, JSON path edge cases,
  and deep copy verification.
- **98-temporal-edge-cases.sqllogic** — ~80 assertions covering date/time/datetime parsing,
  timespan ISO 8601/human-readable/numeric parsing, all 7 extraction functions, all 4 total
  functions, temporal arithmetic, and TIMESPAN storage/retrieval/comparison.
- **99-conversion-edge-cases.sqllogic** — ~60 assertions covering integer/real/text/boolean/json/
  timespan conversions, schema introspection (schema, table_info, foreign_key_info, function_info),
  typeof, and cross-type conversion chains.
- **property.spec.ts** — Added temporal roundtrip (DATE, TIME) and conversion idempotency
  (integer, real, text) property-based tests, each with 100 random inputs.
- **visitor.spec.ts** — Covers INSERT/UPDATE/DELETE/VALUES statements, JOIN/function/subquery
  sources, CAST/COLLATE/function/subquery/unary expressions, GROUP BY/HAVING/ORDER BY/LIMIT/
  OFFSET/UNION, and DDL (CREATE TABLE/INDEX/VIEW, DROP).

## Review notes

- All 1468 tests pass (0 failures, 2 pending — pre-existing)
- Build passes clean
- Lint: no new issues (pre-existing tsconfig parsing errors for test files)
- All `.sqllogic` tests exercise the public SQL interface — no coupling to implementation internals
- Property tests use `db.eval()` (public interface) with appropriate fast-check arbitraries
- visitor.spec.ts imports from `src/parser/visitor.ts` (internal, not re-exported from public API),
  which is appropriate for internal unit testing of the AST traversal utility
- Tables are properly dropped after use; db closed in afterEach; statements finalized
- Functions tested are already documented in docs/sql.md, docs/functions.md, docs/usage.md
