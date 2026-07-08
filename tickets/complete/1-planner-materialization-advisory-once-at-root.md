description: The optimizer step that decides where to cache intermediate query results now runs once over the whole plan instead of many times, and lets real errors surface instead of swallowing them; reviewed and confirmed correct.
files: packages/quereus/src/planner/framework/pass.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/cache/materialization-advisory.ts, packages/quereus/src/planner/cache/reference-graph.ts, packages/quereus/test/plan/materialization-advisory-single-pass.spec.ts, docs/optimizer.md
difficulty: medium
----

## Summary

The **materialization advisory** (injects `CacheNode`s so shared/looped relational subtrees are materialized-and-replayed instead of recomputed) was refactored from **12 per-anchor-type rewrite rules** fired during the bottom-up PostOptimization pass into a **single custom-`execute` pass** (`PassId.Materialization`, order 35, between PostOptimization=30 and Validation=40) that builds one reference graph over the whole plan and walks it once. Two catch-all `try/catch`-return-null blocks that masked bugs were removed; a latent exponential re-walk in `reference-graph.ts` was fixed in passing; the old `rule-materialization-advisory.ts` was deleted.

Implementation landed in `ea8664f7`. Review pass added one documenting `NOTE:` comment (below) — no behavior change.

## Review findings

### Checked

- **Equivalence of the reference-graph dedup fix (`visitAllChildren`).** Verified the old code visited every relational child twice (once via `getChildren()`, once via `getRelations() ⊆ getChildren()`), and because `buildReferences` never early-returns, each double-visit re-walked the child's whole subtree — 2^depth `buildReferences` calls along a linear relational spine. The new per-call `visited: Set` collapses this to one walk per distinct child. Confirmed behavior-preserving: parent counts are deduped by the global `refMap` parent `Set` (second visit with the same parent is a no-op increment), and both loops carry an identical `childContext`, so no `RefStats` field can change — only the redundant traversal is removed. The `getRelations()` loop is correctly retained as a deduped fallback for any node that overrides `getRelations()` to expose a relation absent from `getChildren()`. **Confirmed correct.**
- **Single-build invariant + the spy test.** Confirmed `ReferenceGraphBuilder` is constructed only by `MaterializationAdvisory`, which is constructed only by the new pass, so the prototype spy on `buildReferenceGraph` counts exactly the advisory's whole-tree walks per optimize. The spy restores the original method in a `finally`. Assertions (trivial plan → 1, many-anchor plan → 1, 4-CTE+2-IN → 1 constant not O(anchors)) are the load-bearing regression guard against reintroducing per-node firing. **Confirmed.**
- **Pass ordering.** The advisory now runs *after* PostOptimization (so it observes CacheNodes injected by `cte-optimization` / `in-subquery-cache` and skips `nodeType === Cache` to avoid double-wrapping) and *before* Validation (order 40). No PostOptimization rule depends on running after cache injection. Custom `execute` clears `optimizedNodes` before running like every other pass. **Confirmed no regression.**
- **Local→global parent-count switch.** One root walk gives global sharing counts, strictly ≥ the old per-anchor-subtree-local counts, so the new pass caches a superset. CacheNode is a transparent run-once fence, so a superset is correctness-preserving. No golden-plan or logic-test expectation needed editing — the switch was exercised and found benign, not merely untested. **Confirmed.**
- **Error propagation.** The two swallowing catches in `reference-graph.ts` and the deleted rule's catch-all are gone; advisory exceptions now surface as planning errors instead of silently disabling caching. Full suite exercises no plan where `getChildren()`/`getRelations()`/`withChildren()` throws, so this intended behavior change is dormant on the current corpus. **Confirmed as intended trade.**
- **Docs.** `docs/optimizer.md` gained the "Pass 3.5" subsection and the rules index now lists `MaterializationAdvisory` as a whole-tree pass, not a per-node rule. Accurate. Minor imprecision left as-is: it appears under the `rules/` family header though the class lives in `src/planner/cache/`, but the prose explicitly says "not as a per-node rule," so no reader is misled.
- **Lint + tests.** `yarn workspace @quereus/quereus lint` clean (eslint + `tsc -p tsconfig.test.json`). `yarn workspace @quereus/quereus test` → **6500 passing, 0 failing, 9 pending**.

### Found / done

- **Minor (fixed inline): inconsistent exception handling in `transformChildren`.** The refactor removed the swallow-and-log catches in `reference-graph.ts` (per "let real errors surface") but left one in `materialization-advisory.ts` `transformChildren` — its `try/catch` around `withChildren` logs and returns the *untransformed* node, discarding every CacheNode under that subtree on failure. This is genuinely perf-only (an uncached subtree still computes correct results, and it logs), so swallowing is defensible — but the diff makes the inconsistency conspicuous. Added a `NOTE:` comment at the site documenting why it swallows and when to promote it to a throw. No behavior change.

### Tripwire (parked, not a ticket)

- **Advisory runs unconditionally once per optimize** — even a plan with zero cacheable nodes pays one reference-graph build. Not a regression (the Block anchor always triggered ≥1 build before); recorded here so it isn't mistaken for new overhead. If reference-graph construction ever shows up as hot on tiny plans, gate the pass on the plan containing at least one relational node with >1 parent. No code site owns this cleanly, so it lives here.

### Not found

- **No correctness defects, no type-safety gaps, no resource-cleanup issues.** The spy test's prototype patch is the only global mutation and it is `finally`-restored. No new `any`, no swallowed exceptions beyond the documented perf-only one above.
