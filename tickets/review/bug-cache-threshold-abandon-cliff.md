description: The row cache used to throw away a cached sub-result once it passed about 1,000 rows and then re-run the source for every outer row, which made large nested-loop joins quadratic and re-ran the writes of an `insert … returning` used as a join input. The cache now keeps buffering and only logs a warning past its size limit; review that change.
architecture: docs/runtime-caching.md#cachenode-row-cache-lifetime
files: packages/quereus/src/runtime/cache/shared-cache.ts, packages/quereus/src/runtime/emit/cache.ts, packages/quereus/src/planner/framework/characteristics.ts, packages/quereus/src/planner/cache/materialization-advisory.ts, packages/quereus/src/planner/rules/cache/rule-scalar-subquery-cache.ts, packages/quereus/src/planner/rules/cache/rule-nested-loop-right-cache.ts, packages/quereus/src/planner/rules/cache/rule-mutating-subquery-cache.ts, packages/quereus/src/planner/optimizer-tuning.ts, packages/quereus/src/planner/nodes/cache-node.ts, packages/quereus/src/planner/rules/subquery/rule-subquery-decorrelation.ts, packages/quereus/test/runtime/cache.spec.ts, packages/quereus/test/vtab/nested-loop-right-cache-scan-count.spec.ts, packages/quereus/test/vtab/scalar-subquery-cache-scan-count.spec.ts, packages/quereus/test/vtab/in-subquery-cache-scan-count.spec.ts, packages/quereus/test/optimizer/characteristics.spec.ts, packages/quereus/test/plan/joins/theta-nlj-right-cache.plan.json, packages/quereus/test/logic/01.9-query-expr-dml.sqllogic, docs/runtime-caching.md
repro: verified
----

## What changed

`CacheNode` (runtime: `streamWithCache` in `runtime/cache/shared-cache.ts`) buffers its source on the first pass and replays it on later passes. It used to drop the buffer when it reached `threshold` rows and re-run the source on every later pass. That state (`cacheAbandoned`, both abandon branches, `getCacheMetrics().isAbandoned`) is gone.

- **Runtime (soft guard).** Both build modes (streaming-first and eager) push every row through one helper, `bufferRow`. When the buffer first grows past `threshold`, it logs one line on `quereus:runtime:cache:shared:warn` and keeps buffering. A source that a consumer drains runs at most once per execution, at any size. The helper carries the `NOTE:` that buffers are unbounded, like hash-join builds and CTE materialization. The replay loop carries the `NOTE:` about copying each row on every replay. `CacheStrategy` / `SharedCacheConfig` docs now say that `'spill'` is not yet acted on.
- **Threshold formula.** `CachingAnalysis.getCacheThreshold(node, tuning)` = `thresholdForEstimate(estimatedRows, tuning)` = `max(ceil(E × join.cacheThresholdMultiplier), 1000)`, with no upper cap. The old formula was `min(max(E × 0.1, 1000), 100000)`. All three cache rules and the materialization advisory use it now. The advisory's private `calculateThreshold` (capped at 10k, or 20k for spill) is deleted.
- **Tuning.** `join.maxCacheThreshold` and the whole `cte` block (`cte.maxCacheThreshold`) are removed from `OptimizerTuning` / `DEFAULT_TUNING`. No package outside `packages/quereus` referenced them (checked with grep).
- **Comments.** I updated the stale "pass-through" / "abandon" wording in `cache-node.ts`, `rule-nested-loop-right-cache.ts`, `rule-subquery-decorrelation.ts`, and the `buffered(...)` read-ahead comment in `emit/cache.ts`. I left the `plan.threshold > 50000` read-ahead condition as it was. It now fires when the estimate is above 25,000 rows, and it never fires on a misestimate found at runtime.
- **Docs.** `docs/runtime-caching.md` has a new "Run once, at any size" paragraph under § CacheNode row-cache lifetime. The eager-mode sentence and the IN-set-probe history sentence are corrected.

## Tests

- `test/logic/01.9-query-expr-dml.sqllogic` § 6b (new): a FROM-position `insert … returning` on the right side of a theta nested-loop join, with 1,500 source rows and 3 outer rows. It asserts `count = 4500` and that the target holds 1,500 rows. This is the bug reproduction. Against the HEAD build it failed with `UNIQUE constraint failed: nl_w PK.` (I checked the same SQL against `dist` before editing).
- `test/vtab/nested-loop-right-cache-scan-count.spec.ts` "scans an un-analyzed right table of over 1,000 rows once" (new): 5 outer rows over a 1,500-row right table with no `analyze`. It asserts the right table is scanned once. I confirmed from the HEAD debug log that this exact shape puts `CACHE (memory, threshold=1000)` on `r` and abandons the cache, so the old code scans `r` 5 times.
- `test/runtime/cache.spec.ts`: one streaming test and one eager test replace the four abandon tests. In each, past the threshold every row is delivered, and a second pass with an empty source replays the full buffer. The boundary test ("exactly threshold rows keeps cache") folded into these. The `cacheAbandoned` / `isAbandoned` assertions are dropped from the other tests.
- Deleted `scalar-subquery-cache-scan-count.spec.ts` "re-scans per outer row when the inner exceeds the cache threshold". It pinned the old behaviour through `cte.maxCacheThreshold: 0`.
- **Deviation from the plan:** I deleted the whole `in-subquery-cache-scan-count.spec.ts` "scans once regardless of the (now-irrelevant) cache threshold" test instead of only dropping its override line. Without the override it was an exact duplicate (same data, same SQL, same assertion) of "scans the subquery source exactly once when every outer row matches" in the same file.
- `test/optimizer/characteristics.spec.ts`: call signature only.
- `test/plan/joins/theta-nlj-right-cache.plan.json`: regenerated with `UPDATE_PLANS=true yarn test:plans`. The only change is `threshold` going from 1000 to 2000 (default estimate 1000 × multiplier 2).

## Validation run

- `yarn workspace @quereus/quereus run lint`: clean (eslint plus the test-file type check).
- `yarn test`: all workspaces pass (quereus 11141 passing, 26 pending, 0 failing). The log is in `tickets/.logs/bug-cache-threshold-abandon-cliff.test.log`.
- `yarn test:store` was not run.

## For the reviewer: known gaps and things to check

- **Early-stopping consumers still re-run the source.** In streaming-first mode, a consumer that stops early (a semi or anti nested-loop `break`, a `limit`) leaves nothing committed, so the next pass re-runs the source. This was already true before and was not changed. It is fine for read-only sources. For a DML source wrapped by `rule-mutating-subquery-cache`, a semi or anti join whose right side is a FROM-position DML would re-fire writes until one outer row drains it. I did not check whether such a plan can actually be built (the DML-bearing subquery paths may never decorrelate into a semi join). If it can, the fix is for that rule to set `eager: true`. It is worth a look.
- **The 50,000-row size gate stays.** The nested-loop rule still refuses to cache a right side estimated above `join.maxRightRowsForCaching` (50,000). That gate is estimate-based and was out of scope. With unbounded buffers elsewhere, refusing to cache now means N full scans of a big table where one buffer would do. That is a separate decision.
- **Warning message.** It reads "estimate was low", which is true by construction: the threshold is a multiple of the estimate, floored at 1000. The 1000-row floor means small estimates warn only past 1,000 rows.
- **`thresholdForEstimate` is public static** on `CachingAnalysis` so the advisory can call it with its reference-graph estimate (it has no node, only `RefStats.estimatedRows`).
