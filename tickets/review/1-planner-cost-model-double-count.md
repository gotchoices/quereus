description: Reviewer handoff — the query optimizer's per-node cost estimates now store self-cost only (children summed once in getTotalCost), so deeply nested plans no longer get exponentially inflated costs. Verify the self-cost residuals and the anti-regression guard.
files: packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/nodes/sort.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/nodes/aggregate-node.ts, packages/quereus/src/planner/nodes/recursive-cte-node.ts, packages/quereus/src/planner/validation/plan-validator.ts, packages/quereus/test/planner/cost-additivity.spec.ts, docs/optimizer.md
difficulty: medium
----

## What was done

Adopted the **self-cost-only** convention the plan resolved: `PlanNode.estimatedCost`
now stores ONLY a node's own incremental cost; `PlanNode.getTotalCost()` is the sole
place children are summed (it walks `getChildren()`). Previously ~26 node constructors
folded `child.getTotalCost()` (or a child's `estimatedCost`) into their own
`estimatedCost`, so `getTotalCost()` double-counted the subtree — compounding with
nesting depth and inflating deeply nested plans exponentially.

### Node constructors rewritten (all inventory nodes)

For each, the folded child-cost terms were removed; the residual self-cost kept:

- Joins — self = the algorithm's own cost, children flow in via `getChildren()`:
  `join-node` (`leftRows*rightRows`), `merge-join-node` (`mergeJoinCost`),
  `bloom-join-node` (`hashJoinCost`), `asof-scan-node` (`leftRows+rightRows`),
  `fanout-lookup-join-node` (`0.01`).
- Aggregates — `hash-aggregate` (`hashCost`), `stream-aggregate` (`streamingCost`),
  `aggregate-node` (modeled `aggregateCost(sourceRows, outputRows)`).
- Unary — `distinct-node` (dedup cost), `sink-node` (`0.1`), `cte-node` (`10`),
  `retrieve`/`remote-query`/`ordinal-slice`/`limit-offset` (`0.01`).
- Passthrough — `alias`/`asserted-keys`/`lens-auxiliary-access` (`0.01`; they previously
  passed `source.estimatedCost`, double-counting the source's self).
- Multi-child — `set-operation`/`async-gather`/`block` (`0.01`), `view-mutation` (`0.1`),
  `recursive-cte` (`50`).
- `filter` — self = `filterCost(source.estimatedRows ?? 1)`. **Both** children (source
  AND predicate — `getChildren()` is `[source, predicate]`) now flow in once; the old
  formula folded `predicate.getTotalCost()` even though the predicate is a child.

### Memoization + recursive-CTE invalidation

`getTotalCost()` is memoized per instance (`_totalCostCache`). Safe: PlanNodes are
immutable (`withChildren` mints a fresh instance) and no constructor calls
`getTotalCost()` anymore. The one in-place child mutator,
`RecursiveCTENode.setRecursiveCaseQuery()`, clears the memo via a new protected
`PlanNode.invalidateTotalCostCache()` (alongside the existing attribute/type cache clears).

### Guards, tests, docs

- `validateCostAdditivity(plan)` in `plan-validator.ts` — walker asserting per node
  `getTotalCost() === estimatedCost + Σ child.getTotalCost()` and `estimatedCost` finite
  & `>= 0`. Debug/test-callable; NOT wired into the hot `validatePhysicalTree` path.
- `test/planner/cost-additivity.spec.ts` (6 tests): linear-depth regression (CTE chain,
  asserts per-level self is a fixed 10 and total is `base + 10×depth`), additivity on a
  join+agg+sort plan and a recursive-CTE plan, recursive-CTE memo invalidation, QuickPick
  join-order stability under incidental nesting, and a static convention-guard scan.
- `docs/optimizer.md` § Cost Model Integration — documents the self-cost-only convention,
  memoization, and the guards.

## Use cases for testing / validation

- **Run:** `packages/quereus` suite is green (6537 passing) including the new spec. Build
  and lint clean.
- **Headline behavior to spot-check:** plan any deeply nested query (stacked derived
  tables / filters / sorts). `getTotalCost()` at the root should grow ~linearly with
  nesting depth, not explode. EXPLAIN / `query_plan()` now show per-node self cost
  (smaller) and a linear subtree total.
- **Additivity:** `validateCostAdditivity(db.getPlan(sql))` should never throw on any
  planned tree.
- The pre-existing `test/planner/plan-node-traversal.spec.ts` additivity test still holds.

## Known gaps / things to scrutinize (treat tests as a floor)

1. **SortNode deviates from the plan — verify.** The plan asserted "sort-key expressions
   are NOT in `getChildren()`" and said to keep `keyCost` (Σ key-expr `getTotalCost()`) as
   a self-cost multiplier. That premise is **false**: `SortNode.getChildren()` returns
   `[source, ...sortKeys.map(k => k.expression)]`, so the key expressions ARE children.
   Keeping `sortCost * keyCost` would re-count the key subtrees. I instead set SortNode
   self = `sortCost(sourceRows)` (the pure O(n log n) sorting overhead from the cost
   module) and dropped the `keyCost` multiplier entirely. Reviewer: confirm this is the
   right modeling choice (it is per the universal rule + the getChildren() check), or
   whether a per-key-expression-count factor is wanted instead.
2. **AggregateNode self-cost choice.** The plan offered either `0.01` or a modeled cost;
   I used `aggregateCost(sourceRows, outputRows)` (mirrors the estimatedRows group-count
   heuristic). It's a logical node replaced by hash/stream aggregate during optimization,
   so the exact value barely matters — flag if you'd prefer the bare constant.
3. **`estimatedCostOverride` audit (no stale totals found).** Every `withChildren` re-mint
   passes `undefined`; the only two rules referencing the override
   (`rule-semijoin-existence-recovery`, `rule-join-existence-pruning`) pass `undefined`; no
   rule computes a `getTotalCost()` to pass as an override (grep of `rules/` + `building/`
   for `getTotalCost`/`.estimatedCost` returns only QuickPick's read). So no override
   re-introduces a total. Worth a second look if you distrust the grep.
4. **Nodes outside the inventory left untouched — confirm they don't fold.** `project`,
   `window`, `window-function`, `values`, `cache`, `eager-prefetch`, `sequencing`,
   `empty-relation`, `table-function-call` accept `estimatedCostOverride` but their
   default formulas never reference `getTotalCost()`/child `.estimatedCost` (confirmed by
   grep), so they were already self-cost-only. `table-access-nodes` keeps its vtab
   `indexInfoOutput.estimatedCost` (a genuine leaf self-cost).
5. **Static guard mechanism.** The convention-guard test scans each `planner/nodes/*.ts`
   (except `plan-node.ts`), strips comments, and fails on any `getTotalCost(` or child
   `.estimatedCost` (allowing `indexInfoOutput.estimatedCost`). It's a whole-file scan, so
   a future *legitimate* non-constructor use of `getTotalCost` inside a node file would
   false-positive — acceptable, since nodes shouldn't sum child costs anywhere but the
   base `getTotalCost()`. Consider whether to tighten it to constructor bodies only.
6. **QuickPick stability test is a floor.** It only checks that incidental unary nesting
   doesn't perturb the 3-table join order (compares the deduped table sequence from
   `query_plan()`). A stronger test would vary the nesting depth and cross-check more join
   shapes.
7. **Cost magnitudes changed for many nodes** (sort, aggregate, passthroughs, joins).
   Plan goldens deliberately exclude cost, so they don't churn; the one golden with a
   literal cost (`multi-filter-keyed.plan.json`'s `estimatedCost: 0.8`) is the vtab
   IndexInfo cost under `logical.filterInfo`, which is untouched. No EXPLAIN/`query_plan()`
   test asserts a node's `estimatedCost`/`getTotalCost` value (grep-confirmed).

## Unrelated pre-existing failure (flagged, not mine)

The full-suite `yarn test` surfaced one flaky failure in `@quereus/sync-coordinator`
(`StoreManager > disk eviction > should clear eviction candidates on shutdown`) that
**passed on isolated re-run** (128/128). Different package, no shared code path with the
planner. Recorded in `tickets/.pre-existing-error.md`.
