description: The query optimizer's cost estimates double-count nested work, so deeply nested queries get wildly inflated cost numbers that skew which plan the optimizer picks. Fix so cost is counted once per node.
files: packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/nodes/join-node.ts, packages/quereus/src/planner/nodes/sort.ts, packages/quereus/src/planner/nodes/recursive-cte-node.ts, packages/quereus/src/planner/rules/join/rule-quickpick-enumeration.ts, packages/quereus/src/func/builtins/explain.ts, packages/quereus/src/planner/debug.ts
difficulty: hard
----

## Decision (resolved by plan stage — do not re-open)

Adopt **self-cost-only**. `estimatedCost` stores ONLY the node's own incremental cost, excluding children. `getTotalCost()` remains the sole place children are summed. No constructor may call `getTotalCost()` or read a child's `estimatedCost` to build its own `estimatedCost`.

Why safe (verified during planning): the only runtime consumers of `estimatedCost` are `func/builtins/explain.ts:144` and `planner/debug.ts:137,369`, both of which display it as a *per-node* value. Nothing reads `estimatedCost` expecting an already-summed subtree total. `getTotalCost()` is consumed by QuickPick (`rules/join/rule-quickpick-enumeration.ts:113`) and debug/explain — all want the true summed total, which self-cost-only produces correctly. Plan goldens (`test/plan/*.plan.json`) deliberately exclude cost (`test/plan/_helpers.ts:109-116`), so they will NOT churn.

The **baked-total** alternative was rejected: it fights the documented contract at `plan-node.ts:707,776` and kills per-node cost introspection in EXPLAIN.

## The universal fix rule

For each node constructor that currently folds child cost into `estimatedCost`, the new self-cost is:

```
selfCost = (current estimatedCost formula)  −  Σ child.getTotalCost() for every child returned by getChildren()
```

Whatever remains after subtracting the summed children is the genuine self cost (row-scaled overhead, hash/merge/join cost, fixed constants). Concretely, drop the `source.getTotalCost()` / `left.getTotalCost() + right.getTotalCost()` / `children.reduce(...getTotalCost())` terms and keep only the residual.

**Critical correctness check per node:** the set of children you stop folding MUST equal `getChildren()`. If a node folded a term that is NOT in `getChildren()`, that term is real self cost and must stay. If a node has a child in `getChildren()` that it never folded, leave it — `getTotalCost()` will now add it (this fixes a pre-existing *under*-count, e.g. `view-mutation-node`, and the filter/join scalar children below).

### Node inventory (all currently violate the contract)

Unary — new `estimatedCost` = the residual constant/row term only:
- `aggregate-node.ts:122` → `estimatedCostOverride ?? <small self>` (residual is ~0; use existing default `0.01` or a modeled per-row aggregate cost — keep current intent, just strip `source.getTotalCost()`)
- `distinct-node.ts:21` → strip `sourceCost`
- `hash-aggregate.ts:37` → `hashCost`
- `stream-aggregate.ts:34` → `streamingCost`
- `ordinal-slice-node.ts:40` → residual (~default)
- `limit-offset.ts:28` → residual (~default)
- `retrieve-node.ts:32` → residual (~default)
- `remote-query-node.ts:27` → residual (~default)
- `sink-node.ts:20` → `0.1`
- `cte-node.ts:54` → `10`
- `filter.ts:29` → `(source.estimatedRows ?? 1) * predicate.getTotalCost()` — but `predicate` IS in `getChildren()` (`[source, predicate]`), so it is *also* double-counted today. New self = per-row predicate overhead only, e.g. `(estimatedRows) * <per-row epsilon>`; the predicate subtree cost comes in once via the child. Do NOT keep `predicate.getTotalCost()` in self-cost. Pick a small modeled per-row factor (e.g. `0.01 * estimatedRows`) and document it.
- `sort.ts:46` → `sortCost * keyCost` where `keyCost` sums `key.expression.getTotalCost()`. Sort-key expressions are NOT in `getChildren()` (verify), so keeping `keyCost` as a self-cost multiplier is legitimate — but strip `source.getTotalCost()`.

