---
description: Completed review of core API (Database, Statement, Events, Transactions)
prereq: none

---

# Core API Review - Complete

## Summary

Comprehensive adversarial review of the Quereus core API covering Database, Statement, Events, and Transaction subsystems. Addressed code quality issues, type safety problems, a silent bug in schema dependency tracking, and added 44 new tests for previously uncovered API surface.

## Changes Made

### Bug Fix: Schema Dependency Tracking (Statement Plan Invalidation)

`Statement.compile()` attempted to extract `schemaDependencies` from the `BlockNode` result of `_buildPlan()` via `(planResult as any).schemaDependencies`. This was always `undefined` because `BlockNode` has no such property — the dependencies lived on the `PlanningContext`, which was created and discarded inside `_buildPlan()`. This meant prepared statement plan invalidation on schema changes was silently broken.

**Fix:** `_buildPlan()` now returns a `BuildPlanResult { plan, schemaDependencies }` struct. All callers destructure appropriately. Statement plan invalidation is now functional.

### Type Safety Improvements

- **Removed `(planResult as any).schemaDependencies` cast** — replaced with properly typed destructuring
- **Removed `catch (e: any)` in _iterateRowsRawInternal** — uses proper `instanceof` narrowing
- **Removed unsafe cast in `prepareDebug()`** — added `_debugOptions` property to Statement class instead of patching via type assertion
- **Removed dead `ParseError` import** from both `database.ts` and `statement.ts`

### Code Quality

- **Removed pointless try/catch blocks** in `Statement` constructor and `Database._parseSql()` that caught errors only to re-throw them identically
- **Removed commented-out dead code** in `Database` constructor (old module registration comments)
- **DRY: extracted `parseSchemaPath()` helper** — eliminates duplicate `split(',').map().filter()` logic in `_buildPlan` and `getSchemaPath`
- **Removed `console.error` in `BuildTimeDependencyTracker.notifyInvalidation`** — error swallowing during schema invalidation hides real bugs; now propagates naturally

### Files Modified

- `packages/quereus/src/core/database.ts` — `BuildPlanResult` type, `parseSchemaPath()` helper, updated `_buildPlan` return type, cleaned up imports and dead code
- `packages/quereus/src/core/statement.ts` — fixed schemaDependencies access, removed unsafe casts, added `_debugOptions` property, cleaned up error handling
- `packages/quereus/src/core/database-assertions.ts` — updated `_buildPlan` interface signature and call site to use `BuildPlanResult`
- `packages/quereus/src/planner/planning-context.ts` — removed error-swallowing `console.error` in `notifyInvalidation()`

### Tests Added

- `packages/quereus/test/core-api-transactions.spec.ts` — 21 tests covering:
  - `beginTransaction()`, `commit()`, `rollback()` TypeScript API
  - `getAutocommit()` state transitions
  - Transaction isolation (read-your-own-writes, rollback visibility)
  - Savepoints via SQL (create, release, rollback-to, nested)
  - Error recovery within explicit transactions

- `packages/quereus/test/core-api-features.spec.ts` — 23 tests covering:
  - `createScalarFunction()` (registration, deterministic flag, argument passing, error propagation)
  - `createAggregateFunction()` (GROUP BY usage, initialState, empty groups)
  - Statement metadata (`getColumnNames()`, `getColumnType()`, `getColumnName()`, `isQuery()`)
  - Schema management (`setSchemaPath()` / `getSchemaPath()`, `setOption()` / `getOption()`)
  - Statement batch operations (`nextStatement()`)
  - ParseError preservation (line/column info not lost)

## Validation

- All 450 tests pass (up from 406)
- TypeScript compilation clean
- No linter errors introduced

## Known Gaps / Follow-ups

- **`database-assertions.ts` type safety**: Multiple `as unknown as Database` casts indicate the `AssertionEvaluatorContext` interface doesn't fully match the methods it calls. Low risk since it's internal, but could be tightened.
- **Connection lifecycle during implicit transactions**: `unregisterConnection()` defers disconnect during implicit transactions but there's no guarantee the deferred disconnect fires if the transaction fails silently.
- **Global collation registry**: Collations are registered globally (not per-Database). Could cause issues in multi-tenant scenarios. Accepted for now.
- **Window function frames**: `RANGE` semantics and `EXCLUDE` clauses are not implemented (runtime only supports `ROWS` with literal offsets). Documented in runtime review.
