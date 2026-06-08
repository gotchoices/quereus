description: Relational constant folding — materialization of foldable relational subtrees at plan time
files:
  - packages/quereus/src/planner/analysis/const-pass.ts
  - packages/quereus/src/planner/analysis/const-evaluator.ts
  - packages/quereus/src/planner/nodes/values-node.ts
  - packages/quereus/src/planner/framework/pass.ts
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/test/logic/85-relational-const-folding.sqllogic
  - packages/quereus/test/optimizer/relational-const-folding.spec.ts
  - docs/optimizer-const.md
  - docs/optimizer.md
----

## Summary

Constant relational subtrees (all-literal VALUES, constant subqueries, deterministic TVF calls with constant args) are now replaced with `TableLiteralNode` during Pass 0 constant folding. Uses a deferred materialization pattern via `MaterializingAsyncIterable` that keeps the optimizer synchronous — first iteration runs a mini-scheduler and caches all rows; subsequent iterations yield from cache.

### Key components
- **`MaterializingAsyncIterable`** — self-caching async iterable wrapping deferred scheduler execution
- **`createRuntimeRelationalEvaluator`** — factory producing relational node replacements as `TableLiteralNode`
- **`TableLiteralNode.predefinedAttributes`** — preserves attribute IDs across folding so parent `ColumnReference` nodes continue resolving
- **Border detection** — recurses through void-type const nodes (e.g. Block) to find inner foldable scalar/relational nodes

## Review findings

- **Fixed:** `replaceBorderNodes` was calling the scalar evaluator for ALL border nodes (including relational ones) before branching on type class. The scalar evaluator result was discarded for relational nodes. Restructured to check type class first, avoiding wasteful evaluation.
- **Fixed:** `ConstInfoConst` interface in `docs/optimizer-const.md` showed `value: SqlValue` but implementation stores `node: PlanNode`. Corrected the docs.
- Code is well-structured: clean separation between classification, border detection, and replacement phases.
- `Scheduler.run()` is stateless per invocation, so reusing a scheduler instance in `MaterializingAsyncIterable` is safe.
- `MaterializingAsyncIterable` correctly guards against concurrent materialization via the `materializing` promise.
- Non-deterministic and mutating nodes are never folded (guarded by `isFunctional` check).

## Testing

- 11 sqllogic tests (`85-relational-const-folding.sqllogic`): VALUES folding, constant subqueries, non-folding table refs, mixed joins, nulls, booleans, repeated execution
- 6 plan-level optimizer tests (`relational-const-folding.spec.ts`): plan shape verification, attribute ID stability, correct results, repeated execution
- Updated TVF sqllogic expectations (`03.5-tvf.sqllogic`) for folded inner plans
- Full suite: 277 passing, 1 pre-existing failure (08.1-semi-anti-join)