Passthrough — currently pass `source.estimatedCost` as own self, which double-counts source's *self* after this fix:
- `alias-node.ts:23`, `asserted-keys-node.ts:36`, `lens-auxiliary-access-node.ts:84` → replace with a small constant (the base default `0.01`); source flows in via `getChildren()`.

Multi-child — new self = the residual after removing all folded child totals:
- `join-node.ts:126` → `joinCost` (= `leftRows * rightRows`); `condition` is in `getChildren()` and was never folded — it now correctly adds once.
- `merge-join-node.ts:45` → `mergeJoinCost(...)`
- `bloom-join-node.ts:45` → `hashJoinCost(...)`
- `asof-scan-node.ts:95` → `leftRows + rightRows` residual
- `fanout-lookup-join-node.ts:156-157` → residual after removing `outer.getTotalCost()` + `branchCost`
- `set-operation-node.ts:77` → residual (~default)
- `async-gather-node.ts:136` → residual (~default; the reduce was pure child sum)
- `block.ts:22` → residual (pure child sum → ~default)
- `view-mutation-node.ts:188` → `0.1` (was `reduce(..., 0.1)` over baseOps only; other children in `getChildren()` now add via total)
- `recursive-cte-node.ts:34` → `50`. **Special:** `recursiveCaseQuery` is set post-construction via `setRecursiveCaseQuery` and both it and `baseCaseQuery` are in `getChildren()`. Removing the fold makes this clean — self is just `50`.

Leaf (already correct, do NOT touch): `table-access-nodes.ts:76` uses `filterInfo.indexInfoOutput.estimatedCost` — this is the vtab `xBestIndex` cost, a genuine leaf self cost. Likewise `quereus-isolation/src/filter-info.ts` `estimatedCost` is the IndexInfo cost, unrelated to plan nodes — leave alone.

## Memoization (do in the same pass — ticket explicitly bundles it)

`getTotalCost()` is uncached recursion. Once it is no longer called inside constructors (this fix removes every such call), the first invocation happens after the tree is fully built, so caching is safe. Memoize per instance:

```ts
private _totalCostCache?: number;
getTotalCost(): number {
  if (this._totalCostCache === undefined) {
    this._totalCostCache = this.estimatedCost +
      this.getChildren().reduce((acc, child) => acc + child.getTotalCost(), 0);
  }
  return this._totalCostCache;
}
```

PlanNodes are immutable, so the cache never goes stale via `withChildren` (that mints a fresh instance). **One exception:** `recursive-cte-node.setRecursiveCaseQuery()` mutates a child in place and already clears `attributesCache`/`typeCache`. Add `this._totalCostCache = undefined;` there too, or the memoized total captures the placeholder recursive case. (It already clears the other caches at `recursive-cte-node.ts:52-53` — add cost cache alongside.)

## Validator / invariant guard

Add a debug-buildable / test-callable validator that walks a constructed plan and asserts cost additivity so the two conventions cannot silently re-mix:

- `validateCostAdditivity(plan)` — for each node assert `node.getTotalCost() === node.estimatedCost + Σ child.getTotalCost()` (guards a future `getTotalCost` override from diverging) and that `estimatedCost` is finite and `>= 0`.
- Stronger anti-regression (recommended): a source-level unit test that scans `planner/nodes/*.ts` and fails if any node constructor body references `getTotalCost(` or `.estimatedCost` in building its own `super(...)` cost. This is the actual convention that was violated; a static guard prevents reintroduction. Keep it greppable and documented.

## Doc updates

- `docs/optimizer.md` — state the self-cost-only convention explicitly (self cost excludes children; `getTotalCost()` sums the subtree; memoized). Update alongside the code (AGENTS.md: no summary docs, update existing).
- The contract comment at `plan-node.ts:707` is already correct; ensure the memoization comment notes the recursive-cte invalidation.

## Edge cases & interactions

