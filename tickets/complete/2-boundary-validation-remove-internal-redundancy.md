---
description: Removed redundant internal validation for runtime speedups
prereq: boundary-validation-strengthen (completed)
---

## Summary

Removed redundant internal checks that were duplicating work already guaranteed by boundary validation. Three areas in the runtime emitters were cleaned up.

## Changes

1. **Extracted `cloneInitialValue()` helper** (`runtime/emit/aggregate.ts`) — DRY extraction of 3 identical clone blocks into a module-scoped helper.

2. **Removed redundant bounds check in aggregate hot loop** (`runtime/emit/aggregate.ts`) — Removed `|| []` fallback and redundant inner loop guard. The `aggregateArgFunctions` array is constructed in lockstep with `plan.aggregates`, so indexing is always safe.

3. **Simplified parameter emitter** (`runtime/emit/parameter.ts`) — Removed dead `Array.isArray(ctx.params)` branches. Tightened `RuntimeContext.params` type from `SqlParameters` to `Record<number | string, SqlValue>`. Added boundary normalization in `database._executeSingleStatement`.

4. **Kept filter predicate validation** (`runtime/emit/filter.ts`) — `asPredicateScalar()` retained; negligible cost, catches custom function bugs.

## Review Findings

- Code quality: Clean DRY improvement, type tightening is consistent with `Statement.boundArgs` type
- No dead code or unnecessary branches remain in changed files
- Boundary normalization in `database.ts:474-480` correctly mirrors `Statement.bindAll` logic
- Build passes, 279/279 tests pass (1 pre-existing FK test failure unrelated)

## Files Changed

- `packages/quereus/src/runtime/emit/aggregate.ts`
- `packages/quereus/src/runtime/emit/parameter.ts`
- `packages/quereus/src/runtime/types.ts`
- `packages/quereus/src/core/database.ts`
