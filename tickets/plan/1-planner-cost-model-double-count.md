description: The query optimizer's cost estimates double-count nested work, so deeply nested queries get wildly inflated cost numbers that skew which plan the optimizer picks.
files: packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/nodes/join-node.ts, packages/quereus/src/planner/nodes/sort.ts, packages/quereus/src/planner/rules/join/rule-quickpick-enumeration.ts
difficulty: hard
----

## Problem

The planner assigns every plan node an `estimatedCost`. The documented contract (see `nodes/plan-node.ts:707,776`) is that `estimatedCost` is the node's *self* cost, *excluding* its children — and `getTotalCost()` is what walks the subtree adding children in.

The contract is violated in practice: roughly 20 node constructors (e.g. `nodes/filter.ts:29`, `nodes/join-node.ts:119`, `nodes/sort.ts:44`, and more) bake `source.getTotalCost()` directly into the value they store as `estimatedCost`. Then `getTotalCost()` adds the children's cost again. The result is that a leaf sitting under `d` operators is counted `2^d` times — cost grows exponentially with nesting depth rather than linearly.

This is consumed by real decisions: QuickPick join enumeration (`rules/join/rule-quickpick-enumeration.ts:109`) compares candidate join trees using these totals, so left-deep vs. bushy shapes are compared on systematically distorted numbers. The distortion is depth-dependent, so it does not cancel out — it favors whichever shape happens to nest shallower.

## Expected behavior

Cost is counted once per node. A subtree's total cost is the linear sum of the self-costs of its nodes (scaled by row estimates as intended), not an exponential function of depth. Join-order comparisons then reflect real relative cost.

## Direction (design decision — resolve before implementing)

Two coherent conventions exist; pick one and apply it uniformly:

- **Self-cost only**: constructors store only the node's own incremental cost; children are added exclusively by `getTotalCost()`. Requires auditing every constructor that currently folds in `source.getTotalCost()`.
- **Baked total**: `estimatedCost` *is* the subtree total; `getTotalCost()` becomes the identity. Requires removing the child-summing recursion and updating the doc contract.

Self-cost-only is the better fit for the documented model and for per-node cost introspection, but the implementer must verify no consumer reads `estimatedCost` expecting an already-summed total.

Whichever is chosen, add a validator/assertion (runnable in debug builds or tests) that checks the invariant on constructed plans so the two conventions cannot silently re-mix.

## Related performance issue (address together)

`getTotalCost()` is uncached recursion and is invoked *inside constructors*, making plan construction O(depth^2), and it is re-paid on every `withChildren` re-mint across the three optimizer passes. Plan nodes are immutable, so memoize the total-cost result per node. Fixing the double-count and the memoization together avoids two passes over the same code.

## Use case

`explain`/`query_plan()` on a moderately nested query (a handful of stacked filters/joins/sorts over a base table) should report costs that grow roughly linearly with the input, and QuickPick should choose the same join order regardless of incidental nesting depth of unrelated operators.
