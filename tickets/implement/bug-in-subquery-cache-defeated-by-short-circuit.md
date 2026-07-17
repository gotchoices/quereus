----
description: Fix the cache meant to run an "x IN (subquery)" subquery once so it actually finishes building even when the query keeps finding matches early, instead of re-running the subquery from scratch on every outer row.
files: packages/quereus/src/runtime/cache/shared-cache.ts, packages/quereus/src/runtime/emit/cache.ts, packages/quereus/src/planner/nodes/cache-node.ts, packages/quereus/src/planner/rules/cache/rule-in-subquery-cache.ts, packages/quereus/test/runtime/cache.spec.ts, packages/quereus/test/vtab/_counting-memory-module.ts, packages/quereus/test/vtab/cte-multi-reference-scan-count.spec.ts
difficulty: medium
----

# Give CacheNode an eager build mode so short-circuiting consumers don't defeat it

## The bug

`ruleInSubqueryCache` (`rule-in-subquery-cache.ts`) wraps an uncorrelated
`IN (subquery)` source in a `CacheNode` so the subquery runs once and later
outer rows replay from the buffer. The runtime defeats it:

- `streamWithCache` (`shared-cache.ts:56-111`) uses a *streaming-first* pattern:
  it yields each source row immediately while appending to a private `cache`
  array, and only commits `state.cachedResult = cache` **after the `for await`
  loop drains the source to completion** (lines 104-110).
- `emitIn`'s pure streaming consumer (`emit/subquery.ts:161-184`) returns `true`
  on the **first matching row**, which terminates its `for await` over the cache
  iterable early. That aborts the generator mid-stream, so the drain never
  finishes and `cachedResult` is never set.

Result: while outer rows keep matching early, the cache never commits. Each
outer row re-opens the subquery source from scratch — one query-start per outer
row on a high-latency backend, exactly what the rule exists to prevent. The
buffer only lands after the first outer row that finds *no* match (that row
drains the source fully). Any short-circuiting consumer above a `CacheNode`
hits the same failure mode.

## The fix: eager build mode

Add an **eager** mode to the cache. In eager mode, on the first evaluation
`streamWithCache` drains the source fully into the buffer and commits
`cachedResult` (or abandons, if over threshold) **before** yielding any row to
the consumer. Then it yields from the committed buffer. Now even a consumer that
breaks on the first row has already caused the full drain + commit, so every
subsequent evaluation replays from cache. Source is opened exactly once.

This is the ticket's "eager-full-drain" candidate, scoped behind a flag so the
streaming-first behaviour that CTE / nested-loop-right / mutating-subquery
caches rely on (first-row latency) is unchanged. It matches how hash joins build
their side. `emitIn` is **not** touched — it keeps its streaming early-exit, and
simply benefits from a cache that is now populated on evaluation #1.

### Why eager on the cache, not a membership hash in emitIn

The alternative (drain the source into a `BTree` membership set inside `emitIn`
and probe it) is a strictly bigger change and carries a correctness trap:
`emitIn`'s pure streaming path also serves **correlated** IN subqueries, whose
membership set changes per outer row — memoizing there would return stale
results. The cache-level flag sidesteps this entirely: the flag is only set by
`ruleInSubqueryCache`, which already gates on *uncorrelated + functional*, and
`CacheNode` semantically guarantees identical replayed rows within one
execution. Building the membership set once (O(log K) probes instead of the
cache's O(K) linear replay) is a real but separate optimization — leave it out
of scope; the rule's own docstring already accepts `O(K + N * K_cached)` linear
replay.

### Data flow after the fix

```
ruleInSubqueryCache  ──emits──►  CacheNode(eager: true)
                                     │
emitCache reads plan.eager ─────────┤ config.eager = true
                                     ▼
streamWithCache(eager):  first eval → drain source fully → commit cachedResult
                                    → yield from buffer  (consumer may break early)
                         later evals → replay cachedResult  (source untouched)
```

## Interfaces / shape

`SharedCacheConfig` (`shared-cache.ts`) gains:

```ts
/** When true, fully drain + commit the buffer before yielding any row, so a
 *  short-circuiting consumer (e.g. IN early-exit) cannot abort the build. */
eager?: boolean;
```

`streamWithCache` first-time branch, eager path (sketch — preserve the existing
deep-copy, threshold, and throw semantics):

```ts
// eager: drain fully, commit, THEN yield — build cannot be short-circuited
const buffer: Row[] = [];
for await (const row of sourceIterable) {
    if (buffer.length < threshold) {
        buffer.push([...row] as Row);
    } else {
        // over threshold: abandon caching, stream the rest straight through
        state.cacheAbandoned = true;
        for (const b of buffer) yield b;   // already copies
        yield row;
        yield* sourceIterable;
        return;
    }
}
state.cachedResult = buffer;
for (const row of buffer) yield [...row] as Row;
```

(Keep the non-eager streaming-first branch exactly as-is. If the source throws
mid-drain, do **not** commit and do **not** set `cacheAbandoned` — same as
today, so the existing "source throws mid-stream" test still holds.)

`CacheNode` (`cache-node.ts`) gains a `readonly eager: boolean` constructor
param (default `false`), threaded through `withChildren`, surfaced in
`getLogicalAttributes` / `toString`. `emitCache` reads `plan.eager` into the
config. `ruleInSubqueryCache` constructs its `CacheNode` with `eager: true`.

## Edge cases & interactions

- **Match-heavy, within threshold (the reported bug):** eval #1 drains fully +
  commits; evals #2..N replay. Instrumented source scan count == 1. This is the
  headline regression test.
- **Over-threshold source:** eager buffers up to `threshold`, then abandons and
  streams the remainder through; each later eval streams fresh (scan count == N).
  Acceptable — threshold is the "too big to cache" signal; the memory bound
  wins. Note it in the test so the N is intentional, not a silent cap.
- **`condition === null`:** `emitIn` returns `null` *without* iterating `input`,
  so the cache generator never runs and no scan happens that eval. The cache
  builds lazily on the first eval that actually iterates — total scans still 1.
  Add a test with a leading null-condition outer row followed by matching rows.
- **Empty source:** `cachedResult = []` commits; IN yields `false`; replay yields
  nothing. Scan count == 1.
- **All-NULL / NULL-bearing source rows:** eager drain doesn't alter per-row
  values; `emitIn`'s `hasNull` three-valued logic is unchanged (it reads the
  replayed buffer). Cover `x IN (subquery)` where the subquery yields NULLs and
  no match → result NULL, and where it yields a match → TRUE.
