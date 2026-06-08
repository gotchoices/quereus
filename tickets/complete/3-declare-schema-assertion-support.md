description: Add assertion support to DECLARE SCHEMA (parse, diff, DDL generation)
prereq: none
files:
  packages/quereus/src/parser/ast.ts              # DeclaredAssertion type, DeclareItem union
  packages/quereus/src/parser/parser.ts            # declareSchemaStatement, declareAssertionItem
  packages/quereus/src/emit/ast-stringify.ts       # createAssertionToString, declareItemToString
  packages/quereus/src/schema/schema-differ.ts     # computeSchemaDiff, generateMigrationDDL
  packages/quereus/test/logic/50-declarative-schema.sqllogic  # integration tests (steps 54-65)
  docs/sql.md                                      # declaration syntax example updated
  docs/schema.md                                   # SchemaDiff description updated
----

## What was built

`ASSERTION` as a supported item type within `DECLARE SCHEMA { ... }` blocks — full pipeline from parsing through diffing to DDL generation.

- **AST**: `DeclaredAssertion` interface wrapping `CreateAssertionStmt`, added to `DeclareItem` union
- **Parser**: `ASSERTION` keyword branch in `declareSchemaStatement()` + `declareAssertionItem()` delegates to existing `createAssertionStatement()` (DRY)
- **Stringify**: `createAssertionToString()` exported, integrated into `astToString()` and `declareItemToString()`
- **Schema differ**: assertion diffing in `computeSchemaDiff()` (declared vs actual maps), DDL ordering in `generateMigrationDDL()` (drops before tables, creates after tables)

## Testing

Tests in `50-declarative-schema.sqllogic` steps 54-65:

- Declare with assertion, diff shows CREATE ASSERTION DDL (step 55)
- Apply creates assertion, subsequent diff empty (step 58)
- Assertion enforced — commit with violation fails (step 59)
- Valid insert succeeds (step 61)
- Redeclare without assertion, diff shows DROP ASSERTION (step 62)
- Apply removes assertion, violation no longer fails (step 64)
- Multiple assertions in one declaration, independently enforced (step 65)

## Review notes

- Build, tests (121 passing), and lint all clean
- Consistent with existing view/index patterns (add/drop by name, no content diffing)
- DDL ordering correct: drops assertions before tables, creates after tables
- Docs updated: assertion example in sql.md declaration syntax, SchemaDiff description in schema.md

## Usage

```sql
declare schema main {
  table accounts {
    id INTEGER PRIMARY KEY,
    balance INTEGER NOT NULL
  }

  assertion positive_balance check (not exists (select 1 from accounts where balance < 0))
}
```

Then `diff schema main` / `apply schema main` will include assertion create/drop DDL.
