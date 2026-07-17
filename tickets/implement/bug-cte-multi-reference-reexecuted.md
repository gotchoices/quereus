description: A WITH-clause query used more than once in a statement runs its work once per use instead of once total; make it run a single time and share the result.
prereq: bug-cache-node-stale-across-statement-executions
files: packages/quereus/src/planner/nodes/cte-node.ts, packages/quereus/src/planner/cache/materialization-advisory.ts, packages/quereus/src/planner/cache/reference-graph.ts, packages/quereus/src/runtime/types.ts, packages/quereus/src/runtime/emit/cte.ts, packages/quereus/src/runtime/emit/cte-reference.ts, packages/quereus/src/planner/rules/cache/rule-cte-optimization.ts, packages/quereus/test/plan/cte-materialization.spec.ts, packages/quereus/test/vtab/nested-loop-right-cache-scan-count.spec.ts
difficulty: hard
----

# Non-recursive CTE referenced N times executes N times

## Problem (confirmed by code trace)

`with x as (<expensive>) select ... from x a join x b on ...` runs `<expensive>`
twice. Root cause is at emission, not planning:

- Both `CTEReferenceNode`s point to the **same** `CTENode` instance (build-time
  sharing in `select.ts` `cteReferenceCache`; the optimizer preserves that
  sharing via `OptContext.optimizedNodes`, which memoizes rewrites by node id).
- `emitCTEReference` calls `emitPlanNode(plan.source, ctx)`
  (`runtime/emit/cte-reference.ts:36`). `emitPlanNode` has **no** memoization
  (`runtime/emitters.ts:111`), so the shared `CTENode` subtree is compiled once
  **per reference** → two independent instruction subtrees.
- The planner wraps the CTE source in a `CacheNode` (via
  `rule-cte-optimization.ts` and/or the multi-parent path of
  `materialization-advisory.ts`), but `emitCache` mints a **fresh**
  `Symbol('cache:${plan.id}')` per emit call (`runtime/emit/cache.ts:50`). Two
  emissions → two symbols → two distinct per-execution `CacheState`s → the
  source is driven once per reference.

Even keying the cache state by `plan.id` instead of a fresh symbol would **not**
fix the join-on-both-sides case: `streamWithCache` only serves from cache after
a full first drain (`runtime/cache/shared-cache.ts:64`). Under a nested-loop
join whose left and right are both `x`, the left's first drive and the right's
first drive overlap, so the source still runs twice before either completes.

## Chosen design: eager shared materialization keyed by CTE identity

A multi-referenced (or explicitly `materialized`) non-recursive CTE is
**materialized once per statement execution** into a shared per-execution
buffer. All references read that one buffer; only the first reference to run
drives its source; the others never iterate their own (separately-emitted)
source subtree, so it is never driven.

This matches standard SQL `MATERIALIZED` CTE semantics (single full evaluation)
and guarantees exactly one execution regardless of how references interleave.

### Part A — mark multi-reference CTEs at plan time

Add a resolved boolean to `CTENode` telling emission to materialize:

```ts
// cte-node.ts — new constructor param, threaded through withChildren
constructor(
  scope: Scope,
  cteName: string,
  columns: string[] | undefined,
  source: RelationalPlanNode,
  materializationHint: 'materialized' | 'not_materialized' | undefined,
  isRecursive: boolean = false,
  readonly materialize: boolean = false,   // NEW: resolved decision for emit
) { ... }
```

`withChildren` must pass `this.materialize` through so the flag survives
rewrites.

Compute the flag inside **`materialization-advisory.ts`**, reusing the single
`ReferenceGraphBuilder` it already builds (do **not** add a second whole-tree
pass — `test/plan/materialization-advisory-single-pass.spec.ts` locks
`buildReferenceGraph` to exactly one call per optimize). Rule for a `CTENode`
`n`:

```
materialize(n) =
     n is not recursive (!n.isRecursive)
  && n.materializationHint !== 'not_materialized'
  && ( n.materializationHint === 'materialized' || refGraph.get(n).parentCount >= 2 )
```

