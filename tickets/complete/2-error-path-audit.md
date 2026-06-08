description: Systematic audit and expanded test coverage for all error paths and StatusCode values
files:
  packages/quereus/src/common/errors.ts
  packages/quereus/src/common/types.ts
  packages/quereus/test/logic/90-error_paths.sqllogic
  packages/quereus/test/logic/90.1-parse-errors.sqllogic
  packages/quereus/test/logic/90.2-alter-table-errors.sqllogic
  packages/quereus/test/logic/90.3-expression-errors.sqllogic
  packages/quereus/test/logic/90.4-dml-errors.sqllogic
  packages/quereus/test/integration-boundaries.spec.ts
----
## What was built

Systematic audit of all `QuereusError` throw sites (700+ across 77 files) cross-referenced
against existing test coverage. Four new sqllogic test files were created covering previously
untested error paths:

- **90.1-parse-errors.sqllogic** (14 tests): Parser/syntax edge cases — unterminated parens,
  CTE syntax errors, unterminated strings, incomplete statements, empty column lists,
  unsupported DROP types, incomplete CASE, missing WHERE expressions.
- **90.2-alter-table-errors.sqllogic** (6 tests): RENAME COLUMN with bad source/target,
  DROP COLUMN on non-existent/PK columns, RENAME TABLE to existing name.
- **90.3-expression-errors.sqllogic** (7 error checks): Scalar/IN subquery multi-column errors,
  duplicate CTE names, aggregate in WHERE, window function missing ORDER BY,
  invalid RETURNING qualifiers (OLD in INSERT, NEW in DELETE).
- **90.4-dml-errors.sqllogic** (5 tests): VALUES column count mismatch, INSERT with
  non-existent column, ON CONFLICT bad target, mutating subquery without RETURNING.

## Key findings

- 12 of 31 StatusCode values are actively used; 18 are SQLite-compat placeholders never thrown.
- "Cannot drop the last column" is unreachable — key-based design means single-column tables
  always hit "Cannot drop PRIMARY KEY column" first.
- RANGE, MISUSE parameter errors are API-only (covered by integration-boundaries.spec.ts).

## Testing

- 1915 tests pass, 2 pending, 0 failures
- TypeScript build clean
- Lint: pre-existing issues only (no new warnings)
- New test files auto-discovered by logic.spec.ts runner via readdirSync

## Review notes

- Error class hierarchy (QuereusError → ConstraintError, MisuseError) is clean and focused.
- `quereusError()` helper correctly threads AST location info through.
- New test files follow existing 90-error_paths.sqllogic conventions (`-- error:` substring matching).
- Error patterns in 90.4 use shorter substrings (`not found`) vs baseline's more specific patterns
  (`Column not found: b`) — both work correctly as substring matchers but the shorter form is
  slightly less specific. Acceptable for the error paths being tested.
