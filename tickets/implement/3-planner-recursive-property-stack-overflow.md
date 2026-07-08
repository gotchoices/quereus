description: The optimizer walks query plans with a loop so very deep plans don't crash, but a few core plan properties still compute themselves with unbounded recursion, so a deep-enough plan crashes with a stack overflow the moment a rule reads one of them. Make those property walks bounded too.
prereq: planner-cost-model-double-count
files: packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/framework/characteristics.ts, packages/quereus/src/planner/framework/pass.ts, packages/quereus/test/planner/plan-node-traversal.spec.ts
difficulty: hard
----

## Problem (reproduced)

The pass framework's tree traversal is deliberately *iterative* (explicit worklist + input-scaled depth budget, `framework/pass.ts` `traverseTopDown`/`traverseBottomUp` around :445/:503) so deep plans don't blow the native call stack. That guarantee is undermined: several per-node property accessors are computed by *unbounded recursion* over the same trees. A plan deep enough to *need* the budget overflows the stack the first time any rule touches one of them.

The four recursive accessors:

- `get physical()` — `nodes/plan-node.ts:825`. Recurses `this.getChildren().map(child => child.physical)`. Result is memoized per instance in `_physical` (`plan-node.ts:702`).
- `getTotalCost()` — `nodes/plan-node.ts:776`. Recurses `child.getTotalCost()`. **Not** memoized.
- `visit(visitor)` — `nodes/plan-node.ts:780`. Pre-order: `visitor(this)` then `child.visit(visitor)` per child.
- `PlanNodeCharacteristics.subtreeHasSideEffects(node)` — `framework/characteristics.ts:38`. Recurses children with early-exit.

**Reproduced** (2026-07-08): a 30 000-deep chain of a minimal `PlanNode` subclass throws `RangeError: Maximum call stack size exceeded` on `root.physical`. The other three recurse identically and overflow the same way. The reproduction node subclasses `PlanNode` directly with a fixed self-cost so its *constructor* does not recurse — note that most real relational constructors (e.g. `FilterNode`, `nodes/filter.ts:29`) call `source.getTotalCost()` in the `super(...)` call, so building a deep chain of real nodes *also* overflows during construction. That construction-time recursion is the cost-model ticket's territory (see Coordination); this ticket is about the read-time accessors.

## Expected behavior

Computing `physical`, total cost, a `visit`, or `subtreeHasSideEffects` on an arbitrarily deep plan does not overflow the stack — these walks are bounded the same way the pass framework's traversal is. Results must be identical to the recursive versions for shallow plans.

## Direction

Convert each accessor to an explicit-stack (worklist) walk. The pass framework already models the shape to copy: a `visit`/`finalize` two-frame worklist for post-order work (`pass.ts` `VisitFrame`/`FinalizeFrame`, :247). Reuse that idea; do not add a depth *budget* to these accessors — a bounded loop cannot overflow, and these are pure reads with no rule-firing to cap.

### `get physical` — post-order, memoized bottom-up
`physical` is a bottom-up fold: a node's physical needs every child's physical first (`computePhysical(childrenPhysical)`). Walk the subtree rooted at the accessed node in **post-order** with an explicit stack; for each node whose `_physical` is unset, compute it from its children's already-populated `_physical` and store it. Because it is post-order, every child's `_physical` is set before the parent is finalized. Keep the memoization: nodes with `_physical` already set are skipped (this is also what makes shared-subtree DAGs correct and keeps the second read O(1)). The public getter stays `get physical()`; it just delegates to the iterative helper when `_physical` is missing instead of recursing.

Preserve the exact `defaults`/`propsOverride` merge at `plan-node.ts:832-852` — the only change is *how* `childrenPhysical` is obtained (from cached `_physical`, not a recursive `.physical` read).

