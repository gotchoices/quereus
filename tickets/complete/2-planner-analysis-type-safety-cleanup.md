description: Reduced `any` usage and improved type safety in planner analysis/stats/scopes modules
files:
  packages/quereus/src/planner/analysis/predicate-normalizer.ts
  packages/quereus/src/planner/scopes/registered.ts
  packages/quereus/src/planner/scopes/global.ts
  packages/quereus/src/planner/stats/histogram.ts
  packages/quereus/src/planner/building/constraint-builder.ts
  packages/quereus/src/planner/building/foreign-key-builder.ts
  packages/quereus/src/planner/building/insert.ts
  docs/runtime.md
----

## What was done

1. **predicate-normalizer.ts** — Removed 7 `as any` casts by adding `import type { Scope }` and typing `scope` parameters in `rebuildAssociative` and `tryCollapseOrToIn`. Properties `.expression` and `.scope` are already on `ScalarPlanNode`/`PlanNode`.

2. **registered.ts** — Removed duplicate `subscribeFactory` method (identical to `registerSymbol`). Updated 6 call sites across constraint-builder.ts, foreign-key-builder.ts, and insert.ts.

3. **global.ts** — Extracted `getFunctionScalarType(func)` helper to eliminate duplicated 3-line ScalarType resolution in `resolveSymbol` and `findUnqualifiedName`.

4. **histogram.ts** — Changed `String(val)` to `typeof val + ':' + String(val)` so numeric `1` and string `"1"` are counted as distinct values in histogram buckets.

5. **docs/runtime.md** — Updated code example to use `registerSymbol` instead of `subscribeFactory`.

## Testing

- Build passes
- All tests pass (predicate-analysis.spec.ts, statistics.spec.ts, sqllogic tests for constraints/FK/inserts)
- Key test coverage: OR-to-IN collapse, histogram distinct counting, constraint building, FK checks
