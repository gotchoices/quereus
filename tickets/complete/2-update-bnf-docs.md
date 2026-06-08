description: Updated EBNF grammar and prose in docs/sql.md to match parser implementation
prereq: docs/sql.md, packages/quereus/src/parser/parser.ts
files: docs/sql.md
----

## What Was Built

Updated the EBNF grammar (section 12) and related prose in `docs/sql.md` to accurately reflect the current parser implementation.

### EBNF Changes
- **INSERT**: Added `OR conflict_resolution`, `upsert_clause`, `with_schema_clause`
- **UPDATE/DELETE**: Added `with_schema_clause`
- **SELECT**: Added `with_schema_clause` to `simple_select`
- **context_clause**: Fixed to use no-parens DML assignment form; added separate `context_def_clause` for CREATE TABLE definitions
- **CREATE TABLE**: Added `context_def_clause`
- **ALTER TABLE**: Added `add_constraint_stmt`
- **ANALYZE**: Added `analyze_stmt` production
- **DECLARE SCHEMA**: Full syntax with brace-delimited body, SEED items
- **DIFF/APPLY/EXPLAIN SCHEMA**: Added `schema_name` arguments and optional clauses
- **binary_operator**: Added `"xor"`
- **conflict_clause**: Refactored to reference shared `conflict_resolution` production
- **join_operator**: Added `"lateral"` keyword support

### Prose Changes
- **Section 3.5 ORDER BY**: Added NULLS FIRST/LAST syntax and example
- **Section 11.2.3 comparison table**: Fixed Foreign Keys row to "Supported (via `pragma foreign_keys = on`)"

### Review Fix
- **join_operator**: Removed `"natural"` keyword from EBNF — the lexer defines `NATURAL` but the parser never checks for it in `joinClause()` or `isJoinToken()`, so documenting it would be inaccurate.

## Testing
- Build passes
- All 121 tests pass
- Cross-referenced every EBNF production against parser.ts — INSERT, UPDATE, DELETE, SELECT, ALTER TABLE, ANALYZE, DECLARE/DIFF/APPLY/EXPLAIN SCHEMA, join_operator, binary_operator, conflict_clause/resolution, context_clause/context_def_clause all verified accurate
