description: Review the fix that makes an "x IN (subquery)" subquery run once instead of re-running on every outer row that matches early.
files: packages/quereus/src/runtime/cache/shared-cache.ts, packages/quereus/src/runtime/emit/cache.ts, packages/quereus/src/planner/nodes/cache-node.ts, packages/quereus/src/planner/rules/cache/rule-in-subquery-cache.ts, packages/quereus/test/runtime/cache.spec.ts, packages/quereus/test/vtab/in-subquery-cache-scan-count.spec.ts, packages/quereus/test/plan/joins/theta-nlj-right-cache.plan.json, docs/runtime.md, docs/optimizer-rules.md
difficulty: medium

# Review: eager CacheNode build mode for IN-subquery cache

## What the bug was

`rule-in-subquery-cache` wraps an uncorrelated `x IN (subquery)` source in a
`CacheNode` so the subquery runs once and later outer rows replay from a buffer.
The runtime defeated it: `streamWithCache` used a *streaming-first* build — it
yielded each source row immediately and only committed the cache **after** the
`for await` loop drained the source to completion. But `emitIn` returns on the
**first matching row**, which aborts that generator mid-drain, so the cache was
never committed. While outer rows kept matching early, every outer row re-opened
the subquery source from scratch (one query-start per outer row on a
high-latency vtab). The buffer only landed after the first outer row that found
no match.

## What changed

An **eager** build mode on `CacheNode` / `streamWithCache`. In eager mode the
first evaluation drains the source fully and commits `cachedResult` (or abandons,
if over threshold) **before** yielding any row. A consumer that breaks on the
first row has therefore already caused the full drain + commit, so every later
evaluation replays from cache. `emitIn` is **untouched** — it keeps its
streaming early-exit and simply benefits from a cache populated on eval #1.

- `SharedCacheConfig.eager?: boolean` + eager first-time branch in
  `streamWithCache` (`shared-cache.ts`). Streaming-first branch left exactly
  as-is. Same deep-copy, threshold-abandon, and throw semantics as before.
- `CacheNode.eager` (default `false`), threaded through `withChildren`, surfaced
  in `toString` (` ,eager` suffix only when true) and `getLogicalAttributes`
  (`eager: <bool>` always).
- `emitCache` copies `plan.eager` into the config.
- `rule-in-subquery-cache` constructs its `CacheNode` with `eager: true`. It is
  the **only** eager setter — CTE, nested-loop-right, and mutating-subquery
  caches keep `eager` defaulted `false`, preserving their first-row latency.
- Golden plan `theta-nlj-right-cache.plan.json` gained `"eager": false` in the
  Cache node's logical attributes (that cache is a nested-loop-right cache, not
  eager). Hand-edited to match the alphabetically-sorted serializer; verified by
  `yarn test:plans`.
- Docs: `docs/runtime.md` § "CacheNode row-cache lifetime" gained an
  eager-vs-streaming-first paragraph; `docs/optimizer-rules.md` one-liner
  updated.

## How to validate

- **Full suite:** `yarn workspace @quereus/quereus test` → **7054 passing, 13
  pending, 0 failing** on this branch.
- **Lint/typecheck:** `yarn workspace @quereus/quereus run lint` → exit 0, clean
  (eslint + `tsc -p tsconfig.test.json --noEmit`).
- **Targeted:**
  `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/runtime/cache.spec.ts" "packages/quereus/test/vtab/in-subquery-cache-scan-count.spec.ts"`

### Tests added

`test/runtime/cache.spec.ts` → new `eager build mode` describe:
- **Consumer that breaks after the first row still populates the cache** — the
  exact case that fails under the default streaming config. Uses a counting
  source to prove all 3 rows were pulled despite the early break.
- Later consumer replays the full committed buffer (empty source proves cache).
- Empty eager source commits `[]`.
- Over-threshold eager source → `cacheAbandoned === true`, `cachedResult`
  undefined, all rows still delivered.
- Deep-copy: mutating a yielded row leaves `cachedResult` intact — build pass
  and replay pass.
- Source throws mid eager-drain → throws, `cachedResult` undefined,
  `cacheAbandoned === false`, and a subsequent good source builds cleanly.

`test/vtab/in-subquery-cache-scan-count.spec.ts` (new, models
`cte-multi-reference-scan-count.spec.ts`, uses `CountingMemoryModule`):
- **Every outer row matches → `scanCounts.get('counting') === 1`** (headline
  regression).
- Leading NULL-condition outer row (nullable `probe.x`, NULL first) → still `1`
  (a NULL IN-expression makes `emitIn` return NULL without iterating the source).
- Over-threshold (`cte.maxCacheThreshold` tuned to 2, source has 3 rows) →
  abandoned cache re-scans once per outer row → `=== 3` (intentional N;
  documented in-test).
- Prepared-statement re-execution → each of two runs scans once (fresh eager
  build per `RuntimeContext`, never zero on the second).

## Known gaps / where to look hard (your tests are a floor)

- **No same-test before/after contrast for the integration scan-count.** The
  integration spec asserts the post-fix `=== 1`; the real optimizer now always
  sets `eager: true`, so there's no easy in-test toggle to demonstrate the old
  N-scan behavior. The *mechanism* is proven at the unit level (the "breaks
  after first row" eager test vs. the untouched streaming path). If you want a
  regression guard that would catch a silent revert of `eager: true` in the
  rule, consider asserting on the plan shape (`CacheNode` with `eager: true`
  above the IN source) rather than only the scan count.
- **NULL-membership through the cached path is only covered indirectly.** The
  ticket's edge-case list included `x IN (subquery yielding NULLs)` returning
  NULL vs TRUE (three-valued logic). I did **not** add an explicit SQL-logic
  assertion for that through the eager cache. Rationale: `emitIn`'s `hasNull`
  logic is unchanged and reads the replayed buffer, and eager drain doesn't alter
  per-row values — but this is an assertion I leaned on rather than pinned. A
  short logic test (`select ... where x in (select k from t)` where `t` yields
  NULLs, one no-match → NULL, one match → TRUE) would close it.
- **Over-threshold eager yields the buffered *copies* to the consumer** (`for
  (const buffered of buffer) yield buffered`), where the streaming-first path
  yields the original source rows. Because the cache is abandoned in that branch
  there is nothing to corrupt, and values are equal — but the row *identity*
  differs from the streaming path. I judged this harmless (no consumer relies on
  cache-yielded row identity). Worth a second opinion.
- **Out of scope (by ticket):** building a `BTree` membership set inside
  `emitIn` for O(log K) probes instead of the cache's O(K) linear replay. It's a
  real optimization but a strictly bigger change with a correlated-IN correctness
  trap; the rule's docstring already accepts linear replay.

## Tripwires recorded (not tickets)

None filed as tripwires. The two doc-worthy nuances above (no in-test
before/after; buffered-copy identity in the abandon branch) are captured here in
findings and in code comments at the sites; neither is a conditional-future
concern that needs a `NOTE:` tag.

## Pre-existing failures

None surfaced. Full suite was 0-failing before and after (the one golden that
flipped was a direct, expected consequence of adding `eager` to
`getLogicalAttributes`, and is updated in this diff).
