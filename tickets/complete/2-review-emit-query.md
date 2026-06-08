description: Review of runtime emitters for query operations
files:
  packages/quereus/src/runtime/emit/scan.ts
  packages/quereus/src/runtime/emit/filter.ts
  packages/quereus/src/runtime/emit/project.ts
  packages/quereus/src/runtime/emit/alias.ts
  packages/quereus/src/runtime/emit/sort.ts
  packages/quereus/src/runtime/emit/limit-offset.ts
  packages/quereus/src/runtime/emit/distinct.ts
  packages/quereus/src/runtime/emit/retrieve.ts
  packages/quereus/src/runtime/emit/values.ts
  packages/quereus/src/runtime/emit/column-reference.ts
  packages/quereus/src/runtime/emit/literal.ts
  packages/quereus/src/runtime/emit/empty-result.ts
  packages/quereus/src/runtime/emit/join.ts
  packages/quereus/src/runtime/emit/bloom-join.ts
  packages/quereus/src/runtime/emit/merge-join.ts
  packages/quereus/src/runtime/emit/aggregate.ts
  packages/quereus/src/runtime/emit/hash-aggregate.ts
  packages/quereus/src/runtime/emit/window.ts
  packages/quereus/src/runtime/emit/window-function.ts
  packages/quereus/src/runtime/emit/subquery.ts
  packages/quereus/src/runtime/emit/cte.ts
  packages/quereus/src/runtime/emit/cte-reference.ts
  packages/quereus/src/runtime/emit/recursive-cte.ts
  packages/quereus/src/runtime/emit/internal-recursive-cte-ref.ts
  packages/quereus/src/runtime/emit/set-operation.ts
  packages/quereus/src/runtime/emit/cache.ts
  packages/quereus/src/runtime/emit/table-valued-function.ts
  packages/quereus/src/runtime/emit/sequencing.ts
  packages/quereus/src/runtime/emit/sink.ts
  packages/quereus/src/runtime/emit/remote-query.ts
  packages/quereus/src/runtime/emit/array-index.ts
----
## Findings

### defect: Recursive CTE false positive error on natural termination
file: packages/quereus/src/runtime/emit/recursive-cte.ts:83
The post-loop safety check `if (iterationCount >= maxIterations)` triggers incorrectly when maxIterations=0 (unlimited) or when recursion naturally completes at exactly the iteration limit.
Ticket: fixed in review — changed to `if (maxIterations > 0 && iterationCount >= maxIterations && deltaRows.length > 0)`

### defect: Remote query emitter missing vtable disconnect
file: packages/quereus/src/runtime/emit/remote-query.ts:14-39
Calls `vtabModule.connect()` but never calls `disconnectVTable()`. If the consumer breaks early, the vtable connection leaks. Compare with scan.ts which properly disconnects in a finally block.
Ticket: tickets/fix/remote-query-vtable-disconnect.md

### smell: Window function standalone emitter stale counter and incorrect ranking
file: packages/quereus/src/runtime/emit/window-function.ts:13,28
Mutable `rowCounter` persists across re-executions of prepared statements. Also, rank/dense_rank are just counters (no tie handling). Likely vestigial since window.ts handles these correctly.
Ticket: tickets/fix/window-function-emitter-stale-counter.md

### smell: Window ranking functions O(n^2) with unnecessary async re-evaluation
file: packages/quereus/src/runtime/emit/window.ts:318-430
Ranking functions use `areRowsEqualInOrderBy` (async callback re-evaluation) instead of the pre-evaluated `orderByValues` already available from `sortRows`. The `arePeerRows` function demonstrates the efficient approach.
Ticket: tickets/plan/window-ranking-quadratic-perf.md (pre-existing)

### smell: Aggregate emitters use direct ctx.context.set/delete
file: packages/quereus/src/runtime/emit/aggregate.ts:236,279 and hash-aggregate.ts:175,210
Both use `ctx.context.set()` / `ctx.context.delete()` directly, violating the documented guideline to use `createRowSlot`. The complex multi-descriptor lifecycle across scan/combined/group phases makes refactoring non-trivial.
Ticket: tickets/plan/deduplicate-aggregate-node-classes.md (related — emitter dedup would naturally follow node dedup)

## Trivial Fixes Applied

- recursive-cte.ts:83 — Fixed termination guard to `if (maxIterations > 0 && iterationCount >= maxIterations && deltaRows.length > 0)`. Also moved existing fix ticket to complete.

## No Issues Found

- scan.ts — clean (proper try/finally, rowSlot cleanup, vtable disconnect)
- filter.ts — clean (proper createRowSlot, isTruthy for SQL truthiness)
- project.ts — clean (dual-slot pattern with correct creation order for shadowing)
- alias.ts — clean (pass-through, no runtime overhead)
- sort.ts — clean (withAsyncRowContext for key evaluation, stable sort, pre-resolved comparators)
- limit-offset.ts — clean (proper early termination, handles negative/NaN)
- distinct.ts — clean (BTree with collation-aware comparator, proper slot cleanup)
- retrieve.ts — clean (unreachable-code guard)
- values.ts — clean (column count validation, array/asyncIterable dual path)
- column-reference.ts — clean (uses resolveAttribute)
- literal.ts — clean
- empty-result.ts — clean
- join.ts — clean (proper dual-slot cleanup, null padding for LEFT JOIN, semi/anti handling)
- bloom-join.ts — clean (null key skipping, proper cleanup, LEFT/semi/anti support)
- merge-join.ts — clean (correct merge algorithm, null key handling, proper slot cleanup)
- subquery.ts — clean (three-valued NULL logic for IN, early termination for EXISTS)
- cte.ts — clean (materialization hint support)
- cte-reference.ts — clean (proper slot cleanup, createValidatedInstruction)
- internal-recursive-cte-ref.ts — clean (proper slot cleanup)
- set-operation.ts — clean (BTree for all set ops, correct INTERSECT/EXCEPT semantics)
- cache.ts — clean (shared cache utility, buffering for large thresholds)
- table-valued-function.ts — clean (proper slot cleanup in nested try, variable-arg validation)
- sequencing.ts — clean
- sink.ts — clean (consumes all rows for side effects)
- array-index.ts — clean (newest-first search matching resolveAttribute)
