----
description: A WITH-clause query referenced twice in the same statement is executed twice; the once-per-statement caching the planner sets up is silently defeated at code-generation time.
prereq: bug-cache-node-stale-across-statement-executions
files: packages/quereus/src/planner/nodes/cte-reference-node.ts, packages/quereus/src/planner/rules/cache/rule-cte-optimization.ts, packages/quereus/src/runtime/emitters.ts, packages/quereus/src/runtime/emit/cte.ts, packages/quereus/src/runtime/emit/cache.ts
----

# Non-recursive CTE referenced N times executes N times

`rule-cte-optimization.ts:24-79` wraps a CTE's source in a `CacheNode`, but
the cache is structurally defeated across references:

- `emitPlanNode` has no per-node memoization (`runtime/emitters.ts:111-122`).
- Each `CTEReferenceNode` re-emits the (shared) `CTENode` subtree
  (`cte-reference-node.ts:36`), producing **separate instruction subtrees**,
  each with its **own emit-closure cache state** (`emit/cache.ts:34`).
- `emitCTE`'s materialization hint only buffers within one pipeline; it does
  not share rows across references (`emit/cte.ts:14-33`).

So `with x as (<expensive>) select ... from x join x ...` runs `<expensive>`
twice. The planner-level intent (cache once, replay per reference) never
survives emission.

Expected: one execution per statement execution. Two candidate shapes:

- **Emission-level dedup** — memoize `emitPlanNode` on plan-node identity so a
  shared `CTENode` compiles to one instruction subtree feeding both consumers.
- **Runtime-shared materialization** — key the CTE's materialized rows in the
  runtime execution context (per-execution, addressing the staleness prereq)
  so all reference instructions read one buffer.

Test with a counting/instrumented vtab asserting single execution, plus
correctness under a CTE referenced on both sides of a join.