Apply the marks with a **memoized** top-down rewrite (`Map<PlanNode, PlanNode>`
keyed by node identity) so the shared `CTENode` is rewritten **once** and both
`CTEReferenceNode` parents receive the **same** marked instance. The existing
`transformTree`/`transformChildren` in this file is **not** memoized — do not
reuse it for the CTE mark, or the two references will diverge into separate
marked `CTENode`s with different ids and the runtime key will not match. A small
dedicated memoized walk is fine; keep it in the same pass so the reference graph
is shared.

Note: `materialization-advisory.ts` already *tries* to wrap the multi-parent
`CTENode` in a `CacheNode`, but `CTEReferenceNode.withChildren` throws on a
non-CTE child, so that wrap is silently dropped today (the throw is caught). The
new mark replaces that intent for CTEs — exclude `CTENode` from the `CacheNode`
recommendation path (Rule 5) so the pass stops attempting a wrap it cannot land.

### Part B — runtime shared buffer

Add a per-execution map to `RuntimeContext`, mirroring the `cacheStates` field
introduced by the prereq (`bug-cache-node-stale-across-statement-executions`):
same per-execution lifetime (fresh `RuntimeContext` per execution ⇒
staleness-safe), same fork policy (`shared-cooperative`) wired in
`parallel-driver.ts`.

```ts
// runtime/types.ts — on RuntimeContext
/** Per-execution CTE materialization buffers, keyed by the shared CTENode's plan id. */
cteMaterializations?: Map<number, Promise<Row[]>>;
```

Rewrite `emitCTE` (`runtime/emit/cte.ts`) so that when `plan.materialize` is
set it uses the shared buffer; otherwise it keeps today's streaming path
unchanged:

```ts
async function* run(rctx, queryResult) {
  if (!plan.materialize) {
    // existing streaming behavior (unchanged): stream queryResult through
    yield* queryResult;
    return;
  }
  const buffers = (rctx.cteMaterializations ??= new Map());
  let bufPromise = buffers.get(plan.id);
  if (!bufPromise) {
    // First reference to run owns the single source drive. Create + store the
    // promise SYNCHRONOUSLY (before the first await) so a concurrent second
    // reference finds it and never touches its own queryResult subtree.
    bufPromise = (async () => {
      const rows: Row[] = [];
      for await (const row of queryResult) rows.push([...row] as Row);
      return rows;
    })();
    buffers.set(plan.id, bufPromise);
  }
  const rows = await bufPromise;
  for (const row of rows) yield [...row] as Row;   // copy per consumer
}
```

