---
description: Completed review of integration boundaries between subsystems
prereq: none

---

# Integration Boundaries Review - Complete

## Summary

Comprehensive adversarial review of all six integration boundaries in the Quereus SQL query processor: Parser→Planner, Planner→Optimizer, Optimizer→Runtime, Runtime→VTab, Schema→All Layers, and Core API→Internal. Added 48 integration boundary tests and identified code quality issues including one bug.

## Tests Added

`packages/quereus/test/integration-boundaries.spec.ts` — 48 tests across 8 describe blocks:

- **Parser → Planner** (9 tests): SELECT/INSERT/UPDATE/DELETE/CREATE TABLE planning, subqueries, error propagation from parser, invalid SQL handling, complex expressions
- **Planner → Optimizer** (4 tests): Plan generation with WHERE clauses, JOIN optimization, multi-table queries, aggregate planning
- **Optimizer → Runtime** (6 tests): Full pipeline execution for SELECT/INSERT/UPDATE/DELETE, JOIN execution, aggregate computation
- **Runtime → VTab** (7 tests): Table creation, CRUD operations, constraint propagation, multi-cursor isolation, transaction rollback, table-not-found errors
- **Schema → All Layers** (6 tests): Table metadata consistency, column types/nullability, views queryable after creation, cross-schema references, dropped tables inaccessible, function registration
- **Core API → Internal** (10 tests): Database open/close lifecycle, Statement prepare/step/finalize, parameter binding (positional/named), exec() convenience, type round-tripping (integers, floats, strings, nulls, booleans)
- **Error Propagation Across Boundaries** (3 tests): Parse errors have correct type, runtime constraint violations (PK), type mismatches in expressions
- **Resource Management** (3 tests): Statement cleanup on database close, multiple statement lifecycle, database reuse after close/reopen

## Code Quality Findings

### Bug Found

**schema() TVF does not include views** — `src/func/builtins/schema.ts` line 50 iterates `getAllTables()` which only returns tables. Views live in a separate `Schema.views` map. The `getAllViews()` method exists but is never called. Filed as `tasks/fix/schema-tvf-missing-views.md`.

### SPP Violations

- `buildSelectStmt()` in `src/planner/building/select.ts` is 610 lines handling 9+ phases (CTE, FROM, WHERE, projection, aggregates, window functions, DISTINCT, ORDER BY, LIMIT)

### DRY Violations

- Mutation context processing (~20 identical lines) duplicated across `insert.ts`, `update.ts`, `delete.ts`
- OLD/NEW attribute creation duplicated across all three DML builders
- Context descriptor building duplicated across all three DML builders
- Schema path resolution duplicated across SELECT and all DML builders

### Error Handling Inconsistency

- `database.ts` `getPlan()` wraps parser errors but not planning errors
- `statement.ts` `compile()` wraps both parser and planning errors
- Missing AST location info in some planning error throws (e.g. `with.ts` CTE name conflicts)

### Type Safety

- Unsafe `as AST.SelectStmt` etc. casts in `buildBlock()` dispatcher
- `any` type used for column parameters in `delete.ts`
- `undefined as any` pattern for optional row descriptors in DML builders
- Missing exhaustive `never` check in `buildBlock()` switch

### Architecture

- `PlanningContext` has 11 properties and is passed everywhere — god object pattern
- Scope creation logic scattered across all statement builders with no centralized factory

## Validation

- All 48 new integration boundary tests pass
- Full test suite passes (yarn test clean)

## Follow-up Tasks Created

- `tasks/fix/schema-tvf-missing-views.md` — Bug: schema() TVF omits views from output

