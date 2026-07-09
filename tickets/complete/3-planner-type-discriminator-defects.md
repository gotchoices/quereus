description: Cleaned up two node-kind checks in the query optimizer and removed two unused, never-called detection features; verified no behavior change and hardened the aggregate-vs-scalar function discriminator.
files: packages/quereus/src/planner/framework/characteristics.ts, packages/quereus/src/schema/function.ts, packages/quereus/src/planner/nodes/function.ts, packages/quereus/src/planner/nodes/aggregate-function.ts, packages/quereus/src/planner/nodes/window-function.ts, packages/quereus/test/optimizer/characteristics.spec.ts, packages/quereus/test/planner/framework.spec.ts, docs/optimizer-conventions.md
----

## What was done (implement stage)

Four defects in `packages/quereus/src/planner/framework/characteristics.ts`:

1. **`isColumnBindingProvider`** — removed unreachable `typeof … === 'string'` disjunct;
   `getBindingRelationName` is a method → always `'function'`. Behavior identical.
2. **`isAggregateFunction`** — replaced loose property-shape duck-typing
   (`functionName`+`isDistinct`+`args`+`functionSchema` present) with the intentional
   discriminator: `isScalar(node) && 'functionSchema' in node && isAggregateFunctionSchema(functionSchema)`.
3. **`PredicateAnalysis`** class — deleted (dead; TODO stub returned unsafe `true`).
4. **`CapabilityRegistry`** class + its 12 `register(...)` calls — deleted (test-only, never queried).

Tests: dropped `CapabilityRegistry` describe blocks from two spec files; added three regression
tests locking in `isColumnBindingProvider` (function vs string member) and `isAggregateFunction`
(real aggregate node vs real scalar node vs old-shape look-alike) semantics.

## Review findings

### Checked — behavior preservation of `isAggregateFunction` (the core review question)
**Confirmed no drift.** Traced every real node type through old vs new guard:
- `AggregateFunctionCallNode` (`nodes/aggregate-function.ts`) carries `functionName`/`isDistinct`/`args`/`functionSchema`
  **and** an aggregate schema → matched by both old and new. ✓
- `ScalarFunctionCallNode` (`nodes/function.ts`) has `expression`/`functionSchema`/`operands` — **no**
  `functionName`/`isDistinct`/`args` field → rejected by old (missing `functionName`) and by new
  (scalar schema fails `isAggregateFunctionSchema`). ✓
- `WindowFunctionCallNode` (`nodes/window-function.ts`) has `functionName`/`isDistinct` but **no**
  `functionSchema`/`args` → rejected by both. ✓

New guard is strictly more precise, not merely equivalent: it keys off `stepFunction`+`finalizeFunction`
schema presence (the same build-time split used in `building/function-call.ts`) rather than incidental
property shape. All six callers (`building/function-call.ts:20`, `building/select-aggregates.ts:265,639`,
`building/select-projections.ts:21,110,192`) iterate over nodes that are already
`AggregateFunctionCallNode`, so none relied on the old looser match. Aggregate/GROUP BY logic suite green.

### Checked — dead-code removals fully severed
`grep` across `packages/` for `CapabilityRegistry` / `PredicateAnalysis`: **zero source references**
outside stale `dist/` build artifacts (regenerated on build). No barrel re-exports in `src/index.ts` or
framework index. ✓

### Checked — `isColumnBindingProvider` cleanup
Sole implementer `TableReferenceNode` (`nodes/reference.ts:254`) defines `getBindingRelationName()` as a
method; interface (`characteristics.ts:241`) declares it a method. String disjunct was unreachable.
Behavior identical. ✓

### Fixed inline (minor) — stale docs
`docs/optimizer-conventions.md` documented the now-deleted `CapabilityRegistry` as a live design pattern
("Capability Interface Registry" section) — removed the section. `docs/review.html` also mentions the
deleted classes but is the historical review report that *recommended* the deletions — left as-is
(rewriting a point-in-time review artifact would falsify history).

### Tripwire (not a ticket) — null-schema throw
`isAggregateFunctionSchema` does `'stepFunction' in schema`, which throws `TypeError` if `functionSchema`
is `null`/`undefined`. The `'functionSchema' in node` clause passes for a `null`-valued property, so a node
carrying `functionSchema: null` would throw rather than return `false`. **Dormant**: `functionSchema` is
constructor-required and typed non-null on every node class, so unreachable today. Parked as a `NOTE:`
comment at the call site (`characteristics.ts` `isAggregateFunction`) suggesting an object/non-null
pre-check if a node ever carries a null schema. Not demoted to a bug because no live path produces one.

### Test coverage assessment
Regression tests are a reasonable floor: they construct real `AggregateFunctionCallNode` +
`ScalarFunctionCallNode` (not mocks) and assert the discriminator. They don't sweep the full builtin
aggregate/scalar catalog, but the guard is schema-shape-based (one aggregate + one scalar exercises both
branches), so the parametrized sweep the implementer flagged as optional adds little. Not filed.

### Not found
No new correctness, resource-cleanup, type-safety, or error-handling defects. Defects #2/#3 were latent
(no live misfire), so there is no black-box before/after repro — the regression tests lock intended
semantics, as the implementer honestly flagged.

## Validation
- `yarn workspace @quereus/quereus run lint` (eslint + `tsc -p tsconfig.test.json`) → exit 0.
- `yarn workspace @quereus/quereus run test` → **6524 passing, 9 pending, 0 failing** (~2m).
- Doc-section removal and `NOTE:` comment are comment/prose-only (no code-path change); lint/test result
  above predates them but they cannot affect eslint/tsc/mocha outcomes.
