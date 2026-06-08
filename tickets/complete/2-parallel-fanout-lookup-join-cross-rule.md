description: The `cross` (1:n) FanOutLookupJoin recognition rule — per-branch + product memory guards, mixed at-most-one/cross chains, and the verified "advisory needs no change" finding.
files: packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts, packages/quereus/src/planner/optimizer-tuning.ts, packages/quereus/test/optimizer/parallel-fanout.spec.ts, docs/optimizer.md
----

## What landed

Extended `ruleFanOutLookupJoin` to recognize **`cross` (1:n) branches** —
parameterized equi-lookups that are *not* provably at-most-one — alongside the
existing at-most-one FK→PK and correlated-subquery branches. Added two memory
guards (`parallel.maxCrossBranchRows`, `parallel.maxCrossProduct`) that refuse to
cluster when a cross branch's estimate or the whole Cartesian product blows the
caps. The sibling node ticket (`parallel-fanout-lookup-join-cross-node`) made
`FanOutLookupJoinNode` mode-aware; this is the recognition + guard layer that
*produces* cross branches.

Implementation summary is in the implement commit (`d261a658`); see
`docs/optimizer.md` § "Fan-out lookup join (FK→PK + 1:n cross)" for the durable
description.

## Review findings

### Verification (all green)

- `yarn workspace @quereus/quereus run build` — clean.
- `yarn lint` — clean.
- Full `yarn test` (quereus + memory-vtab) — **3517 passing, 10 pending, 0 failing**
  (exit 0). No regressions. The new `cross (1:n) lookup branches` block (8 tests)
  is part of the 28 passing fanout tests.

### What was checked, by angle

- **Correctness of mode classification (`recognizeBranch`).** Confirmed the
  refactor preserves the prior bail behavior exactly: an FK→PK-aligned INNER
  lookup with a nullable FK or non-row-preserving path still `return null`s
  (bails the cluster) rather than degrading to `cross` — verified by reading the
  control flow and by the pre-existing nullable-FK-inner test still passing. A
  non-aligned INNER/CROSS lookup becomes `cross`; a non-aligned LEFT bails
  (correctly — cross-left is out of scope, see filed ticket). Residual
  (non-equality) ON predicates still bail via `isAndOfColumnEqualities` for
  *both* the at-most-one and cross paths, so a cross branch cannot smuggle a
  non-equi residual into its parameterizing filter.
- **Memory guard arithmetic (`crossGuardsPass` / `rowEstimate`).** Early-returns
  `true` when there are no cross branches; treats `undefined` estimates as
  exceeding the cap (conservative, safe direction — over-rejecting is a perf
  concern, never a correctness one); the per-branch and product comparisons are
  evaluated with the `-1`-cap guard-trip tests. The product multiplies
  `outer × Π(full-table cross estimate)`, which over-counts the true
  per-outer-row buffered product — conservative and documented.
- **Wide-row attribute widening.** `preserveAttrs` widens only `atMostOne-left`
  to nullable; `cross` outputs are correctly **not** nullable-widened (inner-drop
  semantics, no NULL fill). Confirmed consistent with the node's
  `buildAttributes`/`getType`.
- **Caching / re-execution.** Verified observationally (passing test) that a
  cross branch lookup is **not** wrapped in a `CacheNode` — it re-executes per
  outer row like an NLJ inner. The materialization advisory's correlated-subquery
  rule already declines to cache the (correlated) cross-branch child, so no
  advisory / reference-graph change was required for v1. (The implementer's note
  that `ReferenceGraphBuilder` loop detection is inert is corroborated by this
  behavioral guard; I relied on the test rather than re-auditing the graph
  builder, since the no-CacheNode guarantee is what matters for safety.)
- **Docs.** `docs/optimizer.md` fan-out section retitled and updated: cross
  branch kind, the memory guard + caveat about memory-vtab `estimatedRows=0`,
  both new tuning knobs, and the remaining `cross-left` gap. Read against the
  code — accurate and current.

### Findings & disposition

- **MAJOR (filed as backlog ticket):** `cross-left` mode — a LEFT 1:n chain
  currently bails to a nested-loop left join. This is a genuine scope gap the
  implementer parked as "future work" with no tracking ticket; filed as
  `tickets/backlog/parallel-fanout-lookup-join-cross-left.md` (needs a new
  `FanOutBranchMode`, empty-branch NULL-fill in emit, and nullable-widening).
  Not a defect in what landed — correctly out of scope for v1.

- **MINOR (noted, not fixed — low value):** The guard-trip tests use a sub-zero
  cap (`-1`) because synthetic memory-vtab fixtures resolve `estimatedRows` to
  `0`, so the production positive-estimate > positive-cap path is not exercised
  end-to-end. The comparison is the *same* operator and is trivially correct by
  inspection; exercising it would require either exporting `crossGuardsPass`
  (intrusive) or adding a vtab fixture that surfaces a positive `estimatedRows`
  (test-infra investment disproportionate to the risk). Left as-is.

- **MINOR (noted):** The product guard is effectively dormant on the default
  in-tree (memory-vtab) test environment — `estimatedRows=0` makes the product 0,
  so only the cost gate's latency requirement keeps the rule inert on local
  plans. This is consistent with the spec ("unknown" handling) and documented in
  `docs/optimizer.md`. No action.

- **Test robustness — checked, no issue:** The cross *recognition* tests assert
  `hasFanOut === true` / `branchModes` deep-equality, so a future cost-model
  reorder that broke recognition would fail these loudly (not silently go inert).
  The guard-trip tests assert `false`, but each shares its fixture with a
  positive-assertion test, so a recognition break would still surface.

- **FD propagation:** `FanOutLookupJoinNode.computePhysical` folds branches with
  empty equi-pair lists; cross branches don't tighten this — correct but
  imprecise, tracked upstream as a node-ticket follow-up. No action here.

### Empty categories

- **No correctness defects** found in the recognition rule or guards.
- **No inline (minor) fixes** were required — the diff is clean against SPP/DRY,
  type safety (no `any`; structural tuning param type is intentional), and error
  handling.

## Out of scope (carried forward)

- `cross-left` mode — filed: `parallel-fanout-lookup-join-cross-left` (backlog).
- Remote-rescan vs spill for re-executing a *remote* cross branch across outer
  rows — future `'spill'` strategy (`cache-node.ts`). Still out of scope.
