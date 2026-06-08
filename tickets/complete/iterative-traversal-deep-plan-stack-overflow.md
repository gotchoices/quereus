---
description: Rewrote `PassManager.traverseTopDown` / `traverseBottomUp` as iterative worklist loops, removing the recursion-depth ceiling for very deep plans.
files:
  - packages/quereus/src/planner/framework/pass.ts
  - packages/quereus/test/optimizer/pass-manager.spec.ts
---

## Outcome

`PassManager`'s two traversals are no longer recursive. They walk a work stack
of `VisitFrame` / `FinalizeFrame` records and reassemble parents from a result
stack, so the only ceiling is heap rather than JS engine call-stack budget.
Everything else in `pass.ts` (`applyPassRules`, `inheritVisitedRules`,
`assertOptimizationDepth`, `executeStandardPass`, `PassState`,
`planInputDepth`) is unchanged.

Behavior preserved:

- Cache key is the original (pre-rule) node id. Cache hits short-circuit.
- Top-down rules fire before descent; bottom-up rules fire after children are
  re-spliced. The rule-firing counter and `maxRulesFired` budget are unchanged.
- `withChildren` only rebuilds when at least one child reference changed.
- `assertOptimizationDepth` fires on first entering an uncached node.

Verified by:

- `yarn workspace @quereus/quereus run test` — 3175 passing (was 3174 before
  this ticket; +1 from the new DAG-sharing test added in review).
- `yarn workspace @quereus/quereus run lint` — clean (exit 0).
- New tests in `pass-manager.spec.ts`:
  - 50,000-deep linear chain plans cleanly under both `TopDown` and
    `BottomUp`. Recursive implementation would `RangeError`. ~50ms.
  - Depth-3 fan-out binary tree exercised by a TopDown `Filter→Project`
    pass + BottomUp `leaf-Project→SingleRow` pass; asserts exact node counts
    (8 leaves, 7 internal). Catches off-by-one or reverse-order bugs in the
    result-stack splice.
  - **(added in review)** Tiny DAG with a single shared leaf reached via two
    parents — asserts rule fires exactly 4 times (once per distinct id), not
    5, proving within-pass cache hits work on shared subtrees.

## Review findings

### What was checked

- Read the full implementation diff before the handoff narrative.
- Re-derived the worklist invariants by hand: reverse-push of child visit
  frames ⇒ children pop and finalize in original order ⇒ tail-splice of N
  from result stack yields children in original left-to-right order. Confirmed
  against multi-level and fan-out cases.
- Cache-key invariant: `frame.node.id` (top-down visit-leaf and cache check),
  `frame.origNodeId` (finalize). Top-down captures the original id into the
  finalize frame before rules fire on the parent, so cache-key parity with
  the recursive version is preserved.
- `withChildren` early-exit loop is semantically identical to the previous
  `Array.some` check.
- Top-down vs bottom-up rule timing: rules-before-descent (top-down) uses
  `postRule.getChildren()` for the next visit; bottom-up applies rules in
  `finalizeNode` after splicing finalized children — both match the
  pre-rewrite control flow.
- Memory footprint: workStack grows ~2× depth for a linear chain (visit +
  finalize per level); resultStack grows by max breadth-at-completion. Both
  heap-bound, not stack-bound. The 50k-deep test exercises this.
- Ran `yarn workspace @quereus/quereus run lint` and
  `yarn workspace @quereus/quereus run test`. Both green.
- Searched docs for references to recursive traversal in the optimizer
  (`docs/optimizer.md`, `docs/progressive-optimizer.md`, etc.). None describe
  the traversal as recursive; depth-budget language ("per-pass depth budget
  of `max(...)`") in `docs/optimizer.md` still accurately describes the
  iterative version. No doc updates needed.

### Findings & disposition

- **Minor — `assertOptimizationDepth` ordering shifted.** The recursive code
  called `assertOptimizationDepth(state, depth)` *before* the cache lookup;
  the iterative code checks the cache first and only asserts depth on a
  cache miss. Strictly speaking this changes semantics — a deep path
  re-entering a cached subtree no longer trips the depth guard. **Disposition:
  accepted, not changed.** The cached subtree is already finalized work; no
  further descent happens on a hit, so there's no opportunity for stack
  growth that the guard would protect against. The change is at worst neutral
  and arguably a strict improvement. Worth knowing if depth-budget semantics
  ever need to be tightened.
- **Minor — DAG-sharing test gap from the handoff.** The implementer
  explicitly flagged that the sanity test built 15 distinct node instances
  and therefore did not exercise within-pass cache reuse. **Disposition: fixed
  inline.** Added `reuses cached results for shared subtrees within a single
  pass` — a tiny DAG (root → {left, right} → shared leaf) with a counter rule
  that asserts exactly 4 firings (one per distinct id). Locks down the cache
  short-circuit behavior the iterative rewrite relies on.
- **Tiny — `finalizeNode` takes `context` twice when `applyRulesAfter` is
  non-null** (once as a direct parameter for cache writes, once inside the
  `applyRulesAfter` bundle for rule application; they are always the same
  context). **Disposition: left alone.** Collapsing it is more LOC churn than
  clarity gain; both call sites at the worklist level pass the same context
  for both purposes, and the redundancy is local to one helper.
- **None — type safety, resource cleanup, error handling.** The new types
  (`VisitFrame` / `FinalizeFrame` / `Frame` discriminated union) are precise;
  no `any` used. Arrays go out of scope at function exit. Exceptions from
  `applyPassRules` (depth budget, `maxRulesFired`) propagate unchanged.
- **None — DRY / modularity.** `finalizeNode` is the shared splice/rewire
  helper for both traversal orders, with the only delta (apply-rules-after
  or not) parameterized cleanly. The visit-leaf fast-path is duplicated
  across the two traversals but with order-specific rule placement, which
  makes inlining the right call — extracting it would require passing more
  flags than the duplication costs.
- **None — performance.** Algorithmic complexity matches the recursive
  version (O(N) over the plan tree). `Array.splice` for the tail-pop is
  V8-fast and equivalent in cost to the previous `children.map`.

### Validation summary

| Check | Result |
|---|---|
| `yarn workspace @quereus/quereus run lint` | exit 0, clean |
| `yarn workspace @quereus/quereus run test` | 3175 passing, ~43s |
| `pass-manager.spec.ts` block | 18 passing (was 17; +1 new) |
| 50,000-deep chain (both orders) | passes in ~50ms; no `RangeError` |
| Fan-out tree structural assertions | 8 leaves + 7 internal Projects |
| DAG-sharing cache hit (added) | exactly 4 firings (1 per distinct id) |
