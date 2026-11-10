description: When a cached sub-result grows past about 1,000 rows, the row cache throws it away and re-runs the source once per outer row. That makes larger nested-loop joins quadratic, and it re-runs the writes of an `insert … returning` used as a join input, so those statements fail or write twice. The cache should keep its buffer and treat the size limit as a warning, not a cut-off.
architecture: docs/runtime-caching.md#cachenode-row-cache-lifetime
files: packages/quereus/src/runtime/cache/shared-cache.ts, packages/quereus/src/runtime/emit/cache.ts, packages/quereus/src/planner/framework/characteristics.ts, packages/quereus/src/planner/cache/materialization-advisory.ts, packages/quereus/src/planner/rules/cache/rule-scalar-subquery-cache.ts, packages/quereus/src/planner/rules/cache/rule-nested-loop-right-cache.ts, packages/quereus/src/planner/rules/cache/rule-mutating-subquery-cache.ts, packages/quereus/src/planner/optimizer-tuning.ts, packages/quereus/test/runtime/cache.spec.ts, packages/quereus/test/vtab/scalar-subquery-cache-scan-count.spec.ts, packages/quereus/test/vtab/nested-loop-right-cache-scan-count.spec.ts, packages/quereus/test/optimizer/characteristics.spec.ts, packages/quereus/test/plan/joins/theta-nlj-right-cache.plan.json, packages/quereus/test/logic/01.9-query-expr-dml.sqllogic, docs/runtime-caching.md
repro: verified
----

## What is wrong

`CacheNode` (emitted by `runtime/emit/cache.ts` and driven by `streamWithCache` in `runtime/cache/shared-cache.ts`) buffers its source's rows on the first pass and replays them on later passes. It carries a row `threshold`. Today, when the buffer reaches the threshold, it is thrown away (`cacheAbandoned = true`), and every later pass re-runs the source (`yield* sourceIterable`).

The threshold comes from `CachingAnalysis.getCacheThreshold` (`planner/framework/characteristics.ts:491`):

```
min(max(estimatedRows * 0.1, 1000), 100000)
```

Multiplying by 0.1 means a result abandons when it reaches 10% of its own estimate, so even accurate statistics do not help. With no statistics the default estimate is 1000 rows, so the threshold is 1000.

### Reproduced (2026-11-10, against `packages/quereus/dist` at HEAD)

Slowdown: a theta nested-loop join, 20 outer rows over a 1,500-row right table (and again over 5,000 rows after `analyze`):

```sql
create table a (x integer primary key);
create table b (y integer primary key);
-- a: 1..20, b: 1..1500 (or 1..5000 + analyze)
select count(*) as c from a join b on a.x + b.y > 0;
```

The plan shows `CACHE (memory, threshold=1000)` in both cases. With `DEBUG=quereus:runtime:cache:shared` the log shows one build that hits the threshold at row 1000, then 19 "cache abandoned … streaming directly" lines, so the right table is scanned once per outer row (20 scans instead of 1).

Wrong result: a write in join position, from `rule-mutating-subquery-cache`:

```sql
create table a (x integer primary key);           -- 3 rows
create table src (k integer primary key);         -- 1500 rows
create table w (k integer primary key);
select count(*) as c from a join (insert into w (k) select k from src returning k) as d on a.x + d.k > 0;
```

With 500 source rows it returns `c = 1500` and leaves 500 rows in `w`, which is correct. With 1,500 rows it fails with `UNIQUE constraint failed: w PK.`, because the second outer row re-runs the insert. Against a table where the re-insert does not collide (for example `insert or replace`, or any write that is not idempotent), the writes would happen once per outer row. This breaks the run-once rule for writing subqueries that `docs/runtime.md` § Impure subquery emitters and `test/logic/01.9-query-expr-dml.sqllogic` require.

### Ruled out