- **Deep-copy correctness:** eager path must spread-copy rows into the buffer AND
  spread-copy again on yield, identical to the streaming path — otherwise a
  consumer mutating a yielded row corrupts the cache. Reuse the existing
  cache.spec deep-copy assertions against the eager path.
- **Source throws mid eager-drain:** no commit, `cacheAbandoned` stays false,
  error propagates; next eval retries fresh. Mirror the existing throwing-source
  test for eager mode.
- **Prepared-statement re-execution:** `CacheState` lives on
  `rctx.cacheStates`, rebuilt per execution — unchanged. A re-run gets a fresh
  eager build. No new work, but keep an assertion that two executions each scan
  the source once (not zero on the second).
- **Non-eager consumers unaffected:** CTE (`rule-cte-optimization`),
  nested-loop-right (`rule-nested-loop-right-cache`), and mutating-subquery
  (`rule-mutating-subquery-cache`) caches leave `eager` defaulted to `false`, so
  their streaming-first first-row latency is preserved. Confirm `withChildren`
  threads `eager` so an optimizer rebuild of an eager CacheNode doesn't silently
  drop the flag back to false.
- **`buffered()` / `traced()` wrappers** in `emitCache` sit *below* the eager
  drain (they wrap `sourceIterable`); eager drains the wrapped iterable — no
  interaction beyond what exists today.
- **Concurrent / re-entrant drive of the same cache:** the eager path is
  self-contained per `streamWithCache` call (it drains its own passed
  `sourceIterable`; the only shared mutable is `state.cachedResult` /
  `cacheAbandoned`, same as today) — no shared live iterator is introduced, so
  no new concurrency hazard.

## Tests

Key expected outputs to assert:

- **Unit (`test/runtime/cache.spec.ts`), new `eager` describe block:**
  - Consumer that breaks after the first row still populates `state.cachedResult`
    (the exact case that fails today with the default streaming config).
  - Next consumer replays the full committed buffer.
  - Over-threshold eager source → `cacheAbandoned === true`, `cachedResult`
    undefined, all rows still delivered to the consumer.
  - Deep-copy: mutating a yielded row leaves `cachedResult` intact (build pass
    and replay pass), eager config.
  - Throwing source mid eager-drain → throws, `cachedResult` undefined,
    `cacheAbandoned === false`, and a subsequent good source builds cleanly.
- **Integration scan-count (`test/vtab/`):** new spec modeled on
  `cte-multi-reference-scan-count.spec.ts`, using `CountingMemoryModule` from
  `_counting-memory-module.ts`. Populate a `countmem` table, run
  `select ... where x in (select k from counting)` over an outer relation where
  **every** outer row matches, and assert
  `module.scanCounts.get('counting') === 1`. Add the `condition === null`
  leading-row variant and confirm it is still 1. Add an over-threshold variant
  (tiny tuning threshold, or enough rows) and assert the intended N with a
  comment explaining why caching is intentionally off.

## TODO

### Phase 1 — cache runtime + node

- Add `eager?: boolean` to `SharedCacheConfig`; implement the eager first-time
  branch in `streamWithCache` (drain-commit-then-yield; preserve deep-copy,
  threshold-abandon, and throw semantics). Leave the streaming-first branch
  untouched.
- Add `readonly eager: boolean` (default `false`) to `CacheNode`; thread through
  `withChildren`, `getLogicalAttributes`, `toString`.
- Read `plan.eager` into the config in `emitCache`.

### Phase 2 — wire the rule

- Construct the `CacheNode` in `ruleInSubqueryCache` with `eager: true`. Update
  its docstring to note the eager build defeats IN's first-match short-circuit.

### Phase 3 — tests

- Add the `eager` unit describe block to `cache.spec.ts` (cases above).
- Add the scan-count integration spec under `test/vtab/` (all-rows-match == 1,
  null-condition leading row == 1, over-threshold == N with comment).

### Phase 4 — validate

- `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/test.log; tail -n 80 /tmp/test.log`
- `yarn workspace @quereus/quereus run lint 2>&1 | tee /tmp/lint.log; tail -n 40 /tmp/lint.log`
- If a pre-existing, clearly-unrelated failure surfaces, follow the
  `tickets/.pre-existing-known.md` / `.pre-existing-error.md` protocol — do not
  skip or loosen tests.
