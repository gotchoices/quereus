description: Fixed a prepared statement that cached a subquery's rows on its first run and then wrongly replayed those stale rows on later runs, even after the underlying table changed.
files: packages/quereus/src/runtime/emit/cache.ts, packages/quereus/src/runtime/types.ts, packages/quereus/src/runtime/parallel-driver.ts, packages/quereus/test/prepared-statement-amortization.spec.ts, packages/quereus/test/runtime/fork-contract.spec.ts, docs/runtime.md
difficulty: easy
----

# CacheNode row state leaks across executions of a prepared statement — fixed

## What changed

`emitCache` (`packages/quereus/src/runtime/emit/cache.ts`) used to create its
materialized-row `CacheState` in the **emit-time closure**
(`createCacheState()` called once at emit). Because a prepared `Statement`
caches and reuses its instruction tree + scheduler across executions
(`core/statement.ts`), invalidating only on **schema** change (never on data
change), that closure-owned `CacheState` survived from run 1 into run 2+ and
served stale cached rows.

This is the same class of bug already fixed for impure (DML-bearing)
subqueries via `RuntimeContext.executionMemo` and for inner-scan connection
reuse via `RuntimeContext.scanConnections` (see `docs/runtime.md` § "Impure
subquery run-once contract" / § "Inner-scan connection reuse"). The fix
applies the identical pattern to `CacheNode`.

**Fix**: moved `CacheState` off the emit-time closure and onto the
per-execution `RuntimeContext`:

- `RuntimeContext.cacheStates?: Map<symbol, CacheState>` added
  (`runtime/types.ts`), documented like `executionMemo`/`scanConnections`.
- `emitCache` mints `const cacheKey = Symbol(\`cache:${plan.id}\`)` once at
  emit time (stable across every re-drive of that emit site within one
  execution), and inside `run` does
  `(rctx.cacheStates ??= new Map()).get(cacheKey) ?? …set(…)` to get-or-create
  the per-execution state before calling `streamWithCache`. Simpler than the
  `scanConnections` case — no caller needs to pre-seed the map, `emitCache`
  lazily creates it itself, so there's no "falls back to old behavior on
  transient/analysis contexts" branch to reason about.
- `ParallelDriver.fork` (`runtime/parallel-driver.ts`) now shares
  `cacheStates` by reference into each fork, alongside `executionMemo` /
  `scanConnections`, with a doc-comment explaining why (same rationale: a
  cache materialized in one branch should be visible to a sibling branch
  re-driving the same cache site within one execution). `ParallelDriver` has
  no query consumers yet, so this is dormant wiring for forward-compat, same
  as the two siblings it was added alongside.
- `docs/runtime.md`: added a "CacheNode row-cache lifetime" subsection (after
  "Inner-scan connection reuse") and a `cacheStates` row in the "Parallel
  runtime fork contract" table.

`CacheNode`s reach `emitCache` from all three injecting rules —
`rule-in-subquery-cache` (uncorrelated `IN (subquery)`),
`rule-cte-optimization`, `rule-mutating-subquery-cache` — so this one fix
covers every injection site. `createCacheFunction` / `withSharedCache` in
`shared-cache.ts` remain unused helpers (no production callers) — left
untouched, not in scope.

## Tests

Added to `test/prepared-statement-amortization.spec.ts`, alongside the
existing impure-DML sibling tests:

- **`re-drives an uncorrelated IN-subquery cache with fresh data on every
  execution of a prepared statement`** — the ticket's exact repro: `t1(a)`
  with rows 1,2,3; `t2(b)` with row 2; `select a from t1 where a in (select b
  from t2) order by a` prepared once. Run 1 → `[{a:2}]`. Insert `3` into `t2`
  (data change, not schema). Run 2 (same prepared `Statement`, same
  `stmt.all()` call) → asserts `[{a:2},{a:3}]`. Also asserts
  `internals(stmt).scheduler` is the **same instance** across both runs, to
  prove the fix works with a cached instruction tree rather than by
  accidentally forcing a recompile. Outer row `a=1` has no match, which
  forces the `IN` subquery to fully drain (shared-cache.ts only saves the
  cache on full iteration) — this is deliberate, it's the property that makes
  the cache actually complete and get reused rather than being abandoned
  mid-stream.

Also updated `test/runtime/fork-contract.spec.ts` (a static test-harness
guard that fails the build whenever a new `RuntimeContext` field ships
without a declared fork policy — it enumerates `ParallelDriver.fork()`'s
output against a hand-maintained `EXPECTED_FORK_POLICY` map): added
`cacheStates: 'shared-cooperative'` to that map and a sentinel
(`parent.cacheStates = new Map()`) to the "shared fields aliased to parent"
identity check. This test would have failed CI on this change otherwise —
it's not new coverage for this bug, just required plumbing.

`yarn workspace @quereus/quereus test` — 7020 passing, 0 failing, 13 pending
(pending count unrelated — pre-existing skips elsewhere in the suite).
`yarn workspace @quereus/quereus lint` — clean (eslint + test-file
typecheck).

## Gaps / things the reviewer should probe

- Only the uncorrelated `IN (subquery)` injection site
  (`rule-in-subquery-cache`) got a regression test. `rule-cte-optimization`
  and `rule-mutating-subquery-cache` also route through `emitCache` and
  should be fixed by the same change (the fix is in the shared emitter, not
  per-rule), but neither has a dedicated "stale cache across prepared-statement
  executions" test here. Worth a spot-check if there's appetite, though the
  fix mechanism gives no reason to expect them to behave differently.
- No test exercises the `plan.threshold > 50000` buffering branch or the
  cache-abandoned-on-threshold-exceeded path (`shared-cache.ts` lines
  ~91-101) in combination with the new per-execution reset — i.e., "cache
  abandoned on run 1 due to threshold, does run 2 get a fresh attempt at
  caching (yes, by construction — fresh `CacheState` — but untested)."
- `ParallelDriver` wiring for `cacheStates` is dormant (no query consumers),
  matching the pre-existing state of `executionMemo`/`scanConnections` — not
  a new gap, just flagging it's unexercised by any test, same as its two
  siblings.
