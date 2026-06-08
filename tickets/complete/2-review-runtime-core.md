description: Review of runtime core (scheduler, emission context, FK actions, cache, async utilities)
files:
  packages/quereus/src/runtime/async-util.ts
  packages/quereus/src/runtime/context-helpers.ts
  packages/quereus/src/runtime/deferred-constraint-queue.ts
  packages/quereus/src/runtime/descriptor-helpers.ts
  packages/quereus/src/runtime/emission-context.ts
  packages/quereus/src/runtime/emitters.ts
  packages/quereus/src/runtime/foreign-key-actions.ts
  packages/quereus/src/runtime/register.ts
  packages/quereus/src/runtime/scheduler.ts
  packages/quereus/src/runtime/types.ts
  packages/quereus/src/runtime/utils.ts
  packages/quereus/src/runtime/cache/shared-cache.ts
----
## Findings

### defect: Cross-platform — process.hrtime.bigint() in scheduler metrics
file: packages/quereus/src/runtime/scheduler.ts:391
`process.hrtime.bigint()` is used in 8 places for metrics timing. This Node.js-specific API will crash in browsers and React Native when `enableMetrics` is true.
Ticket: tickets/fix/scheduler-hrtime-cross-platform.md

### smell: Resource leak in `buffered` async generator
file: packages/quereus/src/runtime/async-util.ts:123
The `buffered` generator acquires a source iterator via `getAsyncIterator(src)` but had no try/finally to call `srcIterator.return()` when the consumer breaks early. This could leak underlying resources (open cursors, connections).
Ticket: fixed in review

### smell: Resource leak in `merge` async generator (unused)
file: packages/quereus/src/runtime/async-util.ts:220
When the consumer breaks out of the merged stream, pending `.next()` promises from other iterators remain outstanding, and `.return()` is never called on them. Currently unused in the codebase, so no practical impact.
Ticket: none (unused code, low priority)

### smell: Resource leak in `tee` function (unused)
file: packages/quereus/src/runtime/async-util.ts:43
The source iterator acquired inside `tee` is never cleaned up if either consumer abandons iteration early. Currently unused in the codebase.
Ticket: none (unused code, low priority)

### note: Dead PlanNodeType enum values without emitters
file: packages/quereus/src/planner/nodes/plan-node-type.ts
Several enum values (DropIndex, Materialize, IsNull, IsNotNull, Like, TableFunctionReference) have no builders or emitters. These are either logical-only nodes replaced by the optimizer, or planned future features. No action needed.
Ticket: none

## Trivial Fixes Applied
- async-util.ts:145 — Added try/finally around `buffered` generator's main loop to call `srcIterator.return()` on early consumer termination

## No Issues Found
- context-helpers.ts — clean (RowContextMap, createRowSlot, resolveAttribute, withRowContext/withAsyncRowContext all well-structured with proper cleanup patterns)
- deferred-constraint-queue.ts — clean (layer-based savepoint support, proper row cloning, correct evaluation lifecycle)
- descriptor-helpers.ts — clean (simple, correct descriptor composition)
- emission-context.ts — clean (dependency tracking, schema snapshot validation, proper key construction)
- emitters.ts — clean (registry, tracing instrumentation handles sync/async/iterable correctly)
- foreign-key-actions.ts — clean (cycle detection via visited set, null-aware FK matching, parameterized SQL)
- register.ts — clean (comprehensive emitter registration, all active node types covered)
- types.ts — clean (RuntimeContext, Instruction, tracer interfaces well-defined)
- utils.ts — clean (Hermes workaround for async iterables, VTable connection management)
- cache/shared-cache.ts — clean (streaming-first cache pattern, threshold-based abandonment)

## Test Coverage
- Direct unit test: `test/runtime-scheduler-modes.spec.ts` covers scheduler optimized/tracing/metrics mode equivalence
- 472 passing tests (1 pre-existing failure in unrelated optimizer/keys-propagation test)
- Runtime core is exercised extensively through 68 sqllogic test files and 29+ integration test files
- Lint: clean on all 12 reviewed files
