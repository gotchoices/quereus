----
description: Fix a prepared statement that caches a subquery's rows on its first run and then wrongly replays those stale rows on later runs, even after the underlying table changed.
files: packages/quereus/src/runtime/emit/cache.ts, packages/quereus/src/runtime/types.ts, packages/quereus/src/runtime/parallel-driver.ts, packages/quereus/src/runtime/cache/shared-cache.ts, packages/quereus/test/prepared-statement-amortization.spec.ts
difficulty: easy
----

# CacheNode row state leaks across executions of a prepared statement

## Confirmed at runtime

Reproduced with a throwaway spec (now removed). Repro:

```sql
create table t1 (a integer primary key);
insert into t1 values (1), (2), (3);
create table t2 (b integer primary key);
insert into t2 values (2);
-- prepare once, reuse the Statement:
select a from t1 where a in (select b from t2) order by a;   -- run 1 → [{a:2}]
insert into t2 values (3);                                   -- data change (not schema)
-- re-execute the SAME prepared statement:
--   run 2 → [{a:2}]   ← WRONG, missing {a:3}
```

Run 2 replays run 1's cached subquery rows. (Outer row `a=1` has no match, which
forces a full drain of the `IN` subquery so the cache actually completes —
`shared-cache.ts:104-110` saves only on full iteration. Keep that property in the
regression test.)

## Root cause

`emitCache` creates the materialized-row `CacheState` in the **emit-time closure**
(`runtime/emit/cache.ts:34`, `createCacheState()`). The instruction tree + scheduler
are emitted once and cached on the prepared Statement, reused across executions
(`core/statement.ts:353-357`); the cache is invalidated only on a **schema** change
(`statement.ts:181-227`), never on a data change. So the closure's `CacheState`
survives from run 1 into run 2 and serves stale rows.

This is the exact same class of bug already fixed for impure (DML-bearing)
subqueries — see `runtime/types.ts:49-58` (`executionMemo`) and the regression
tests in `test/prepared-statement-amortization.spec.ts:164-229`. That fix moved the
once-per-execution memo off the emit-time closure and onto the per-execution
`RuntimeContext`. The CacheNode row state was left behind and needs the same move.

`CacheNode`s reach `emitCache` from all three injecting rules — `rule-in-subquery-cache`
(uncorrelated `IN (subquery)`), `rule-cte-optimization`, `rule-mutating-subquery-cache`
— so fixing `emitCache` covers every injection site. `createCacheFunction` /
`withSharedCache` in `shared-cache.ts` are unused helpers (no production callers).

## Fix (mirror the `executionMemo` / `scanConnections` pattern)

Move `CacheState` from the emit-time closure to the per-execution `RuntimeContext`,
keyed by a stable symbol minted in the `emitCache` closure. Same rctx within one
execution → same `CacheState` (cache still materializes once and replays within the
run, across NLJ re-scans / per-outer-row `IN` evals). Fresh rctx per execution →
fresh `CacheState`, so run 2 re-drives the source and sees current data.

## TODO

- Add `cacheStates?: Map<symbol, CacheState>` to `RuntimeContext` (`runtime/types.ts`),
  documented like `executionMemo` (why it lives on the context, not the closure).
  Import the `CacheState` type from `runtime/cache/shared-cache.js`.
- In `emitCache` (`runtime/emit/cache.ts`): drop the closure `createCacheState()`;
  mint `const cacheKey = Symbol(\`cache:${plan.id}\`)`; inside `run`, get-or-create the
  state via `(rctx.cacheStates ??= new Map()).get(cacheKey) ?? …set(…)`, and pass that
  to `streamWithCache`. Mirror the symbol-key comment style used in `emit/scan.ts:60-64`.
- Wire `cacheStates` through the parallel fork in `runtime/parallel-driver.ts` — share
  it **by reference** alongside `executionMemo` / `scanConnections` (lines ~107-111 and
  the field-comment block ~54-64), so within-execution cache sharing spans branches.
- Add a regression test in `test/prepared-statement-amortization.spec.ts`, next to the
  impure-DML sibling tests: prepare the `IN`-subquery statement above, run it, `insert`
  a new matching row into the source table (data change), re-run the **same** statement,
  assert the second run reflects the new row. Assert the scheduler is the same instance
  across runs (`internals(stmt).scheduler`) to prove the fix works with a cached tree,
  not by accidentally recompiling.
- Run `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus lint`.