Key = `plan.id` of the shared `CTENode`; both references' `emitCTE` closures
capture the same instance ⇒ same id (Part A's memoized rewrite guarantees this).
The get-then-set is atomic under single-threaded JS because nothing awaits
between them.

`materializationHint === 'materialized'` should continue to route through the
same buffer (it sets `plan.materialize`), so the ad-hoc `materialized` branch in
today's `emitCTE` is subsumed and can be removed.

## Edge cases & interactions

- **Join on both sides of the same CTE (the core adversarial case).** Nested-loop
  interleaving must still yield exactly one source drive. The promise is created
  before any `await`, so the inner-side reference finds it and awaits rather than
  re-driving. Assert with a counting vtab (see tests).
- **Prepared statement re-execution after data change.** Buffer lives on
  `RuntimeContext`, which is fresh per execution. Run the multi-ref query twice
  on one prepared statement with the underlying table mutated between runs;
  the second run must reflect new data (no stale replay). This is the exact
  invariant the prereq established for `CacheNode`; hold it here too.
- **Single-reference CTE.** `parentCount < 2` and no `materialized` hint ⇒ not
  marked ⇒ unchanged streaming path. Verify a single-ref CTE under `LIMIT 1`
  does **not** fully drain its source (streaming/early-exit preserved). A blanket
  materialization here would regress large single-ref CTEs (`with big as (select
  * from huge) select * from big limit 1`) — do not materialize single-ref.
- **Explicit `not materialized` with ≥2 references.** Honor the hint: not
  marked, so it re-executes per reference (user's explicit choice). Test that it
  is not marked.
- **Explicit `materialized` with a single reference.** Marked ⇒ materialized.
- **Recursive CTEs.** Out of scope: they route through `RecursiveCTENode` /
  `InternalRecursiveCTERefNode` and the working-table mechanism, not
  `emitCTE`. Gate the mark on `!isRecursive`. Add one test that a recursive CTE
  referenced twice still returns correct results (no regression); do not attempt
  to materialize it here.
- **Node-sharing fragility.** The runtime key relies on both references pointing
  to the same `CTENode` id after optimization. If the implementer finds the
  instances diverge (e.g. a future rule rewrites the CTE per-parent), the
  `plan.id` key silently falls back to double execution — cover this with the
  plan test that asserts the marked `CTENode` is shared (same node object
  reached from both `CTEReferenceNode`s), so a regression fails loudly rather
  than silently re-executing.
- **Row aliasing.** Materialized rows are shared across references and replays;
  copy on cache-in and on yield (as shown) so a downstream mutator cannot
  corrupt another reference's view. Mirror the deep-copy discipline in
  `shared-cache.ts`.
- **Redundant inner CacheNode (tripwire, not a task).** When a CTE is marked
  materialize, `rule-cte-optimization` may still wrap the CTE's inner source in
  a `CacheNode`. That inner cache now buffers rows that `emitCTE` also buffers —
  correct but a wasted buffer, driven only by the single first reference. Leave
  it for now; add a `// NOTE:` at the wrap site in
  `rule-cte-optimization.ts` recording the double-buffer, and mention it in the
  review handoff. Removing the CTE-specific wrap from `rule-cte-optimization`
  is a clean follow-up but out of scope here (it would change single-ref CTE
  caching behavior and needs its own test pass).

## Tests

Reuse the counting-vtab pattern from
`test/vtab/nested-loop-right-cache-scan-count.spec.ts` (`CountingMemoryModule`
increments a per-table counter on each `query()` open). Add a new spec
`test/vtab/cte-multi-reference-scan-count.spec.ts`:

- `with cte as (select id, val from counting) select c1.id, c2.val from cte c1
  join cte c2 on c1.id = c2.id` ⇒ `scanCounts.get('counting') === 1`. This is
  the primary regression assertion (was 2 before the fix).
- Same query returns correct rows (self-join correctness — the existing
  `test/plan/cte-materialization.spec.ts` "produces correct results for
  multi-reference CTE" case must still pass).
- Single-ref CTE with `limit 1` over a many-row counting table: source not fully
  drained (assert far fewer than all rows pulled, or that streaming path is
  taken) — locks the no-regression-for-single-ref guarantee.
- Prepared-statement re-execution: prepare the multi-ref query, run it, mutate
  `counting`'s backing rows, run again; second run reflects new data and scans
  once per execution (not zero — no stale replay).

Extend `test/plan/cte-materialization.spec.ts`:

- Assert a 2-reference CTE's `CTENode` has `materialize === true` and is the
  **same instance** reachable from both `CTEReferenceNode`s.
- Assert a single-reference CTE's `CTENode` has `materialize === false`.
- Assert `... materialized` single-ref ⇒ `true`; `... not materialized`
  double-ref ⇒ `false`.

## TODO

Phase 1 — plan mark
- Add `materialize` to `CTENode` constructor + thread through `withChildren`.
- In `materialization-advisory.ts`, compute the mark from the existing
  reference graph (parentCount ≥ 2, or `materialized` hint; `!isRecursive`;
  not `not_materialized`) and apply via a memoized top-down rewrite that
  preserves shared-node identity.
- Exclude `CTENode` from the `CacheNode` multi-parent recommendation (it never
  lands anyway; the mark replaces it).
- Add the `// NOTE:` double-buffer tripwire in `rule-cte-optimization.ts`.

Phase 2 — runtime buffer
- Add `cteMaterializations` to `RuntimeContext` (mirror `cacheStates`: lifetime
  + fork policy in `parallel-driver.ts`).
- Rewrite `emitCTE` materialize path; keep the non-materialize streaming path
  intact; remove the now-subsumed ad-hoc `materialized` branch.

Phase 3 — tests + validate
- New `cte-multi-reference-scan-count.spec.ts`; extend
  `cte-materialization.spec.ts`.
- `yarn workspace @quereus/quereus lint` and
  `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/cte.log; tail -n 60 /tmp/cte.log`.
- Update `docs/optimizer.md` / `docs/runtime.md` CTE sections to describe
  materialization of multi-reference CTEs (edit existing docs; no new file).
