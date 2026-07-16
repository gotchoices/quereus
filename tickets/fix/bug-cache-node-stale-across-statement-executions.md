----
description: A prepared statement that caches a subquery's rows during its first run may replay those stale rows on later runs of the same statement, even after the underlying table has changed.
files: packages/quereus/src/runtime/emit/cache.ts, packages/quereus/src/core/statement.ts, packages/quereus/src/planner/rules/cache/rule-in-subquery-cache.ts, packages/quereus/src/runtime/cache/shared-cache.ts
----

# CacheNode state may leak across executions of a prepared statement

**Suspected correctness bug — first step is to reproduce.**

## Mechanism (from code reading, unverified at runtime)

- `emitCache` keeps its materialized-row state in the emit-time closure
  (`runtime/emit/cache.ts:34`), not in the per-execution runtime context.
- The compiled scheduler / instruction tree is cached on the prepared
  statement and reused across executions (`core/statement.ts:353-357`);
  invalidation happens only on schema change (`statement.ts:128`, `:223`).
- Therefore a `CacheNode` that fully materialized during execution 1 would
  serve those same rows during execution 2, even if the cached subquery's
  source table was mutated in between (by this or another statement).

`CacheNode`s are injected today by `rule-in-subquery-cache.ts` (uncorrelated
`IN (subquery)` sources), `rule-cte-optimization.ts`, and
`rule-mutating-subquery-cache.ts`.

## Repro sketch

1. Prepare `select * from t1 where a in (select b from t2)`.
2. Execute → note results.
3. Insert/delete rows in `t2` (separate statement, same session; also test a
   different session/connection if applicable).
4. Re-execute the prepared statement → check whether results reflect the new
   `t2` contents.

Note the IN-cache only completes after a full drain (`shared-cache.ts:104-110`
saves only on complete iteration), so the repro must ensure the first
execution fully drains the subquery (e.g. include an outer row with no match).

## Expected behavior

Each execution of a statement must observe the current committed/visible data.
Cache state must be scoped per execution (runtime context), or explicitly
invalidated on any data change to the cached source — not just schema change.

## Why this matters now

Two open perf efforts (nested-loop right-side caching, uncorrelated scalar
subquery caching — see backlog) want to inject *more* CacheNodes. If this bug
is real, widening cache injection widens the staleness surface, so this must
be resolved first — those tickets carry a `prereq:` on this slug.

If reproduction fails (e.g. state turns out to be per-execution after all),
document why in the ticket and close it via the normal pipeline.