- **Scalar subquery cache** (`rule-scalar-subquery-cache`): the original ticket listed it as affected, but a valid scalar subquery yields at most one row, and more than one is an error (`runtime/emit/subquery.ts:86`). A real threshold of 1 or more never abandons there. Only the test override in `scalar-subquery-cache-scan-count.spec.ts` (threshold 0) reaches the abandon path.
- **IN-subquery**: already moved off `CacheNode` (the set probe in `emitIn`).
- **Materialization advisory** (`planner/cache/materialization-advisory.ts` `calculateThreshold`): its formula is already a multiple of the estimate (`min(max(E*2, 1000), join.maxCacheThreshold)`). It still caps at 10,000 (20,000 for `'spill'`), so a shared subtree past the cap re-runs once per parent. That is the same runtime cliff, and the same runtime fix covers it.
- `'spill'` strategy: `streamWithCache` ignores `config.strategy`, and no spill exists. Choosing `'spill'` only raises the cap.

## Root cause and fix

There is one root cause: `streamWithCache` treats its threshold as a hard cap that throws the buffer away. The formula is a second defect at its own site. The fix has two parts.

### Part 1: the threshold becomes a soft guard (`runtime/cache/shared-cache.ts`)

Past the threshold, keep buffering. Log once through a `warn` sub-logger (`log.extend('warn')`, the project's pattern, see `core/database.ts:88`), giving the cache name, threshold, and row count, and commit the full buffer as usual. Remove the abandoned state completely: the `cacheAbandoned` field, the `state.cacheAbandoned` pass-through branch, the eager-path abandon branch, and `isAbandoned` in `getCacheMetrics`. Every cached source then runs at most once per execution, whatever its size.

Why this choice, against the other options:

- **Keep buffering (recommended).** The behaviour is the same at every size: a later pass always sees the first pass's rows, so self-referencing statements no longer switch from snapshot to live re-read at an arbitrary size. It also fixes the write-in-join bug at the place where the bug happens. The engine already buffers without a limit in several places: hash and bloom join build sides (`runtime/emit/bloom-join.ts`), shared-CTE materialization (`runtime/emit/cte.ts`), and the IN set probe. A memory cap on this one buffer protects nothing the engine does not already risk elsewhere. When the estimate is badly wrong, abandoning costs O(N × K) re-reads (N outer rows, K source rows), which for store-backed tables means N remote scans. That is worse than holding K rows.
- **Spill to disk.** No spill exists in the engine. Building one is a separate feature, which would cover every unbounded buffer, not just this one.
- **Abandon only when the source is cheap to re-run.** This keeps the size-dependent switch in behaviour and still needs a special case for writing sources. Rejected.

Add a `NOTE:` at the buffer-growth site: buffers are unbounded, like hash-join builds and CTE materialization. If memory pressure from large buffers ever shows up, the answer is a shared memory budget or spill for all of them, not a cap on this one. Also update the `SharedCacheConfig.threshold` doc comment ("Maximum rows before abandoning cache") to the new meaning, and `CacheStrategy` / `strategy` to say that `'spill'` is not yet acted on.

`runtime/emit/cache.ts` wraps the source in `buffered(...)` when `plan.threshold > 50000`. Keep that as it is, but check that it still reads sensibly against the new threshold values.

### Part 2: one correct threshold formula (`planner/framework/characteristics.ts`)

The threshold now only sets when the misestimate warning fires, so it should mean "the result is a guard multiple larger than its estimate":

```
getCacheThreshold(node, tuning) = max(ceil(estimatedRows * tuning.join.cacheThresholdMultiplier), 1000)
```

Pass `tuning` in from each caller. All three rules have `context.tuning`; `rule-mutating-subquery-cache` currently names it `_context`. Change `MaterializationAdvisory.calculateThreshold` to call the same helper, which removes the duplicate formula. Drop the upper caps: with soft-guard semantics a cap only makes the warning fire on correctly estimated large results. After that, `join.maxCacheThreshold` and `cte.maxCacheThreshold` are unused. Remove them from `OptimizerTuning` / `DEFAULT_TUNING`, and remove the `min(…, cte.maxCacheThreshold)` in `rule-scalar-subquery-cache`. Their only test users are the two overrides listed under Tests. The `cache.spillThreshold` / `spillEnabled` strategy selection can stay. Update the comment in `rule-nested-loop-right-cache.ts:236` ("degrades to pass-through past its limit"), which is no longer true.

## Tests

- **Bug reproduction (required).** In `test/logic/01.9-query-expr-dml.sqllogic`, add the write-in-join case above: a FROM-position `insert … returning` on the right side of a theta nested-loop join, with more than 1,000 source rows (build them with `generate_series`), and 2–3 outer rows. Assert the join count and that the target table holds exactly the source row count. It fails today with the UNIQUE error.
- **Slowdown reproduction.** In `test/vtab/nested-loop-right-cache-scan-count.spec.ts`, add one case with a right table over 1,000 rows and no `analyze`, and assert the scan count is 1 (it is the outer row count today). This is the scan-count harness the file already uses.
- `test/vtab/scalar-subquery-cache-scan-count.spec.ts` "re-scans per outer row when the inner exceeds the cache threshold" pins the old behaviour through `cte.maxCacheThreshold: 0`. Delete it. Do not invert it: the scalar case cannot exceed a real threshold, and the new runtime behaviour is covered by the cache unit test below.
- `test/vtab/in-subquery-cache-scan-count.spec.ts:116` overrides `cte.maxCacheThreshold: 2`. When that field is removed, drop the override line. The test asserts the set probe has no threshold, which stays true without it.
- `test/runtime/cache.spec.ts`: replace "threshold exceeded — cache abandoned", the "cache abandoned path" describe, "reports abandoned state", and the eager "over-threshold eager source abandons cache" test with one streaming test and one eager test: past the threshold, all rows are delivered and a second pass replays the full buffer without touching the source. Keep the boundary test only if it still checks something (it probably folds into the new test).
- `test/optimizer/characteristics.spec.ts:101`: update the call signature only.
- `test/plan/joins/theta-nlj-right-cache.plan.json:490`: the golden `threshold=1000` changes to the new value. Regenerate it with the plan golden update mechanism (see `test/plan/` README or spec harness), and do not hand-edit it.

## Docs

- `docs/runtime-caching.md` § CacheNode row-cache lifetime and § Eager vs. streaming-first build: replace "if the eager drain exceeds the cache threshold it abandons and streams the remainder through" with the soft-guard behaviour. State that every `CacheNode` source runs at most once per execution, and that the threshold only triggers a misestimate warning.
- Grep `docs/` for `maxCacheThreshold` / `cacheThreshold` / `threshold=` and fix any mentions.

## Out of scope (record as a tripwire, do not change)

The replay path copies every row on every pass (`yield [...row]`), costing rows × passes allocations. `cache.spec.ts` tests 66–95 deliberately require that a consumer changing a yielded row cannot corrupt the buffer, so removing the copy needs an audit of every consumer. Add a `NOTE:` at the replay site: "copies each row per replay; if replay allocation shows up in profiles, audit consumers for in-place row mutation and switch to frozen shared rows."

## TODO

- shared-cache.ts: remove the abandoned state and both abandon branches; past the threshold, keep buffering and log one warning; update the config/state doc comments; add the unbounded-buffer `NOTE:` and the replay-copy `NOTE:`.
- characteristics.ts: `getCacheThreshold(node, tuning)` = `max(ceil(E × cacheThresholdMultiplier), 1000)`, with no cap.
- Change the three cache rules and `MaterializationAdvisory.calculateThreshold` to use the helper; drop the scalar rule's `min(…, cte.maxCacheThreshold)`; fix the nested-loop rule's "pass-through" comment.
- optimizer-tuning.ts: remove `join.maxCacheThreshold` and `cte.maxCacheThreshold` (and the `cte` block if it is left empty; check `OptimizerTuning` consumers and `updateTuning` callers in other packages with `grep -rn "cte:" packages --include=*.ts`).
- Tests: add the write-in-join logic case and the over-1,000-row nested-loop scan-count case; rewrite the `cache.spec.ts` abandon tests; delete the scalar threshold-0 test; drop the IN-test override; update the characteristics call; regenerate the theta-nlj plan golden.
- Update `docs/runtime-caching.md`.
- Run `yarn workspace @quereus/quereus run lint` and `yarn test`.
