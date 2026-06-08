description: Comprehensive emit/ast-stringify round-trip unit tests
files:
  packages/quereus/test/emit-roundtrip.spec.ts (main deliverable)
  packages/quereus/src/emit/ast-stringify.ts (reference)
  packages/quereus/src/emit/index.ts (imports)
  packages/quereus/src/parser/index.ts (imports)
----

## What was built

115 parse-stringify-parse-stringify round-trip tests in `emit-roundtrip.spec.ts`, verifying that the AST emitter produces stable SQL output across all major statement and expression types.

## Key files

- `packages/quereus/test/emit-roundtrip.spec.ts` — main test file
- Related: `emit-precedence.spec.ts` (24 tests), `emit-missing-types.spec.ts` (11 tests)

## Test coverage

- **62 statement round-trips**: SELECT (basic, WHERE, ORDER BY, LIMIT/OFFSET, GROUP BY/HAVING, DISTINCT, compound, subquery, JOINs, CTE, RECURSIVE), INSERT (VALUES, SELECT, column list, RETURNING, ON CONFLICT), UPDATE, DELETE, VALUES, CREATE TABLE (constraints, FOREIGN KEY, GENERATED), CREATE INDEX (basic, UNIQUE, partial), CREATE VIEW, DROP, ALTER TABLE, transactions, PRAGMA, ANALYZE
- **31 expression round-trips**: literals, column refs, unary ops, functions, CAST, CASE, subquery, EXISTS, IN, BETWEEN, COLLATE, window functions, nested/compound
- **8 identifier quoting tests**: reserved words, spaces, digit-prefix, embedded quotes
- **4 string escaping tests**: basic, embedded quotes, empty, multiple quotes
- **6 edge case tests**: NULL, aliases, star, table.star, schema-qualified, parseAll

## Validation

- All 115 tests pass
- Full test suite (1130 tests) passes with no regressions
- No emitter bugs discovered

## Not tested (covered elsewhere or not applicable)

- Operator precedence parenthesization — `emit-precedence.spec.ts`
- AST construction for missing types — `emit-missing-types.spec.ts`
- Bind parameters — don't round-trip through parser
- Extension schema statements (declareSchema, diffSchema, applySchema, explainSchema) — custom extension syntax
