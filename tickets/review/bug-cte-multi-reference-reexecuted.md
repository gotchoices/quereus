----
description: A WITH-clause query used more than once in a statement previously ran once per use; it now runs a single time per statement execution and all uses share the result. Implemented; needs adversarial review.
files: packages/quereus/src/planner/nodes/cte-node.ts, packages/quereus/src/planner/building/with.ts, packages/quereus/src/planner/cache/materialization-advisory.ts, packages/quereus/src/planner/rules/cache/rule-cte-optimization.ts, packages/quereus/src/runtime/types.ts, packages/quereus/src/runtime/parallel-driver.ts, packages/quereus/src/runtime/emit/cte.ts, packages/quereus/test/vtab/cte-multi-reference-scan-count.spec.ts, packages/quereus/test/vtab/_counting-memory-module.ts, packages/quereus/test/plan/cte-materialization.spec.ts, packages/quereus/test/runtime/fork-contract.spec.ts, docs/optimizer.md, docs/runtime.md
difficulty: hard
----

# Review: shared materialization for multi-reference CTEs

`with x as (<expensive>) select ... from x a join x b` used to run `<expensive>`
once per reference. Now a non-recursive CTE that is referenced 2+ times (or
hinted `MATERIALIZED`) is evaluated exactly once per statement execution and
every reference reads one shared per-execution buffer.

## What was implemented

**Plan-time mark** (`materialization-advisory.ts`, reusing its single
reference graph — the one-build-per-optimize invariant still holds):
- `CTENode` gained a `readonly materialize: boolean = false` constructor param,
  threaded through `withChildren`, `rule-cte-optimization`'s rebuild, and
  `getLogicalAttributes`.
- `markCTEMaterialization` is a memoized (by node identity) top-down rewrite:
  a shared `CTENode` is rewritten once, so both `CTEReferenceNode` parents keep
  pointing at the SAME marked instance. Mark rule: `!isRecursive`, hint not
  `not_materialized`, and (hint `materialized` OR parentCount ≥ 2).
- CacheNode recommendations are re-keyed through the mark memo (ancestors of a
  marked CTE get new instances; without re-keying their recommendations would
  silently miss).
- Rule 5a in `adviseCaching`: `CTENode` excluded from CacheNode wraps (the wrap
  never landed anyway — `CTEReferenceNode.withChildren` rejects a Cache child).

**Builder change** (`with.ts`): non-recursive CTEs no longer default an absent
hint to `'not_materialized'` — the hint stays `undefined` so the advisory can
distinguish "user opted out" from "no opinion". Grep confirmed no consumer
relied on the synthesized default (all consumers test `=== 'materialized'`).

**Runtime** (`emit/cte.ts`, `runtime/types.ts`, `parallel-driver.ts`):
- New `RuntimeContext.cteMaterializations?: Map<string, Promise<Row[]>>`, keyed
  by the shared CTENode's plan id (a string). Fork policy `shared-cooperative`,
  wired in `parallel-driver.ts` and declared in `fork-contract.spec.ts`.
- `emitCTE`: un-marked CTEs keep the pure streaming path (`yield* queryResult`).
  Marked CTEs get-or-create the buffer promise; the promise is stored
  SYNCHRONOUSLY before any await, so a second reference interleaving under a
  nested-loop self-join finds it and awaits instead of driving its own source
  subtree. Rows are copied on buffer-in and on yield. A no-op `.catch` is
  pre-attached to the stored promise so an early-teardown drive failure can't
  surface as an unhandled rejection.
- The old ad-hoc `materializationHint === 'materialized'` buffering branch in
  `emitCTE` is subsumed by the mark and was removed.

## Validation performed

- `yarn workspace @quereus/quereus lint` — clean.
- `yarn workspace @quereus/quereus test` — 7038 passing, 0 failing.
- `yarn build` (whole workspace) — clean.

Key tests (all new unless noted):
- `test/vtab/cte-multi-reference-scan-count.spec.ts` — counting vtab asserts:
  self-joined CTE scans source exactly ONCE (was 2); correct join rows;
  single-ref CTE under `LIMIT 1` pulls only a handful of a 204-row table
  (streaming preserved); prepared statement re-executed after an INSERT sees
  the new row and scans once per execution (no stale replay, no double drive).
- `test/vtab/_counting-memory-module.ts` — `CountingMemoryModule` extracted
  from `nested-loop-right-cache-scan-count.spec.ts` (now imports it) and
  extended with per-table pulled-row counts.
- `test/plan/cte-materialization.spec.ts` — plan-shape asserts: 2-ref CTE is
  marked AND both references share one CTENode instance (guards the plan.id
  key against silent divergence); single-ref unmarked; `MATERIALIZED`
  single-ref marked; `NOT MATERIALIZED` 2-ref unmarked; recursive CTE never
  rewritten into a marked CTENode.
- `test/runtime/fork-contract.spec.ts` — `cteMaterializations` policy added
  (compile-enforced field coverage).

## Known gaps and things a reviewer should probe

- **Pre-existing bug found, not fixed here:** a recursive CTE referenced twice
  runs away and hits the 10000-iteration limit. Verified identical failure at
  the pre-change commit `ee24d8bf` via a throwaway worktree, so not a
  regression. Filed as `fix/bug-recursive-cte-double-reference-runaway` with
  repro; the ticket's requested "recursive CTE referenced twice returns correct
  results" test therefore became a plan-shape no-mark assertion with a NOTE
  pointing at that ticket.
- **Early-teardown detached drain:** if every consumer of a materialized CTE is
  torn down mid-drive (e.g. `LIMIT` above the join), the buffer drive continues
  to completion in the background (bounded by CTE row count). `NOTE:` recorded
  at the drive site in `emit/cte.ts` — thread the statement abort signal there
  if it ever matters. Not covered by a test.
- **Double buffer (tripwire, by design):** `rule-cte-optimization` may still
  wrap a marked CTE's source in a CacheNode — rows then buffer twice (once in
  the cache, once in the shared CTE buffer). Correct, wasteful; `NOTE:` at the
  wrap site. Removing the CTE-specific wrap is a follow-up needing its own test
  pass (it changes single-ref caching).
- **Node-sharing fragility:** the runtime key is the shared CTENode's plan id.
  The plan test asserting instance identity across both references is the only
  guard against a future rule splitting the instances (failure mode would be
  silent re-execution, not wrong rows).
- **Fork-lazy-map caveat (dormant):** `cteMaterializations` is lazily created on
  first use; a future parallelized query driving CTE refs inside forks must
  eagerly create it on the parent pre-fork (same caveat as `executionMemo`,
  documented in `parallel-driver.ts`).
- `yarn test:store` (LevelDB-backed logic tests) was NOT run — change is
  planner/runtime-level, not store-level, but a reviewer may want the full
  `test:full` pass.

## Docs updated

- `docs/optimizer.md` — Materialization Advisory section: CTE materialize mark,
  memoized rewrite, NOT MATERIALIZED opt-out, CacheNode exclusion.
- `docs/runtime.md` — new "Shared CTE materialization" section + fork-policy
  table row for `cteMaterializations`.
