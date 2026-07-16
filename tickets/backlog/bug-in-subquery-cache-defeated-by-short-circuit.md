----
description: The cache that is supposed to make "x IN (subquery)" run the subquery once only finishes building if some row scans the whole subquery without a match, so match-heavy workloads restart the subquery from scratch on every row.
files: packages/quereus/src/runtime/emit/subquery.ts, packages/quereus/src/runtime/cache/shared-cache.ts, packages/quereus/src/planner/rules/cache/rule-in-subquery-cache.ts
----

# IN-subquery cache never completes under early matches

`rule-in-subquery-cache.ts` wraps an uncorrelated `IN (subquery)` source in a
`CacheNode`, but the runtime defeats it:

- `emitIn`'s streaming path returns `true` on the **first match**
  (`emit/subquery.ts:176-178`), abandoning the input iterator mid-stream.
- `streamWithCache` commits the cache only after a **complete drain**
  (`runtime/cache/shared-cache.ts:104-110`).

While outer rows keep matching early, the cache never finishes building and
every row restarts the subquery source from scratch — one query-start per
outer row on a high-latency backend, exactly what the rule exists to prevent.
The cache only materializes after the first outer row that finds *no* match.

The same partial-drain failure mode applies to any short-circuiting consumer
sitting above a `CacheNode`.

Candidate fixes: materialize the IN source eagerly into the membership hash on
first evaluation (drain fully once, then probe); or make the shared cache
resumable so a partial drain extends the prior prefix instead of discarding
it. Eager-full-drain is simpler and matches how hash joins build sides.

Test: instrumented vtab counting source scans under an all-rows-match
workload — must be 1, is currently N.
