description: The optimizer was deliberately written to walk query plans with a loop so very deep plans don't crash, but several core plan properties still compute themselves with unbounded recursion, so a deep-enough plan crashes with a stack overflow the moment a rule reads one of them.
files: packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/framework/characteristics.ts
difficulty: hard
----

## Problem

The pass framework's tree traversal is intentionally *iterative* (an explicit worklist, plus a depth budget) specifically to avoid stack overflow on deep plans. That guarantee is undermined because several per-node properties are computed by *unbounded recursion* over the same trees:

- `get physical()` (`nodes/plan-node.ts` around :776)
- `getTotalCost()` (`nodes/plan-node.ts:780`)
- `visit()` (`nodes/plan-node.ts:825`)
- `subtreeHasSideEffects` (`framework/characteristics.ts:38`)

A plan deep enough to *need* the depth budget will still overflow the native call stack the first time any rule touches `.physical` (or the other three). The iterative traversal protects the framework's own walk but not these property accessors, so the protection is illusory for real workloads that hit the depth budget.

## Expected behavior

Computing `physical`, total cost, a visit, or the subtree-side-effect flag on an arbitrarily deep plan does not overflow the stack — these traversals are bounded the same way the pass framework's traversal is.

## Investigation / direction

- Reproduce: construct (in a test) a plan deep enough to approach the depth budget and assert that reading `.physical` / `getTotalCost()` / `visit()` / `subtreeHasSideEffects` currently throws / overflows. This both proves the defect and becomes the regression test.
- Convert each of these to iterative (worklist / explicit stack) computation, or memoize + compute bottom-up during the existing iterative traversal so the recursion depth is bounded. Note the cost-model ticket (`planner-cost-model-double-count`) already calls for memoizing `getTotalCost()`; coordinate so total-cost is fixed once (memoized *and* non-recursive), not twice.
- Ensure results are identical to the recursive versions for shallow plans (property-based / equivalence tests against the old implementation).

## Relationship

`planner-cost-model-double-count` also touches `getTotalCost()` memoization; sequence or cross-reference so both land coherently.

## Use case

A pathologically deep generated plan (e.g. a long chain of nested subqueries/filters) can be optimized and introspected without a `RangeError: Maximum call stack size exceeded`.
