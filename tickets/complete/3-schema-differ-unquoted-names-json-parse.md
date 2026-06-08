description: schema-differ now quotes identifiers in DDL and guards JSON.parse
prereq: none
files:
  packages/quereus/src/schema/schema-differ.ts
  packages/quereus/test/schema-differ.spec.ts
  packages/quereus/src/emit/ast-stringify.ts (quoteIdentifier source)
----
## What was built

Two bugs fixed in `schema-differ.ts`:

1. **Identifier quoting in generateMigrationDDL** — All identifiers (table, view, index,
   assertion, column, schema names) in generated DDL are now passed through
   `quoteIdentifier()` from `ast-stringify.ts`. Reserved words, names with spaces,
   hyphens, or other special characters are double-quoted; plain identifiers pass through
   unquoted.

2. **JSON.parse guard in applyTableDefaults** — `JSON.parse(defaultVtabArgs)` is wrapped
   in try-catch. Malformed JSON throws a `QuereusError` (with `StatusCode.ERROR` and
   cause chain) including the table name, instead of propagating a raw `SyntaxError`.

## Testing

8 unit tests in `packages/quereus/test/schema-differ.spec.ts`:

- Reserved-word table names (`order`, `group`) → quoted in DROP TABLE
- Reserved-word view name (`select`) → quoted in DROP VIEW
- Reserved-word index name (`index`) → quoted in DROP INDEX
- Reserved-word table/column names in ALTER TABLE ADD/DROP COLUMN
- Schema prefix with space (`my schema`) → quoted
- Plain identifiers (`users`) → NOT quoted
- Special-character names (`my-table`, `has space`) → quoted
- Malformed defaultVtabArgs JSON → throws QuereusError with descriptive message

All 8 tests pass. Existing test suite unaffected (329 passing; 1 pre-existing unrelated
failure in 10.1-ddl-lifecycle.sqllogic).

## Usage

`generateMigrationDDL(diff, schemaName?)` produces safe DDL regardless of identifier
content. No API changes — quoting is automatic. `computeSchemaDiff` now throws a typed
error on bad JSON in schema-level vtab args rather than an untyped SyntaxError.
