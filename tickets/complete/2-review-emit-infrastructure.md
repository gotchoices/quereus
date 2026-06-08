description: Review of emit infrastructure (AST stringification)
files:
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/src/emit/index.ts
----
## Findings

### defect: Operator precedence table mismatches parser
file: packages/quereus/src/emit/ast-stringify.ts:270
The `needsParens` precedence table groups `=`/`!=` at the same level as `<`/`>`/`LIKE`, but the parser separates them. Missing `||` (concatenation) and `XOR`. This causes round-trip semantic changes for expressions like `(a = b) < c` or `(a + b) || c`.
Ticket: tickets/fix/emit-operator-precedence.md

### defect: Missing statement types in astToString
file: packages/quereus/src/emit/ast-stringify.ts:114
`alterTable`, `analyze`, and `createAssertion` statement types fall through to `[${node.type}]` default. Also, `mutatingSubquerySource` not handled in `fromClauseToString`.
Ticket: tickets/fix/emit-missing-statement-types.md

### smell: No dedicated unit tests for emit infrastructure
file: packages/quereus/src/emit/ast-stringify.ts
Emit functions are only tested indirectly through sqllogic integration tests. No round-trip or precedence-specific tests exist.
Ticket: tickets/plan/emit-roundtrip-tests.md

## Trivial Fixes Applied
- ast-stringify.ts:55-57 — Added `exists`, `in`, `between` expression types to `astToString` routing (were falling through to default `[type]` instead of delegating to `expressionToString`)
- ast-stringify.ts:40 — Removed dead `quoteIdentifierIfNeeded` alias; replaced all internal uses with `quoteIdentifier`
- ast-stringify.ts:914-921 — Replaced duplicated column definition logic in `createTableToString` with call to existing `columnDefToString`

## No Issues Found
- packages/quereus/src/emit/index.ts — clean (barrel re-exports, well-organized)
- Identifier quoting logic — correct (keyword check + regex validation + double-quote escaping)
- String literal escaping — correct (single-quote doubling)
- Window function/frame stringification — complete and correct
- FROM clause handling (table, subquery, function, join) — correct
- DDL stringification (CREATE TABLE, INDEX, VIEW, DROP) — correct
- DML stringification (INSERT, UPDATE, DELETE) — correct
- UPSERT clause handling — correct
- Foreign key actions — complete
- Conflict resolution handling — correct (ABORT default omitted)
- WITH/CTE clause — correct
