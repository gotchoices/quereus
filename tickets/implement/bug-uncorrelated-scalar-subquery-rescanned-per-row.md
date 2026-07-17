description: A constant subquery like "where x > (select max(y) from t)" is fully re-executed for every row examined; make it compute once and reuse the result.
files: packages/quereus/src/planner/rules/cache/rule-in-subquery-cache.ts, packages/quereus/src/planner/rules/cache/rule-scalar-subquery-cache.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/nodes/subquery.ts, packages/quereus/src/runtime/emit/subquery.ts, packages/quereus/src/planner/cache/correlation-detector.ts, packages/quereus/src/planner/nodes/cache-node.ts, packages/quereus/test/vtab/in-subquery-cache-scan-count.spec.ts
difficulty: medium
----

# Cache uncorrelated scalar subqueries so they run once per execution

## Problem

`emitScalarSubquery` (`runtime/emit/subquery.ts:73-89`) drains its input
pipeline on every evaluation. A scalar subquery embedded in a WHERE /
projection / ORDER BY expression is compiled as a sub-program re-run per outer
row, so an **uncorrelated** scalar subquery re-executes its full pipeline once
per row: `where x > (select max(y) from t)` performs N aggregate scans of `t`
for N outer rows.

The only existing memo on that emit path is the *impure* run-once guard
(`subquery.ts:33-71`), which fires DML-bearing inners exactly once for write
correctness. Pure uncorrelated scalar subqueries have **no** cache: no planner
rule targets `ScalarSubqueryNode`. `rule-in-subquery-cache` solves the exact
same shape for `x IN (subquery)` by wrapping the source in a `CacheNode`, but
covers only `InNode`.

## Design

Add a planner rule `ruleScalarSubqueryCache`, a near-mirror of
`ruleInSubqueryCache` (`planner/rules/cache/rule-in-subquery-cache.ts`), that
wraps a `ScalarSubqueryNode`'s `subquery` child in a `CacheNode` when the inner
is uncorrelated + functional + not already cached. The `CacheNode` materializes
the inner on first evaluation and replays from the buffer on every subsequent
evaluation → O(1) inner scans per execution instead of O(N).

No emit change is required: `emitScalarSubquery` already emits
`plan.subquery` via `emitPlanNode`, so it emits the injected `CacheNode`
transparently. The prereq
(`bug-cache-node-stale-across-statement-executions`, now in `complete/`) moved
`CacheState` onto the per-execution `RuntimeContext`, so a cached inner
correctly re-materializes once per prepared-statement run (never a stale
replay, never zero scans).

### Gates (identical to the IN rule)

- Node is `PlanNodeType.ScalarSubquery`.
- Inner (`plan.subquery`) is not already cached
  (`CapabilityDetectors.isCached(inner) && inner.isCached()`).
- Inner is uncorrelated: `!isCorrelatedSubquery(inner)`
  (`planner/cache/correlation-detector.ts`). A correlated inner's result
  depends on the outer row and **must not** be cached.
- Inner is functional: `PlanNodeCharacteristics.isFunctional(inner)`
  (deterministic + read-only). This also excludes the impure DML-bearing inner,
  which keeps its existing run-once memo in `emitScalarSubquery`.

Threshold: `Math.min(CachingAnalysis.getCacheThreshold(inner),
context.tuning.cte.maxCacheThreshold)` — same as the IN rule.

### Eager vs. non-eager — use NON-eager (the key contrast with the IN rule)

`ruleInSubqueryCache` builds the `CacheNode` in **eager** mode because
`emitIn`'s pure consumer returns on the first matching row, which would abort a
streaming cache build mid-drain and leave it uncommitted.

`emitScalarSubquery`'s pure consumer has **no** such short-circuit: it iterates
the *entire* input on every evaluation — it must read every row to detect the
"more than one row" error (`subquery.ts:77-86`). A streaming (non-eager)
`CacheNode` is therefore fully drained and committed on the first evaluation,
so subsequent evaluations replay from the buffer. Pass `eager: false` (the
`CacheNode` default). Do **not** copy the IN rule's `eager: true`.

Rebuild the `ScalarSubqueryNode` with the cached inner. Prefer
`plan.withChildren([cachedInner])` (`nodes/subquery.ts:withChildren`) over the
raw constructor so future constructor fields can't be silently dropped — note
`ScalarSubqueryNode.withChildren` type-checks that the child is relational and
returns `this` when unchanged, which is correct here.

### Registration

Add a manifest entry in `optimizer.ts` next to the `in-subquery-cache` entry:

```
{
	pass: PassId.PostOptimization,
	id: 'scalar-subquery-cache',
	nodeType: PlanNodeType.ScalarSubquery,
	phase: 'rewrite',
	fn: ruleScalarSubqueryCache,
	// Gates on isFunctional(inner) (deterministic + read-only).
	sideEffectMode: 'aware',
},
```

Import `ruleScalarSubqueryCache` alongside the other cache-rule imports at the
top of `optimizer.ts`.

