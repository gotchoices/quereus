description: The optimizer step that decides where to cache intermediate query results currently re-analyzes the whole plan many times over (slow on big statements) and hides its own crashes; make it run once over the plan and let real errors surface.
files: packages/quereus/src/planner/rules/cache/rule-materialization-advisory.ts, packages/quereus/src/planner/cache/materialization-advisory.ts, packages/quereus/src/planner/cache/reference-graph.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/framework/pass.ts
difficulty: medium
----

## Summary

The **materialization advisory** decides where in a query plan it is worth caching (materializing) an intermediate relation. Today it is registered as a rewrite rule on **12 node types** and runs during the bottom-up PostOptimization pass, so it fires once per matching node — and each firing rebuilds a reference graph over the whole subtree beneath it. On statement-heavy plans that is O(n²)-flavored planning work. It also wraps its body in a catch-all `try/catch` that turns any internal error into `return null` ("no advice"), masking bugs and violating the project's no-silent-exceptions rule.

Restructure so the advisory runs **once, at the plan root**, walking the tree a single time, and let unexpected errors propagate.

## Why one root pass is equivalent (coverage proof)

The advisory's transform (`materialization-advisory.ts` `transformTree`/`transformChildren`) recurses through `node.getChildren()`. For relational nodes `getRelations()` is a **subset** of `getChildren()` (see `reference-graph.ts:144` and the base-class definitions in `plan-node.ts` — e.g. `UnaryRelationalBase.getChildren` returns `[source]`, same as `getRelations`). So a single `analyzeAndTransform(planRoot)`:

- builds **one** reference graph over the entire plan (parent counts are then global, which is strictly more correct than the current per-anchor-subtree-local counts — multi-parent sharing that spans two anchors is currently under-counted), and
- walks every descendant via `getChildren()`, wrapping each recommended relational node with `CacheNode` and rewiring parents through `withChildren`.

The 12 non-relational "seam" anchors (`Block`, `ScalarSubquery`, `Exists`, `In`, `Insert`, `Update`, `Delete`, `CTE`, `RecursiveCTE`, `Returning`, `ScalarFunctionCall`, `CaseExpr` — `optimizer.ts:960`) are just entry points into relational subtrees; a root-level call subsumes all of them. No anchor reaches a node a whole-tree `getChildren()` walk misses.

> NOTE: `transformChildren`'s comment (materialization-advisory.ts:258-263) claims it returns the node as-is when "no scalar children changed" and leaves relational children to other rules. That comment is **stale** — `getChildren()` already includes relational children, so a changed relational grandchild propagates up through `withChildren`. Behavior is correct; the comment misleads. Fix the comment while you're in there.

## Current redundancy (mechanism)

- Pass framework fires rules per node keyed on `rule.nodeType === currentNode.nodeType` (`pass.ts:508 applyPassRules`), bottom-up, over the PostOptimization pass.
- `ruleMaterializationAdvisory` (rule file:51-68): for each relational child calls `advisory.analyzeAndTransform(child)` — a full reference-graph build over that child's subtree — **discards** the transformed child (keeps only an `anyTransformed` flag), then if anything changed re-runs `analyzeAndTransform(node)` over the whole node subtree. So the probe loop is pure wasted work, and the real transform re-walks the subtree.
- With 12 anchor types firing on a plan that stacks/repeats relational operators (large multi-CTE, multi-join, multi-statement block), total advisory work grows quadratically in node count. The `Block` root anchor alone re-walks the entire plan; each nested anchor re-walks its own subtree.

## Target design

Run the advisory **once** via a dedicated optimization pass with a custom `execute` (mirror `createConstantFoldingPass`, `pass.ts:104-122`), instead of 12 rule registrations:

- New pass id (e.g. `PassId.Materialization`), `order` **between PostOptimization (30) and Validation (40)** — e.g. 35. It must run *after* PostOptimization so it observes the `CacheNode`s already injected by `cte-cache` and `in-subquery-cache` (the advisory skips `nodeType === Cache`, `materialization-advisory.ts:90` — double-wrapping avoided only if it runs last).
- The pass's `execute(plan, context)` builds one `MaterializationAdvisory(context.tuning)` and returns `advisory.analyzeAndTransform(plan)`. No per-node-type dispatch; traversal order is irrelevant for a custom-execute pass.
- Delete the 12-entry `nodeTypesForMaterialization` loop in `optimizer.ts:960-993`. `ruleMaterializationAdvisory` and its 12 `RuleHandle` registrations go away; move the surviving logic into the pass `execute` (or a thin wrapper). Keep the existing side-effect-soundness comment (the `CacheNode` run-once-fence argument) attached to the new pass — a custom execute bypasses `sideEffectMode` validation, so the reasoning must live in a comment, not a handle field.

### Error handling

- Remove the catch-all `try/catch` at `rule-materialization-advisory.ts:43-76`. The **expected** "nothing to cache" outcome is already modeled: `analyzeAndTransform` returns the root unchanged when `recommendations.size === 0` (materialization-advisory.ts:64-67). That path needs no exception. Any thrown error is now **unexpected** and must propagate.
- Secondary swallows in `reference-graph.ts` `visitAllChildren` (132-141 catch around `getChildren()`, 148-159 catch around `getRelations()`) also convert internal failures to a silent skip. These violate the same rule. Decide per the no-silent-exceptions policy: either let them propagate, or narrow to a genuinely-expected condition with a logged reason. At minimum they must not silently drop a subtree from the reference graph (which would silently suppress caching). Recommend removing the catch entirely — `getChildren()`/`getRelations()` throwing is a real bug, not an expected state.

## Investigation notes (already done, for the implementer)

- Confirmed `getRelations() ⊆ getChildren()` across base classes and node types (searched: `UnaryRelationalBase`, `BinaryRelationalBase`, `InNode`, `CTENode`, subquery). Root walk reaches all.
- Confirmed the pass framework keys rules strictly on `nodeType` and offers a custom-`execute` escape hatch (constant-folding uses it). This is the mechanism for "run once at root."
- Confirmed the advisory is idempotent-safe to run last: it skips already-`Cache` nodes and non-deterministic/correlated nodes (`adviseCaching` rules 1-3, materialization-advisory.ts:79-108).

## TODO

- Add a dedicated materialization pass (`PassId.Materialization`, order 35) to `STANDARD_PASSES` / pass framework with a custom `execute` that calls `advisory.analyzeAndTransform(plan)` exactly once. Carry over the side-effect-soundness comment from `optimizer.ts:982-991`.
- Delete the `nodeTypesForMaterialization` loop and the 12 `materialization-advisory-<type>` registrations in `optimizer.ts:960-993`.
- Delete `ruleMaterializationAdvisory` (whole `rule-materialization-advisory.ts`) or reduce it to the pass's `execute` body — no `try/catch` that returns `null`; let unexpected errors throw.
- Remove the swallowing `try/catch` blocks in `reference-graph.ts` `visitAllChildren` (or narrow + log per policy); a failed child/relation fetch must not silently drop a subtree.
- Fix the stale comment in `materialization-advisory.ts` `transformChildren` (258-263) that claims relational children are left untouched.
- **Quantify the win before/after.** Add or extend a plan test that stacks many relational operators (large multi-CTE or multi-statement block) and assert linear-ish advisory cost — e.g. count reference-graph builds (instrument `ReferenceGraphBuilder.buildReferenceGraph` call count via a test hook or spy) and assert it is 1 for the whole optimize, versus O(anchors) today. Relevant existing coverage to keep green: `test/plan/cte-materialization.spec.ts`, `test/logic/07.7-in-subquery-caching.sqllogic`, `test/logic/49-reference-graph.sqllogic`.
- Run `yarn workspace @quereus/quereus test` and `yarn lint`. Watch especially the caching/CTE/in-subquery plan tests for any placement differences caused by the switch from per-anchor-local to global parent counts — if a cache placement changes, decide whether the global count is the correct behavior (it should be) and update the expectation with a note, rather than reverting.
- Update `docs/optimizer.md` if it documents the advisory as a multi-anchor rule.