### `visit` — pre-order worklist
Replace with an explicit stack that preserves the current **pre-order** visitation (`visitor(node)` before descending) and the current child order. Push children in reverse so they pop left-to-right. Semantics must stay identical — the existing `plan-node-traversal.spec.ts` "visit() should not visit any node more than once" tests must still pass unchanged (visitation still goes through `getChildren()`).

### `subtreeHasSideEffects` — worklist with early-exit
Replace with an explicit-stack walk that returns `true` on the first node with `hasSideEffects` and drains otherwise. Keep the early-exit (don't force a full walk). Note the accessor's own doc comment (`characteristics.ts:29-37`) records that for a well-formed tree this is equivalent to `hasSideEffects(node)` alone, because `physical.readonly` already propagates as AND-of-children — but it is kept as a defensive belt, so preserve the explicit walk rather than collapsing it to the one-node check.

### `getTotalCost` — coordinate, do not double-fix
See Coordination. Depending on what `planner-cost-model-double-count` lands, `getTotalCost` may already be non-recursive (identity) or may still recurse. Do **not** convert it blindly.

## Coordination with `planner-cost-model-double-count`

That ticket (currently in `plan/`, seq 1) fixes `getTotalCost`'s exponential double-count and adds per-node memoization, and is choosing between two conventions:

- **Baked total** → `getTotalCost()` becomes the identity (`return estimatedCost`). No recursion left; **nothing to do here** for total-cost.
- **Self-cost only** → `getTotalCost()` still sums children. Even memoized, the *first* computation on a deep uncached tree recurses and overflows. In that case, convert it to an iterative post-order sum here (same post-order helper shape as `physical`), writing through the memo the cost-model ticket added — do not add a second, competing memo.

`prereq: planner-cost-model-double-count` enforces order. **First action in the implement session:** read the landed state of `getTotalCost()` and decide which of the two cases applies, then act (or confirm no action needed) accordingly. Total-cost must end up fixed *once* — non-recursive and memoized — not patched twice.

## Regression test

Extend `test/planner/plan-node-traversal.spec.ts` (or a sibling spec). The reproduction used here:

- A minimal `PlanNode` subclass (`ChainNode`) with a fixed self-cost of 1 and a single optional child, chained to depth ~30 000. Node strip-only mode (the test runner) does **not** support TypeScript parameter properties — declare fields explicitly, assign in the constructor body.
- Assert `root.physical`, `root.getTotalCost()`, `root.visit(() => {})`, and `PlanNodeCharacteristics.subtreeHasSideEffects(root)` each do **not** throw.
- Equivalence: on a small handful of real plans (`db.getPlan('select ...')`, as the existing specs do), assert the iterative results equal a locally-recomputed recursive reference (cost sum, visit-node set, physical of each node), so the rewrite is provably behavior-preserving on shallow trees.

Run with the project runner and grep filter, e.g. `node test-runner.mjs --grep "<describe text>" --reporter spec` from `packages/quereus`. (The bare `mocha` binary uses Node type-stripping and fails on this repo's `.js` import specifiers — always go through `test-runner.mjs`, which loads `register.mjs`.)

## TODO

- Read landed `getTotalCost()` after `planner-cost-model-double-count`; determine baked-total (identity, no-op here) vs self-cost-only (needs iterative conversion). Act accordingly, reusing the cost-model memo.
- Convert `get physical` (`plan-node.ts:825`) to an iterative post-order helper that populates `_physical` bottom-up; keep the getter signature and the exact defaults/override merge.
- Convert `visit` (`plan-node.ts:780`) to a pre-order explicit-stack walk; preserve order and single-visit semantics.
- Convert `subtreeHasSideEffects` (`characteristics.ts:38`) to an iterative worklist with early-exit.
- Grep for any other accessor that recurses through `getChildren()` and would overflow on deep plans; if a genuine one exists outside these four, note it (tripwire / follow-up), don't silently expand scope.
- Add the deep-chain no-overflow regression test + the shallow-plan equivalence test.
- `yarn build`, `yarn test`, `yarn lint` (from `packages/quereus`) green before handoff.
