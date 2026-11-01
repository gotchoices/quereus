description: Let a storage module say how many requests its backend can usefully serve at once, so the planner prices batched lookups and parallel branches at that number instead of at a fixed engine-wide budget, and the runtime never puts more requests in flight than the backend can take.
prereq: module-cost-profile-and-presets
architecture: docs/optimizer-parallel.md
files: packages/quereus/src/vtab/cost-profile.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts, packages/quereus/src/planner/rules/join/rule-fanout-batched-outer.ts, packages/quereus/src/planner/rules/parallel/rule-async-gather-union-all.ts, packages/quereus/src/planner/nodes/fanout-lookup-join-node.ts, packages/quereus/src/runtime/emit/fanout-lookup-join.ts, packages/quereus/src/planner/optimizer-tuning.ts
tradeoffs: Every in-tree backend is either in-process (where concurrency is a non-question) or already describes its reentrancy through `concurrencyMode`, so until a network module exists the field would have no honest declarer and the plumbing would be exercised only by a synthetic fixture.
----

# A module-declared concurrent-request budget

Parked from the `module-cost-profile-and-presets` plan pass, which considered a `concurrentRequests` field for the cost profile and left it out for two reasons:

1. **It overlaps an existing capability.** `VirtualTableModule.concurrencyMode` (`'serial'` | `'reentrant-reads'` | `'fully-reentrant'`) already answers "may the runtime issue concurrent calls to this module at all", and every parallel rule gates on the `concurrencySafe` physical property derived from it. What is missing is only the *number*: a backend with a connection pool of 4 should be priced and driven at 4, not at `tuning.parallel.outerBatchConcurrency` (16).
2. **A number the planner prices at but the runtime ignores is worse than none.** The batched index-nested-loop price (`batchedIndexNestedLoopJoinCost`, in-flight = `min(outerBatchConcurrency, maxOuterReadAhead)`) and the fan-out / gather concurrency caps (`tuning.parallel.concurrency`) must move together with the semaphore the `FanOutLookupJoin` driver and `AsyncGather` actually run.

## Shape when it is built

- `ModuleCostProfile.concurrentRequests?: number` (count, default unbounded; presets: `localDisk` and `browserIdb` leave it unset, `network` 8, `distributed` 16 — categories, to be revisited).
- A physical property `concurrentRequests` lifted at `TableReferenceNode` and propagated as the **min** of children (the tightest backend in a subtree bounds it), the opposite merge from latency's max.
- Planner: `inFlight = min(tuning cap, subtree.concurrentRequests)` at the batched index-nested-loop price and at the fan-out / gather caps.
- Runtime: `FanOutLookupJoinNode` carries the resolved in-flight cap so the emitter's semaphore (`deriveReadAhead` in `runtime/emit/fanout-lookup-join.ts`) is sized by the same number the plan was priced at — the coupling comment there already names this pairing.

## What would make it worth doing now

A network-backed module in the tree, or a reporter whose backend throttles concurrent requests (HTTP/2 stream limits, a rate-limited API) and sees the batched driver trip it.