- **Fold set ≠ getChildren():** the one class of real bugs. For every touched node, cross-check the removed terms against `getChildren()`. `filter` (predicate double-counted today), `sort` (key exprs NOT children — residual multiplier stays), `view-mutation` (folded only baseOps but has more children), and the three passthrough nodes (fold `source.estimatedCost` self) are the traps.
- **recursive-cte mutation:** memoized total must be invalidated in `setRecursiveCaseQuery`; also the fold removal must not depend on `recursiveCaseQuery` being non-placeholder at construction time (self is now a constant, so it doesn't).
- **`estimatedCostOverride` params:** several unary constructors accept an override the optimizer passes on `withChildren` re-mint. Those overrides currently carry *total* costs from a prior mint; after this change the optimizer must pass (or omit) a *self* cost. Audit every call site that supplies an override — passing a stale total re-introduces the double count. If an override was only ever `node.estimatedCost` from the old instance, it stays correct (that value is now self); if it was `getTotalCost()`, fix it.
- **QuickPick comparisons:** after the fix, left-deep vs bushy candidates compare on linear totals. Sanity-check that the cross-product penalty logic in `rule-quickpick-enumeration.ts` (around the `estimatePlanCost` comment) still lands on the same relative ordering intent — it reads `getTotalCost()` only, so no code change, but verify a join-order test still picks sane orders.
- **estimatedRows undefined:** several residuals multiply `estimatedRows ?? N`. Preserve the existing fallbacks; don't let the residual go negative or NaN when rows are undefined.
- **Zero/empty children:** `block`, `async-gather`, `set-operation` with empty or single child — residual self must not underflow below the base default.
- **Cache poisoning via shared child references:** a child node instance shared across two parents (DAG, not tree) memoizes once and is reused — correct and desirable. Confirm no node mutates a child's `estimatedCost` after wiring.
- **Debug/explain output:** `serializePlanTree` (`debug.ts`) prints both `estimatedCost` and `getTotalCost` — after the fix EXPLAIN shows per-node self cost (smaller) and a linear total. Any test asserting exact cost numbers in EXPLAIN/`query_plan()` output must be updated to the new (correct) values, not loosened.

## Key tests (TDD)

- **Linear-depth regression (the headline):** build/plan a query with `d` stacked filters (or filters+sorts) over one base table for `d` = 1..8; assert `getTotalCost()` grows ~linearly in `d`, not `2^d`. Use `test/plan/basic/multi-filter-keyed` style. Expected: total ≈ base + d × per-filter self, within tolerance.
- **Additivity invariant:** `validateCostAdditivity` passes on a representative planned tree (joins + aggregates + sort + CTE).
- **QuickPick stability:** a join-order test where an unrelated operator is nested at varying depth around the join inputs — QuickPick must pick the same join order regardless of that incidental depth.
- **recursive-cte:** construct, call `setRecursiveCaseQuery`, assert `getTotalCost()` reflects the real recursive case (memo invalidated), and self stays `50`.
- **Static convention guard:** the source-scan test fails if a constructor reintroduces `getTotalCost()`/child `estimatedCost` in its self-cost.

## TODO

### Phase 1 — self-cost audit
- [ ] Walk every node in the inventory above; rewrite `super(scope, ...)` to the residual self cost per the universal rule.
- [ ] Cross-check removed terms against each node's `getChildren()`; fix the traps (filter predicate, sort keys, passthroughs, view-mutation).
- [ ] Audit `estimatedCostOverride` call sites in the optimizer; ensure overrides carry self cost, not totals.

### Phase 2 — memoization
- [ ] Add `_totalCostCache` to `PlanNode.getTotalCost()`.
- [ ] Invalidate it in `recursive-cte-node.setRecursiveCaseQuery()` alongside the existing cache clears.

### Phase 3 — validator + tests
- [ ] `validateCostAdditivity(plan)` walker (debug/test callable).
- [ ] Static convention-guard unit test over `planner/nodes/*.ts`.
- [ ] Linear-depth regression test; QuickPick stability test; recursive-cte memo test.
- [ ] Update any EXPLAIN/`query_plan()`/`serializePlanTree` tests that assert exact cost numbers to the corrected values.

### Phase 4 — docs + validation
- [ ] Update `docs/optimizer.md` cost-model section.
- [ ] `yarn build`, `yarn test`, `yarn lint` green. Stream long output with `tee`.
