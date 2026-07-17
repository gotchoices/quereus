description: A constant subquery like "where x > (select max(y) from t)" used to re-run for every row; now it computes once and is reused. Review the caching rule and its tests.
files: packages/quereus/src/planner/rules/cache/rule-scalar-subquery-cache.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/test/vtab/scalar-subquery-cache-scan-count.spec.ts
difficulty: medium
----

# Review: cache uncorrelated scalar subqueries so they run once per execution

## What was built

`emitScalarSubquery` re-drained its inner pipeline on every evaluation, so an
uncorrelated scalar subquery in a WHERE / projection / ORDER BY / HAVING
expression re-executed its full source scan once per outer row
(`where x > (select max(y) from t)` = N scans for N outer rows).

Added planner rule **`ruleScalarSubqueryCache`**
(`packages/quereus/src/planner/rules/cache/rule-scalar-subquery-cache.ts`), a
near-mirror of `ruleInSubqueryCache`, that wraps a `ScalarSubqueryNode`'s
`subquery` child in a `CacheNode` when the inner is uncorrelated + functional +
not-already-cached. Registered in `optimizer.ts` as `scalar-subquery-cache`
(`PassId.PostOptimization`, `nodeType: PlanNodeType.ScalarSubquery`,
`sideEffectMode: 'aware'`) directly after `in-subquery-cache`. No emit change:
`emitScalarSubquery` already emits `plan.subquery` via `emitPlanNode`, so the
injected `CacheNode` is emitted transparently.

### Key design point — NON-eager (the contrast with the IN rule)

`ruleInSubqueryCache` uses **eager** mode because `emitIn`'s pure consumer
returns on the first matching row, which would abort a streaming build.
`emitScalarSubquery` has **no** short-circuit — it reads every input row to
detect the ">1 row" error — so a **non-eager** (streaming) `CacheNode` is fully
drained + committed on the first evaluation and replays thereafter. The module
header documents this so a future reader doesn't "fix" it to eager. **Verify
this reasoning holds** — it is the crux of the correctness argument.

## How it was validated

New spec: `packages/quereus/test/vtab/scalar-subquery-cache-scan-count.spec.ts`
(mirrors `in-subquery-cache-scan-count.spec.ts`, uses `CountingMemoryModule`).
All 5 cases pass:

- **Uncorrelated** — `where x > (select max(k) from counting)`, 3 probe rows →
  `scanCounts.get('counting') === 1` (was 3). The core win.
- **Correlated (negative)** — `... (select max(k) from counting where k <> probe.id)`
  → scan count stays 3 (gate rejects; not cached). Confirms `isCorrelatedSubquery`
  holds and correlation is NOT decorrelated away here (the inequality survives as a
  correlated `ScalarSubqueryNode`).
- **Over-threshold** — `maxCacheThreshold: 0` → cache abandons on the first row,
  re-scans per outer row (3).
- **Prepared statement** — two `stmt.all()` runs → exactly one scan each run
  (fresh `CacheState` per `RuntimeContext`; never a stale replay, never zero).
- **>1-row error** — `(select k from counting)` (3 rows) in scalar position →
  still throws `Scalar subquery returned more than one row`; the non-eager cache
  streams rows through so the consumer sees the second row.

Plan inspection (via `query_plan(?)`) confirms the rule fires: node chain is
`ScalarSubquery → Cache → StreamAggregate → IndexScan(counting)`.

- `yarn workspace @quereus/quereus test` → **7059 passing, 0 failing, 13 pending**.
- `yarn workspace @quereus/quereus lint` → clean.
- `git status` after full run → only the 3 intended files; **no golden plans
  regressed** (none in `test/plan/` or `test/optimizer/` gained a Cache node,
  i.e. no committed golden had a surviving uncorrelated scalar subquery at
  PostOptimization).

## Reviewer focus / known gaps (tests are a floor, not a ceiling)

- **Over-threshold test uses `threshold: 0`, a degenerate value.** Unlike the IN
  rule (multi-row source, threshold 2), a *valid* scalar subquery yields ≤1 row,
  so its `CacheNode` buffer never exceeds any positive threshold — the abandon
  path is only reachable at 0. The test still exercises the abandon-and-stream
  branch of `streamWithCache`, but reviewers should confirm this degenerate
  framing is acceptable (it is inherent to scalar semantics, not a rule bug).
- **Subquery-position coverage is WHERE-only behaviorally.** The rule is
  position-agnostic (fires on node type) and the plan check proves it fires, but
  no test asserts the scan-count win for a scalar subquery in a *projection*,
  *ORDER BY*, or *HAVING* clause. Adding one of each would raise the floor.
- **No explicit nested-subquery test.** The ticket called for a smoke test that an
  uncorrelated scalar subquery nested inside a *correlated* outer subquery caches
  on its own without crashing/mis-caching. The full suite passing is weak evidence;
  a targeted case would be stronger.
- **Impure (DML-in-scalar-position) path** is excluded by the `isFunctional`
  gate and keeps its existing run-once `executionMemo` in `emitScalarSubquery`
  (untouched). No new test directly asserts the impure path still fires once —
  relies on existing coverage. Worth a spot-check that no impure scalar-subquery
  test regressed.
- **Decorrelation interplay:** `scalar-agg-decorrelation` /
  `subquery-decorrelation` goldens did not regress, but confirm the reviewer
  agrees only *surviving* `ScalarSubqueryNode`s reach this rule and the
  interaction order is sound.

## Tripwire (parked, not a ticket)

None filed as code comments this round. The over-threshold degeneracy above is
inherent to scalar semantics (buffer ≤1 row), not a conditional future concern,
so it is documented here for the reviewer rather than as a `NOTE:` at a code site.
