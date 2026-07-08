description: The optimizer step that decides where to cache intermediate query results was re-analyzing the whole plan many times over and silently swallowing its own crashes; it now runs once over the plan and lets real errors surface.
files: packages/quereus/src/planner/framework/pass.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/cache/materialization-advisory.ts, packages/quereus/src/planner/cache/reference-graph.ts, packages/quereus/test/plan/materialization-advisory-single-pass.spec.ts, docs/optimizer.md
difficulty: medium
----

## What changed

The **materialization advisory** (decides where to inject `CacheNode`s so intermediate relations are materialized/replayed instead of recomputed) was registered as a rewrite rule on **12 node types** and fired once per matching "seam" anchor during the bottom-up PostOptimization pass — each firing rebuilt a reference graph over its own subtree. It also wrapped its body in a catch-all `try/catch` returning `null` ("no advice"), masking bugs.

It now runs **once, at the plan root**, as a dedicated custom-`execute` optimization pass.

### Concrete edits

- **`framework/pass.ts`** — new `PassId.Materialization` and `createMaterializationPass()` (order **35**, between PostOptimization at 30 and Validation at 40). Its `execute` builds one `MaterializationAdvisory(context.tuning)` and calls `analyzeAndTransform(plan)` exactly once. The side-effect-soundness argument (CacheNode is a run-once fence; a custom execute bypasses `sideEffectMode` validation) is carried over as a doc comment on the factory. Added to `STANDARD_PASSES`.
- **`optimizer.ts`** — deleted the 12-entry `nodeTypesForMaterialization` loop and its `materialization-advisory-<type>` registrations; removed the `ruleMaterializationAdvisory` import; left a comment pointing at the new pass.
- **Deleted `rules/cache/rule-materialization-advisory.ts`** entirely (the `try/catch`-that-returns-null wrapper). The expected "nothing to cache" outcome is already modeled — `analyzeAndTransform` returns the root unchanged when `recommendations.size === 0` — so no exception is needed; any thrown error is now unexpected and propagates.
- **`cache/reference-graph.ts`** — removed the two swallowing `try/catch` blocks in `visitAllChildren`. **Also fixed a latent perf defect found while in there** (see below) by deduping to one visit per distinct child.
- **`cache/materialization-advisory.ts`** — fixed the stale `transformChildren` comment (it claimed relational children are left to other rules; in fact `getChildren()` already includes them, so a deeper `CacheNode` propagates up via `withChildren`). Renamed the now-misleading `scalarChanged`/`transformedScalarChildren` locals to `childrenChanged`/`transformedChildren` (they were never scalar-only).
- **`docs/optimizer.md`** — added a "Pass 3.5: Materialization Advisory" subsection and updated the rules index (no longer a per-node rule).

## Why one root pass is equivalent

`transformTree`/`transformChildren` recurse through `getChildren()`, and `getRelations()` is a strict subset of `getChildren()` (base `getRelations() = getChildren().filter(isRelationalNode)`; confirmed in `plan-node.ts` — `UnaryRelationalBase`/`BinaryRelationalBase` return the same relational children in both). So one `analyzeAndTransform(root)` walks every descendant the 12 anchors reached, and the single graph gives **global** parent counts (strictly more correct than the old per-anchor-subtree-local counts, which under-counted sharing spanning two anchors). Every top-level plan is a `BlockNode`, so the Block anchor already fired the advisory over the whole tree at least once before — the new pass is therefore **never worse** than before (was ≥1 builds, now exactly 1).

## Validation done

- `yarn workspace @quereus/quereus test` — **6500 passing, 0 failing, 9 pending**.
- `yarn workspace @quereus/quereus lint` — clean (eslint + `tsc -p tsconfig.test.json --noEmit`).
- New spec `test/plan/materialization-advisory-single-pass.spec.ts` — spies on `ReferenceGraphBuilder.prototype.buildReferenceGraph` and asserts **exactly 1 build** per `db.getPlan(...)` for (a) a trivial single-statement plan, (b) a many-anchor plan (Block + 2 CTEs + IN + EXISTS + scalar subquery + self-join), and (c) a 4-CTE + 2 IN plan (constant, not O(anchors)); plus an end-to-end result check that the single-pass restructure preserves semantics.
- Caching/CTE/in-subquery coverage the ticket called out stayed green with **no expectation edits**: `test/plan/cte-materialization.spec.ts`, `test/logic/07.7-in-subquery-caching.sqllogic`, `test/logic/49-reference-graph.sqllogic`, and the golden-plan sweep.

## Use cases to exercise (reviewer)

- **Run-once invariant**: the count spy is the load-bearing assertion. `ReferenceGraphBuilder` is only constructed by `MaterializationAdvisory`, only constructed by the new pass — so the spy count == advisory whole-tree walks per optimize. If a future change reintroduces per-node advisory firing, this test breaks. Confirm the spy actually restores the prototype method (it does, in `finally`).
- **Global vs local parent counts**: placement is now driven by global sharing counts. No test in the corpus caught a placement diff, but the change *is* theoretically observable — a relational node shared across two former anchors could now cross the multi-parent threshold and get cached where it previously would not. Worth a skim of whether any real workload wants the old local semantics (we believe global is correct).
- **Error propagation**: previously any advisory exception became "no caching"; now it throws. If some exotic node's `getChildren()`/`getRelations()`/`withChildren()` can throw on a valid plan, that will now surface as a planning error instead of silently skipping caching. The full suite exercised no such case, but this is the intended behavior change — verify it's the desired trade.

## Review findings

- **Latent perf defect fixed opportunistically (verify equivalence).** `reference-graph.ts` `visitAllChildren` visited relational children twice — once via the `getChildren()` loop, once via the `getRelations()` loop — and `buildReferences` never early-returns on an already-seen node, so a relational child's whole subtree was re-walked once per level: **exponential in the relational-spine depth** (2^depth `buildReferences` calls for a linear operator chain). I deduped to one visit per distinct child via a local `Set`. This is behavior-preserving because the parent `Set` already dedups parent counts and both loops carry the same `childContext` (so no `RefStats` field changes) — but it *is* a change beyond the ticket's literal "remove the try/catch" ask, so please confirm the equivalence argument (in particular that no node overrides `getRelations()` to expose a relation absent from `getChildren()`; the `getRelations()` loop is kept as a deduped defensive fallback for exactly that case).
- **Advisory now runs unconditionally once per optimize.** Even a plan with zero cacheable nodes pays one reference-graph build. This is not a regression (the Block anchor always triggered ≥1 build before), noted so it isn't mistaken for new overhead. Parked as knowledge here, not a ticket.
- **No cache-placement expectation changes were required** across the full corpus despite the local→global parent-count switch — flagged so the reviewer knows the switch was exercised and found benign by the existing goldens/logic tests, not merely untested.