## Edge cases & interactions

- **Correlated scalar subquery** (`select max(y) from t where t.g = outer.g`):
  gated out by `isCorrelatedSubquery`; still re-evaluated per outer row (result
  genuinely differs). Add an explicit negative test asserting per-row scan count
  is preserved — proves the gate holds and we didn't cache a correlated inner.
- **Impure scalar subquery** (DML with RETURNING in scalar position): not
  functional → not wrapped; the existing run-once `executionMemo` path in
  `emitScalarSubquery` continues to govern write-once semantics. Confirm the
  impure path is untouched.
- **Already-cached inner:** rule runs in a fixpoint pass and must be idempotent
  — the `isCached` gate makes re-application a no-op (returns null second time).
- **Over-threshold inner:** when inner row count exceeds the cache threshold,
  `CacheNode` abandons the buffer and streams the remainder — each subsequent
  evaluation re-scans (one scan per outer row). This is the intended memory
  bound, mirrors `in-subquery-cache-scan-count.spec.ts:81-104`. Cover it.
- **Prepared-statement re-execution:** fresh `CacheState` per `RuntimeContext`
  (prereq fix) → re-materialize exactly once per run, never a stale replay,
  never zero scans. Cover with a `db.prepare(...)` two-run test mirroring
  `in-subquery-cache-scan-count.spec.ts:106-128`.
- **>1-row error preserved:** a scalar subquery yielding 2+ rows must still
  throw "Scalar subquery returned more than one row". Non-eager `CacheNode`
  streams rows through as it buffers, so the scalar consumer sees the second row
  and throws — the cache is transparent to the error. Add a test that a cached
  scalar subquery over a >1-row source still errors.
- **Subquery position** (WHERE vs projection vs ORDER BY vs HAVING): the rule
  fires on node type regardless of expression position, since the framework
  visits embedded `ScalarSubqueryNode`s the same way it visits embedded
  `InNode`s (which is why the IN rule works). Verify the rule actually fires —
  inspect the optimized plan / rule log — don't assume the framework descends
  into scalar expression subtrees; confirm it.
- **Nested subqueries:** an uncorrelated scalar subquery nested inside a
  *correlated* outer subquery can still be cached on its own, while the
  correlated enclosing one re-evaluates. Not required to optimize, but must not
  crash or mis-cache; a smoke test is enough.
- **Decorrelation interplay:** `rule-scalar-agg-decorrelation` /
  `rule-subquery-decorrelation` may already have rewritten some scalar
  subqueries into joins before PostOptimization. Only surviving
  `ScalarSubqueryNode`s reach this rule — that's fine; just don't regress the
  existing decorrelation golden plans.

## Tests

TDD-style; primary new coverage is a runtime scan-count spec modeled on the IN
one (`test/vtab/in-subquery-cache-scan-count.spec.ts`, using
`CountingMemoryModule`).

New: `packages/quereus/test/vtab/scalar-subquery-cache-scan-count.spec.ts`

- Uncorrelated: `select id from probe where x > (select max(k) from counting)`
  with N probe rows → `scanCounts.get('counting') === 1` (was N). Core win.
- Correlated (negative): `select id from probe where x > (select max(k) from
  counting where k <> probe.id)` → scan count stays N (gate holds; not cached).
- Over-threshold: set `maxCacheThreshold` below inner size → per-row re-scan.
- Prepared statement: two `stmt.all()` runs → exactly one scan each run.
- >1-row error: cached scalar subquery over a 2-row source still throws
  "Scalar subquery returned more than one row".

Also run the existing `.sqllogic` suite and optimizer golden-plan tests
(`test/plan/`, `test/optimizer/`) — a new `CacheNode` will appear in `explain`
output for uncorrelated scalar-subquery plans; update any golden plans that
legitimately change, and confirm no decorrelation goldens regress.

## TODO

- Add `ruleScalarSubqueryCache` in
  `packages/quereus/src/planner/rules/cache/rule-scalar-subquery-cache.ts`
  (mirror `rule-in-subquery-cache.ts`; gates uncorrelated + functional +
  not-cached; wrap inner in **non-eager** `CacheNode` via
  `plan.withChildren`). Document the eager-vs-non-eager contrast in the module
  header so a future reader doesn't "fix" it to eager.
- Register the rule in `optimizer.ts` (import + manifest entry beside
  `in-subquery-cache`, `PassId.PostOptimization`, `nodeType:
  PlanNodeType.ScalarSubquery`, `sideEffectMode: 'aware'`).
- Write `test/vtab/scalar-subquery-cache-scan-count.spec.ts` (5 cases above).
- Verify the rule fires (rule log / optimized plan) and the impure run-once path
  in `emitScalarSubquery` is untouched.
- Refresh any legitimately-changed golden plans in `test/plan/` /
  `test/optimizer/`; confirm decorrelation goldens don't regress.
- `yarn workspace @quereus/quereus lint` and
  `yarn workspace @quereus/quereus test` clean before handoff.
