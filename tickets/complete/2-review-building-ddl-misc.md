description: Review of planner building for DDL, expressions, and miscellaneous statements
files:
  packages/quereus/src/planner/building/expression.ts
  packages/quereus/src/planner/building/function-call.ts
  packages/quereus/src/planner/building/with.ts
  packages/quereus/src/planner/building/schema-resolution.ts
  packages/quereus/src/planner/building/table.ts
  packages/quereus/src/planner/building/table-function.ts
  packages/quereus/src/planner/building/block.ts
  packages/quereus/src/planner/building/pragma.ts
  packages/quereus/src/planner/building/transaction.ts
  packages/quereus/src/planner/building/analyze.ts
  packages/quereus/src/planner/building/alter-table.ts
  packages/quereus/src/planner/building/create-view.ts
  packages/quereus/src/planner/building/create-assertion.ts
  packages/quereus/src/planner/building/drop-view.ts
  packages/quereus/src/planner/building/drop-table.ts
  packages/quereus/src/planner/building/drop-assertion.ts
  packages/quereus/src/planner/building/declare-schema.ts
  packages/quereus/src/planner/building/ddl.ts
----
## Findings

### defect: DROP INDEX/TRIGGER silently swallowed in block planner
file: packages/quereus/src/planner/building/block.ts:39-47
The `drop` case handles 'table', 'view', 'assertion' but falls through with `break` for 'index' and 'trigger'. The `undefined` is silently filtered at line 89. Affects declarative schema migrations which generate `DROP INDEX IF EXISTS` statements.
Ticket: tickets/fix/drop-index-trigger-silent-swallow.md

### smell: Repetitive subquery context creation in expression builder
file: packages/quereus/src/planner/building/expression.ts:161-163, 213-216, 240-242
The pattern `{ ...ctx, cteReferenceCache: ctx.cteReferenceCache || new Map() }` is repeated 3 times for scalar subquery, IN subquery, and EXISTS subquery. Could be extracted to a helper but is borderline — only 1 line repeated 3 times.
Ticket: n/a (minor)

### smell: Simplistic aggregate matching in HAVING context
file: packages/quereus/src/planner/building/function-call.ts:27-43
Aggregate matching in HAVING context only compares column names and literal values, not complex expressions. For compound expressions like `SUM(a + b)`, the matching silently falls through and creates a duplicate aggregate. Code has an acknowledging comment.
Ticket: n/a (known limitation, documented in code)

### note: TODO comments for aggregate orderBy and filter
file: packages/quereus/src/planner/building/function-call.ts:101-102
`orderBy` and `filter` parameters for aggregate functions are passed as `undefined` with TODO comments. These are SQL features like `SUM(x ORDER BY y)` and `SUM(x) FILTER (WHERE ...)`.
Ticket: n/a (tracked feature gap)

### note: Recursive CTE doesn't validate column alignment between base/recursive case
file: packages/quereus/src/planner/building/with.ts:130-184
The recursive CTE builder doesn't validate that the base case and recursive case produce the same number/types of columns. This could lead to confusing runtime errors. May be handled elsewhere in the pipeline.
Ticket: n/a (minor, may be caught at runtime)

## Trivial Fixes Applied
- block.ts:72-79 — Removed unnecessary `as unknown as` double casts for declarative schema types (DeclareSchemaStmt, DiffSchemaStmt, ApplySchemaStmt, ExplainSchemaStmt). These types are properly in the AST.Statement discriminated union, so TypeScript narrows them correctly via the switch case.

## No Issues Found
- expression.ts — Expression builder is well-structured with thorough type coercion, good error messages with source locations, correct operator handling
- schema-resolution.ts — Excellent error messages with suggestions, proper caching, consistent dependency tracking
- table.ts — Clean, focused, proper boundary between vtab and planner
- table-function.ts — Clean, proper TVF validation
- pragma.ts — Correct SinkNode wrapping for write operations
- transaction.ts — Clean, simple factory functions
- analyze.ts — Clean pass-through
- ddl.ts — Clean pass-through factories for CREATE TABLE/INDEX
- create-view.ts — Correct SQL reconstruction via AST stringifier
- create-assertion.ts — Clean
- drop-view.ts — Clean
- drop-table.ts — Clean
- drop-assertion.ts — Clean, uses `quereusError()` (returns `never`) for validation
- declare-schema.ts — Clean pass-through factories
- alter-table.ts — Correct routing for all action types with proper exhaustive default
