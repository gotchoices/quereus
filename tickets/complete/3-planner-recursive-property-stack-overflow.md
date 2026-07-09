description: Four query-plan property reads that walked the tree with plain recursion (crashing with a stack overflow on deep-enough plans) now walk with an explicit loop, matching the rest of the optimizer. Reviewed, extended with a shared-subtree test, and shipped.
files: packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/framework/characteristics.ts, packages/quereus/src/planner/debug.ts, packages/quereus/test/planner/plan-node-traversal.spec.ts, docs/optimizer.md
----

## What landed

The optimizer's pass framework already walks plan trees iteratively (explicit worklist) so deep plans don't overflow the native call stack. Four per-node property reads still used unbounded recursion over the same trees, undermining that guarantee: a plan deep enough to *need* the worklist crashed the first time any rule touched one of them. All four are now iterative:

- **`PlanNode.get physical`** — delegates to a new private static post-order walk `PlanNode.computePostOrder(root, isDone, compute)`; the defaults/override merge moved verbatim into `computePhysicalFromChildren()`, reading each child's cached `_physical` instead of a recursive getter call.
- **`PlanNode.getTotalCost()`** — same `computePostOrder`, writing through the existing `_totalCostCache` memo. Children summed from 0 first, then self added — bit-identical float order to the original `estimatedCost + children.reduce(…, 0)`, so `validateCostAdditivity` still matches to the last ULP.
- **`PlanNode.visit()`** — iterative pre-order explicit stack (children pushed in reverse → original left-to-right order; no per-node dedup, matching the old recursion).
- **`PlanNodeCharacteristics.subtreeHasSideEffects()`** — iterative worklist with early-exit on the first side-effecting node.

Deliberately **not** converted: `debug.ts` `formatPlanTree`/`formatPlanSummary` (diagnostic/EXPLAIN only, off the query hot path — tagged with a `NOTE:` tripwire at the site); `validation/plan-validator.ts` `validateCostAdditivity` (already walks with its own explicit stack).

## Review findings

**Verdict: recursion→iteration conversion is correct and complete for the four in-scope accessors. Merged with one added test, one doc fix, and one out-of-scope contamination flagged.**

### Correctness — checked, no defects

- **`computePostOrder` worklist** (peek → expand → compute, per-frame `expanded` flag, `isDone` memo guard): verified for leaf, chain, and diamond-DAG shapes. On a shared subtree, whichever frame reaches the node first expands and computes it; every later frame sees `isDone` and pops — folded exactly once, children always populated before the parent reads them.
- **`getTotalCost` float order**: confirmed bit-identical to the original `reduce` (children from 0, then self) — the handoff's own earlier 1-ULP drift regression stays fixed.
- **`physical` fold, `visit` order, `subtreeHasSideEffects` early-exit**: all match the recursive semantics; the equivalence tests on three real plans (filter, group-by+agg+order, EXISTS subquery — the last shares nodes across `getChildren`) pass.
- **Sweep completeness**: `docs/optimizer.md` was the only doc making a mechanism-level claim about these accessors; no other recursive plan-tree property walker was found beyond the two deliberately-skipped sites above.

### Fixed in this review pass

- **Closed known-gap #1 (no DAG test).** Added `test/planner/plan-node-traversal.spec.ts` › *"physical fold visits a shared (DAG) subtree node once"*: builds a diamond `A→[B,C], B→[D], C→[D]` with a `CountingNode` whose `computePhysical` bumps a counter, reads `A.physical`, and asserts `D` is folded exactly once (and not recomputed on re-read). This is the subtlest correctness property and was previously covered only by reasoning + incidental real-plan sharing.
- **Stale doc corrected.** `docs/optimizer.md` described `subtreeHasSideEffects` as a *"recursive walk (defensive)"* / *"defensive recursive helper"* — now *"iterative subtree walk"* with an explicit-worklist / stack-safety note, matching the new implementation.

### Flagged — out of scope, not fixed here (see note below)

- **Implement commit `676068d7` committed unrelated debug logging into `packages/quereus/src/core/database-assertions.ts`** — `[DIAG …]` `console.error` statements, an unused `yielded` counter, and a hardcoded `select … from accounts` probe. This has nothing to do with the recursion change (it was debug for an *assertions* investigation that leaked into the commit) and it **broke `yarn lint`** (unused-var error on `yielded`) at that commit. During this review a **concurrent uncommitted edit** by an active debug session on the same file removed the contamination in the working tree, so lint + tests are green now. It was **not** touched by the reviewer, per the tess rule that in-flight tree edits are not the reviewer's to undo. **Residual risk (not a ticket — the concurrent session is actively on it):** if that uncommitted cleanup is discarded rather than committed, HEAD (`676068d7`) still carries the committed DIAG lines and lint will be red again. No new ticket filed to avoid racing the live cleanup; flagged here for human awareness.

### Known gaps reviewed and accepted (not fixed)

- **`physical` equivalence compares scalar keys only** (readonly/deterministic/idempotent/constant/expectedLatencyMs/concurrencySafe/estimatedRows), not a full deep-equal — deliberate, since `computePhysical` can mint fresh function-valued fields (e.g. `updateLineage` inverses) each call. Acceptable: those scalars are exactly what the defaults/override merge derives.
- **Depth 30 000 is empirical** (matches the reproduced overflow). The real guarantee is bounded-loop correctness; the deep-chain tests are a smoke check of it. Acceptable.

### Tripwire (unchanged, confirmed appropriate)

- `debug.ts` `formatPlanTree`/`formatPlanSummary` remain recursive, tagged `NOTE:` at `formatNode`. Genuinely conditional (only trips if EXPLAIN/plan-format runs on an arbitrarily deep plan) — correctly left as a tripwire, not expanded into scope.

## Validation

- `packages/quereus` targeted: `node test-runner.mjs --grep "PlanNode"` → **47 passing** (includes the four deep-chain no-overflow tests, the new diamond-DAG fold-once test, and the three-query recursive-equivalence checks).
- `yarn test` (full workspace): **6551 passing, 0 failing, 9 pending** (was 6550 pre-review; +1 is the new DAG test).
- `yarn lint`: **clean** (exit 0).
