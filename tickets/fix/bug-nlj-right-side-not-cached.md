----
description: Nested-loop joins re-scan their entire right side once per left row because the caching the code comments promise was never wired up; joins that can't use hash/merge pay N×M table reads.
prereq: bug-cache-node-stale-across-statement-executions
files: packages/quereus/src/runtime/emit/join.ts, packages/quereus/src/planner/cache/reference-graph.ts, packages/quereus/src/planner/cache/materialization-advisory.ts, packages/quereus/src/planner/rules/cache/rule-mutating-subquery-cache.ts, packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts
----

# Nested-loop join right side is never cached for pure inputs

## Problem

`runtime/emit/join.ts` re-invokes the right-side pipeline once per left row
(`rightCallback(rctx)` at `join.ts:128`). The comment at `join.ts:76` says the
optimizer facilitates this "through a cache node" — but for pure (side-effect
free) right sides no rule ever injects one:

- `rule-mutating-subquery-cache.ts:24-83` caches only side-effect-bearing
  right sides (to pin write-once semantics), not pure ones.
- The materialization advisory's loop-detection rule ("appears in loop",
  `materialization-advisory.ts:134-154`) is **dead code**:
  `ReferenceGraphBuilder` initializes `inLoop: false` and never sets it true
  (`reference-graph.ts:68-72`, `:117-121`).
- Its multi-parent rule (Rule 5) requires shared node instances, which a join
  right side never is.

Hash/merge/bloom joins materialize their build side once and are fine
(`bloom-join.ts:88-99`). But `rule-join-physical-selection.ts:95` returns null
for non-equi and cross joins, which therefore stay nested-loop with an
uncached right side: a theta/cross join between two vtabs performs N full
scans of the right table. On high-per-read-latency storage backends this is a
10-100× class trap (same family as the correlated-subquery N+1 already being
fixed under `quereus-decorrelate-scalar-agg-subquery-project`).

## Expected behavior

An **uncorrelated, functional** (pure, deterministic) nested-loop right side
should be materialized once and replayed per left row — e.g. a rule mirroring
`rule-mutating-subquery-cache` without the side-effect gate, or resurrecting
the advisory's loop detection with a real `inLoop` computation. Correlated
right sides (parameterized by the left row) must remain per-row.

The dead `inLoop` machinery should either be wired up or removed — a detection
path that silently never fires is worse than none.

## Notes

- `prereq:` on the CacheNode staleness fix — injecting more caches before that
  is resolved widens a suspected correctness hole.
- Memory-safety: materializing an unbounded right side trades I/O for memory;
  respect/extend the existing cache thresholds (see `rule-cte-optimization` /
  shared-cache spill behavior, if any) rather than caching unconditionally.
- Test: golden plan showing the cache wrapper on a cross/theta join right
  side, plus a logic test proving results unchanged; a counter-based vtab (or
  instrumented memory vtab) asserting the right side is scanned once, not N
  times.
