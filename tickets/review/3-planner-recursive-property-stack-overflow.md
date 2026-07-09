description: Four query-plan property reads used to walk the tree with plain recursion, so a deep-enough plan crashed with a stack overflow; they now walk with an explicit loop instead, matching how the rest of the optimizer already avoids that crash.
files: packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/framework/characteristics.ts, packages/quereus/src/planner/debug.ts, packages/quereus/test/planner/plan-node-traversal.spec.ts
difficulty: hard
----

## What landed

The optimizer's pass framework already walks plan trees iteratively (explicit worklist) so deep plans don't overflow the native call stack. Four per-node property reads still used unbounded recursion over the same trees, undermining that guarantee: a plan deep enough to *need* the worklist crashed the first time any rule touched one of them. All four are now iterative.

### `PlanNode` (`nodes/plan-node.ts`)

- **New shared helper `PlanNode.computePostOrder(root, isDone, compute)`** — a private static iterative post-order walk over `getChildren()`. `isDone(node)` reports whether the node's memo is already populated (skip + don't re-descend); `compute(node)` runs once per not-yet-done node *after* all its children are computed, so it may read each child's memo directly. Uses a peek-then-expand-then-compute worklist (each frame carries an `expanded` flag). The `isDone` guard is what makes shared-subtree DAGs correct and O(1) on re-visit, and preserves existing per-instance memoization.

- **`get physical`** → delegates to `computePostOrder` (memo field `_physical`). The defaults/override merge moved verbatim into a new private `computePhysicalFromChildren()`; the *only* change is that `childrenPhysical` is read from each child's cached `_physical` instead of a recursive `.physical` getter call. Getter signature unchanged.

- **`getTotalCost()`** — the prereq ticket `planner-cost-model-double-count` landed the **self-cost-only** convention (still sums children, memoized in `_totalCostCache`). So per the coordination note this *did* need conversion (it was not the identity). Now delegates to `computePostOrder`, writing through the **same** `_totalCostCache` memo — no second/competing memo added. **Summation order is bit-identical to the original** (`estimatedCost + children.reduce(…, 0)`): children summed from 0 first, then self added. This matters — see finding below.

- **`visit(visitor)`** — iterative pre-order explicit stack. Children pushed in reverse so they pop left-to-right → original visitation order preserved. **No per-node dedup** (matches the old recursion: a node reachable by two paths is visited once per path).

### `PlanNodeCharacteristics.subtreeHasSideEffects` (`framework/characteristics.ts`)

Iterative worklist with early-exit — returns `true` on the first side-effecting node, drains otherwise. Kept as an explicit walk (not collapsed to the one-node `hasSideEffects` check) per the accessor's defensive-belt doc.

### Not converted (deliberate)

- `debug.ts` `formatPlanTree`/`formatPlanSummary` still recurse — **diagnostic/EXPLAIN display only, off the query hot path**. Tagged with a `NOTE:` tripwire at the site pointing at `computePostOrder`/`visit` as the conversion pattern if plan formatting ever needs deep plans. See findings.
- `validation/plan-validator.ts` `validateCostAdditivity` already walks with its own explicit stack and calls the now-iterative `getTotalCost` — no change needed.

## How to validate / test

Run the traversal specs:

```
cd packages/quereus
node test-runner.mjs --grep "traversal" --reporter spec
```

New tests in `test/planner/plan-node-traversal.spec.ts`:

- **Deep-chain no-overflow** — a minimal `ChainNode` (fixed self-cost 1, single optional child; fields declared explicitly since the test runner's type-stripping rejects parameter properties) chained to depth 30 000 (the reproduced overflow depth). Asserts `root.physical`, `root.getTotalCost()`, `root.visit(() => {})`, and `PlanNodeCharacteristics.subtreeHasSideEffects(root)` each do **not** throw. Chain is built *iteratively* (constructor stores self-cost only, never folds child cost), so construction itself doesn't overflow.
- **Equivalence on real plans** — for three real `db.getPlan(...)` plans (filter, group-by+order-by+agg, EXISTS subquery), an independent recursive reference is recomputed locally and compared: visit order (by node id sequence), per-node `getTotalCost` (closeTo), and per-node `physical`.

Whole suite + lint are green:

```
yarn build && yarn test && yarn lint    # from packages/quereus
```

`yarn test`: 6550 passing, 0 failing, 9 pending. `yarn lint`: clean.

## Known gaps (reviewer: treat tests as a floor)

- **No hand-built shared-subtree (DAG) test for the iterative `physical` fold.** DAG-correctness (each shared node computed once, all children populated before parent) is covered by *reasoning* (the `isDone` memo guard + post-order property) and *incidentally* by real plans (the EXISTS-subquery plan shares nodes across `getChildren()`/`getRelations()`), but there is no test that constructs a diamond DAG (`A→[B,C]`, `B→[D]`, `C→[D]`) and asserts `D` is folded exactly once. A reviewer wanting belt-and-suspenders could add one.
- **The `physical` equivalence check compares scalar keys only** (`readonly, deterministic, idempotent, constant, expectedLatencyMs, concurrencySafe, estimatedRows`), not a full deep-equal of `PhysicalProperties`. Reason: `computePhysical` can return function-valued fields (e.g. `updateLineage` inverse closures) that mint fresh instances on each call, so a full deep-equal would spuriously fail on function identity. The chosen plans are read-only selects with no `updateLineage`, and the scalar keys are exactly the fields the defaults/override merge derives — but the check does not prove byte-identical `physical` for update/view plans.
- **Depth 30 000 is empirical**, matching the reproduction. It reliably overflowed the recursive versions on this platform/Node; a future runtime with a much larger native stack could pass the test even against a (reintroduced) recursive version, weakening it as a guard. Bounded-loop correctness is the real guarantee; the test is a smoke check of it.

## Review findings

- **Floating-point summation order in `getTotalCost` — caught and fixed during implement.** The first iterative draft summed as `((estimatedCost + c0) + c1)…`, which drifted by 1 ULP from `validateCostAdditivity`'s recomputation (`50.242999…` vs `50.243`) and failed `cost-additivity.spec.ts` "validateCostAdditivity passes on a recursive-CTE plan". Fixed by summing children from 0 first, then adding self — bit-identical to the original `reduce`. Worth a reviewer glance that no other consumer depends on the *old-old* (pre-cost-model) ordering.
- **Tripwire parked:** `debug.ts` `formatPlanTree`/`formatPlanSummary` remain recursive; tagged `NOTE:` at `formatNode` (packages/quereus/src/planner/debug.ts). Diagnostic-only, genuinely conditional (only trips if EXPLAIN/plan-format is ever run on an arbitrarily deep plan), so left as a tripwire per the recursion sweep rather than expanded into scope.
