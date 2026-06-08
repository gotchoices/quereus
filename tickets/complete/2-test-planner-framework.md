description: Tests for planner framework — pass manager, rule registry, characteristics, and physical-utils
files:
  - packages/quereus/test/planner/framework.spec.ts (81 tests)
  - packages/quereus/src/planner/framework/pass.ts
  - packages/quereus/src/planner/framework/registry.ts
  - packages/quereus/src/planner/framework/characteristics.ts
  - packages/quereus/src/planner/framework/physical-utils.ts
  - packages/quereus/src/planner/framework/trace.ts
----

## What was built

81 unit tests in `packages/quereus/test/planner/framework.spec.ts` covering the planner framework layer using lightweight mock PlanNodes (no SQL parsing needed, ~16ms execution).

### Coverage

- **PassManager (11 tests)**: pass ordering, convergence via visited-rules, disabledRules, max depth, node caching, visited-rule inheritance, disabled pass, executeUpTo, top-down/bottom-up traversal, cache clearing between passes.
- **RuleRegistry (3 tests)**: markApplied/hasApplied round-trip, per-node isolation, multi-rule tracking.
- **PlanNodeCharacteristics (20 tests)**: hasSideEffects, isReadOnly, isDeterministic, estimatesRows, isExpensive, isRelational, isScalar, isVoid, hasUniqueKeys/getUniqueKeys, hasOrderedOutput, isFunctional.
- **CapabilityDetectors (9 tests)**: canPushDownPredicate, isTableAccess, isSortable, isJoin, isCached, isColumnReference (+rejection), isWindowFunction (+rejection).
- **CapabilityRegistry (3 tests)**: register+hasCapability, getCapable filtering, unregister.
- **Physical-utils (20 tests)**: extractOrderingFromSortKeys, mergeOrderings, orderingsEqual, orderingsCompatible, projectUniqueKeys, projectOrdering, uniqueKeysImplyDistinct.
- **Trace hooks (5 tests)**: DebugTraceHook, PerformanceTraceHook, CompositeTraceHook dispatch, error propagation, setTraceHook/getCurrentTraceHook.

### Testing notes

- All 81 tests pass; full suite 1412 passing, 2 pending (pre-existing)
- Build clean
- Tests use mock PlanNodes — zero DB/parser dependency
- Run: `cd packages/quereus && node test-runner.mjs -- test/planner/framework.spec.ts`

### Review notes

- Test quality is solid: clean mocks, proper afterEach cleanup for global state, clear naming
- Core public API coverage is comprehensive
- Minor gaps in diagnostic utilities (getRegistryStats, getAllRules, reverseOrdering, setupDefaultTracing) — non-blocking for secondary/debug APIs
