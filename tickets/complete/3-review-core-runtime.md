---
description: Runtime subsystem review (scheduler, emitters, context, deferred constraints)
prereq: none

---

# Runtime Subsystem Review (implementation output)

## What changed

- **Scheduler observability modes**: Added `Statement.iterateRowsWithTrace()` (per-execution tracer) so tracing can be exercised without global tracer state. Added a regression test asserting **optimized / tracing / metrics** scheduler modes are behaviorally equivalent for results and side effects.
- **Tracing utilities**: Fixed `scheduler_program()` to emit correct dependency indices (and fixed its error-row shape). This unblocked better `execution_trace()` diagnostics.
- **Window frames**:
  - Fixed a context-lifecycle bug in `emit/window.ts` (async work was previously done under `withRowContext()` instead of `withAsyncRowContext()`).
  - Implemented literal offset handling for `ROWS BETWEEN n PRECEDING/FOLLOWING ...` (was hard-coded to 1).
  - Added a sqllogic regression for non-1 offsets.
- **Join surface area**: `RIGHT` and `FULL` joins were silently incomplete in `emit/join.ts`; they now raise a clear `UNSUPPORTED` error. Added a sqllogic error assertion.
- **Deferred constraints**:
  - DRY’d `composeCombinedDescriptor()` into `src/runtime/descriptor-helpers.ts` and reused it from both immediate and deferred paths.
  - Hardened connection selection: if a deferred row has `connectionId` and it can’t be found, we now fail loudly instead of guessing; also error on ambiguous table-name matches.
- **Context leak diagnostics**: `context-helpers.ts` now reports context add/remove to the `ContextTracker` when `DEBUG=quereus:runtime:context` is enabled; scheduler now also warns if `RuntimeContext.context` / `tableContexts` are non-empty after execution.
- **Window partition key collision** (follow-up): `groupByPartitions` in `emit/window.ts` was building partition keys by joining stringified values with `|` — e.g. partition `(1, NULL)` produced the same key as `('1|NULL',)`. Replaced with `JSON.stringify(partitionValues)` which is unambiguous.
- **Type hygiene in `emit/window.ts`**: Replaced `any` type annotations with proper types — `functionSchemas: WindowFunctionSchema[]`, `orderBy: AST.OrderByClause[]`, `schema: WindowFunctionSchema`, `accumulator: SqlValue`.
- **Documentation dedup**: `docs/runtime.md` had three pairs of duplicated sections (Bags vs Sets, Scheduler Execution Model, Context Lifecycle Best Practices). Removed the stale duplicates, keeping the more complete versions.

## Tests added/updated

- `packages/quereus/test/runtime-scheduler-modes.spec.ts`
- `packages/quereus/test/logic/07.5-window.sqllogic` (non-1 ROWS frame offsets)
- `packages/quereus/test/logic/11-joins.sqllogic` (RIGHT JOIN unsupported)
- `packages/quereus/test/logic/07-aggregates.sqllogic` (GROUP BY NULL group key)

## Known gaps / follow-ups to consider

- **Window frames**: `RANGE` semantics and `EXCLUDE` clauses are not implemented in the runtime emitter; only `ROWS` with literal offsets is supported today.
- **RIGHT/FULL joins**: Explicitly unsupported at runtime (now validated); implementing them will require tracking unmatched right rows (or an alternate join strategy).

