description: Review of SELECT statement plan builder
files:
  packages/quereus/src/planner/building/select.ts
  packages/quereus/src/planner/building/select-context.ts
  packages/quereus/src/planner/building/select-projections.ts
  packages/quereus/src/planner/building/select-modifiers.ts
  packages/quereus/src/planner/building/select-aggregates.ts
  packages/quereus/src/planner/building/select-window.ts
  packages/quereus/src/planner/building/select-compound.ts
----
## Findings

### smell: DRY violation — repeated scope registration in buildFrom
file: packages/quereus/src/planner/building/select.ts:271-555
The `buildFrom` function repeats a scope-registration pattern (RegisteredScope + column iteration + AliasedScope) five times for different FROM clause types. Should be extracted into a shared helper.
Ticket: tickets/plan/select-buildFrom-dry-scope-registration.md

### smell: Redundant buildExpression calls in window projection building
file: packages/quereus/src/planner/building/select-window.ts:170-217
`buildExpression` is called up to 3 times per column in `buildWindowProjections` and `findWindowFunctionIndex`. Expressions should be built once and reused.
Ticket: tickets/plan/select-window-redundant-buildExpression.md

## Trivial Fixes Applied
- select.ts:43-53 — Updated outdated JSDoc that claimed "only supports simple SELECT ... FROM one_table"
- select.ts:159 — Fixed extra tab indentation on window function comment
- select.ts:278 — Fixed extra tab indentation on CTE reference comment
- select-projections.ts:10 — Removed unused `_AggregateFunctionCallNode` import
- select-aggregates.ts:15 — Changed `import { Scope }` to `import type { Scope }` (value import used only as type)
- select-aggregates.ts:40 — Fixed extra tab indentation on `hasGroupBy` assignment
- select-aggregates.ts:198-199 — Fixed inconsistent indentation on HAVING source column comments
- select-window.ts:5-8 — Removed 3 unused underscore-prefixed imports (`_SequencingNode`, `_RegisteredScope`, `_ColumnReferenceNode`)
- select-window.ts:260 — Removed extra trailing blank lines

## No Issues Found
- select-context.ts — clean (small, focused, correct CTE scope management)
- select-modifiers.ts — clean (well-structured ORDER BY/DISTINCT/LIMIT handling with proper identity projection optimization)
- select-compound.ts — clean (correct compound SELECT handling with proper DIFF expansion)

## Notes
- The `'expression' in child` heuristic for detecting scalar vs relational children in `isAggregateExpression`/`isWindowExpression` is an established codebase convention, used consistently across 10+ node types.
- The `cteReferenceCache` field on `PlanningContext` is intentionally mutable (not `readonly`) to support shared cache state across CTE reference resolution — a deliberate design choice.
- Build: passes. Tests: 472 passing, 1 failing (pre-existing `keys-propagation.spec.ts` unrelated to this review). Lint: no issues in reviewed files.
