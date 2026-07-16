----
description: A join that can't use a hash/merge algorithm re-read its entire right-hand table once per left row; it now materializes a pure right side once and replays it, so a slow table is scanned a single time.
prereq:
files: packages/quereus/src/planner/rules/cache/rule-nested-loop-right-cache.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/nodes/cache-node.ts, packages/quereus/src/planner/cache/reference-graph.ts, packages/quereus/src/planner/cache/materialization-advisory.ts, packages/quereus/src/planner/rules/cache/rule-mutating-subquery-cache.ts, packages/quereus/test/plan/nested-loop-right-cache.spec.ts, packages/quereus/test/vtab/nested-loop-right-cache-scan-count.spec.ts, packages/quereus/test/plan/joins/theta-nlj-right-cache.sql, packages/quereus/test/reference-graph.spec.ts, packages/quereus/test/query-rewrite-join.spec.ts, docs/optimizer.md
----

# Review: cache the right side of a pure nested-loop join

## What was built

A new optimizer rule, `rule-nested-loop-right-cache`, wraps the **right side of a
surviving logical nested-loop join** in a `CacheNode` so it is materialized once
and replayed per left row, instead of being fully re-scanned N times (once per
left row). This is the fix for the reported bug: `a JOIN b ON a.x > b.y` (and any
non-equi / cross join) re-opened the right pipeline per left row — a 10–100×
trap on a high-per-read-latency vtab.

The rule lives in the **PostOptimization** pass, registered on `PlanNodeType.Join`
immediately after `mutating-subquery-cache`. By that pass, `join-physical-selection`
has already turned every equi-join it wanted into a hash/merge join, so any
surviving logical `JoinNode` is a nested loop — the structural signal the rule keys
on. `mutating-subquery-cache` handles impure right sides; this rule handles pure
ones; they partition the space and the already-cached gate prevents double-wrapping.

### Rule gates (all must pass to cache)
- **Driver gate** — only `inner`/`left`/`cross`/`semi`/`anti` (left-driven, which
  re-open the right per left row). `right`/`full` drive from the right and scan each
  side once, so caching would only waste memory — skipped.
- **Already-cached** — skip if the right is already a `CacheNode`.
- **Purity** — skip if the right subtree has side effects (that's the mutating rule's job).
- **Determinism** — skip a non-deterministic right (e.g. `random()`); caching would
  freeze the first scan's values.
- **Correlation** — skip if the right subtree references left attributes (a
  parameterized/lateral seek); it must re-evaluate per left row.
- **CTE-safety** (added during implementation — see below) — skip if the right
  subtree touches CTE machinery.
- **Size** — skip if the estimated right row count exceeds `join.maxRightRowsForCaching`
  (50000); trades I/O for memory only within the existing threshold.

Reconstruction uses `JoinNode.withChildren` (not the raw constructor) so
`usingColumns` and `existence` flag columns survive the rebuild.

## Changes beyond the original ticket (reviewer: scrutinize these)

The ticket's plan was correct in outline, but implementation surfaced **three real
issues the ticket did not anticipate**. Each is fixed here; each deserves a look.

1. **`CacheNode` was physically lossy — now fixed (broad blast radius).**
   `CacheNode` had **no `computePhysical`**, so wrapping any relation dropped its
   FDs, keys, ordering, monotonicOn, equivalence classes, INDs, and update-lineage.
   Wrapping a join's right side therefore silently degraded the join's physical key
   analysis (caught by `keys-propagation.spec` "≤1-row join empty key"; the
   degradation is general — it would disable DISTINCT elimination, join-key coverage,
   etc. for *any* cached subtree). Fix: `CacheNode.computePhysical` now passes the
   source's relational physical properties through verbatim (mirroring `AliasNode`;
   a memory/spill cache replays in source order, so ordering is preserved).
   `accessCapabilities`/`rangeBoundedOn` are deliberately NOT propagated (leaf-only,
   per their documented pass-through contract). **This affects every `CacheNode`
   producer** (cte-optimization, in-subquery, mutating-subquery, advisory), not just
   the new rule. Full suite is green (7029 passing) and no existing golden contained
   a `Cache` node, so nothing regressed — but the reviewer should confirm no consumer
   *relied* on the previously-empty physical.

2. **`CacheNode` + `CTEReference` breaks at runtime (latent; worked around, not
   root-fixed).** Caching a NOT_MATERIALIZED CTE-backed right side throws
   `No row context found for column …` at execution. Root cause: `emit/cache.ts`
   eagerly **drains** its source on the first left row; `emit/cte-reference.ts` opens
   a row-context slot while iterating and `close()`s it in `finally`. Draining the
   cache tears that context down before the join's ON-condition reads it (and, for
   the inlined CTE case, disturbs the outer loop's own context — the failing lookup
   was a *left* attribute). Confirmed with a reduced repro:
   `WITH a AS (…), b AS (…) SELECT … FROM a JOIN b ON a.id = b.id` (an equi-join that
   stayed a nested loop because CTE row estimates make nested-loop cheapest). **Fix
   here is a gate** (`subtreeTouchesCte`) that skips CTE-backed right sides, plus a
   `NOTE:` in the rule. **The deeper CacheNode/CTEReference interaction is a genuine
   latent runtime bug that the sibling `mutating-subquery-cache` rule also shares
   (it just rarely fires on CTE right sides).** Reviewer decision: file a `fix-`
   ticket for the runtime interaction, or accept the gate as the permanent boundary.

3. **The size gate's row estimate needed real plumbing.** The ticket said
   `right.estimatedRows ?? defaultRowEstimate`, but `right.estimatedRows` is
   `undefined` for an `Alias`-over-access right side (pass-throughs don't propagate
   the physical estimate), and a module's own access-plan estimate
   (`getBestAccessPlan().rows` — the true "rows this scan returns", e.g. a vtab
   reporting 60000) lives only in `TableAccessNode.filterInfo.indexInfoOutput.estimatedRows`,
   not in `physical.estimatedRows` (which is the table row count). `estimateRightRows`
   now takes the **max over the right subtree** of both signals. This is what makes
   the ticket's high-latency-vtab motivation actually gate correctly (verified by
   `nlj-inner-connection-reuse.spec`, whose counting module reports 60000 to force
   no-cache). **Tripwire (in code):** the subtree-max over-estimates a large base
   scan that a selective `Filter` shrinks — biasing toward NOT caching such a right
   side (a missed optimization, never a memory hazard).

## Dead-code cleanup (as the ticket required)

The never-firing `inLoop` / `appearsInLoop` / `loopMultiplier` scaffolding was
**removed** (the new rule supersedes it for the only live case):
- `reference-graph.ts`: dropped `TraversalContext.inLoop`/`loopIterations` and
  `RefStats.appearsInLoop`/`loopMultiplier` and the `if (context.inLoop)` block.
- `materialization-advisory.ts`: deleted Rule 6 (loop-context caching) and simplified
  Rule 4 from `parentCount <= 1 && !appearsInLoop` to `parentCount <= 1` (identical
  result — `appearsInLoop` was always false).
- `test/reference-graph.spec.ts`: dropped the assertions on the removed fields.

## How to validate

- **Build/test/lint:** `cd packages/quereus`, then `yarn build`, `yarn test`
  (7029 passing / 13 pending / 0 failing), `yarn lint` (clean). All green as landed.
- **Plan shape** (`test/plan/nested-loop-right-cache.spec.ts`): theta and cross joins
  show a `Cache` under the `Join`; equi-join stays a HashJoin with no Cache;
  right/full joins are NOT cached (driver gate). Golden
  `test/plan/joins/theta-nlj-right-cache.plan.json` locks the full shape
  (`Cache(Alias d)` as the Join's right child). Regenerate goldens with
  `UPDATE_PLANS=true` if a legitimate cache shift appears.
- **Scan count** (`test/vtab/nested-loop-right-cache-scan-count.spec.ts`): a counting
  memory module proves the right table's `query()` is invoked **once**, not per left
  row, under a left-driven theta join — with correct results.
- **Regression guards already green:** `keys-propagation` (≤1-row join FD),
  `nlj-inner-connection-reuse` (large-estimate ⇒ not cached),
  `materialization-advisory-single-pass` (CTE many-anchor plan runs correctly),
  `query-rewrite-join` (MV join-subsumption — its matcher runs pre-PostOptimization
  in production; the spec disables the new rule for its pristine-fragment helper).

## Known gaps / findings index (tests are a floor, not a ceiling)

- **No dedicated correlated-right integration test.** The correlation gate is present
  and unit-logic is covered by `isCorrelatedSubquery`, but I could not cheaply build a
  correlated-right *nested-loop join* at the SQL level (LATERAL support unverified), so
  there is no end-to-end test that a correlated right side is left uncached. If the
  reviewer knows a query that produces a parameterized/lateral right seek under a
  logical `JoinNode`, add one.
- **CacheNode/CTEReference runtime interaction (item 2)** — worked around by a gate,
  not root-fixed. Candidate `fix-` ticket.
- **CacheNode physical transparency (item 1)** — broad change; confirm no consumer
  depended on the old empty physical.
- **`estimateRightRows` conservative over-estimate (item 3)** — tripwire noted at the
  helper; only affects missed caching, never memory safety.
- **Latent `existence`-drop in `rule-mutating-subquery-cache`** — the mutating rule
  reconstructs the join via the raw `JoinNode` constructor and drops `existence` flag
  columns; a `NOTE:` was added at that site. `join-physical-selection` skips existence
  joins so it isn't reachable today, but the mutating rule doesn't guard them. The new
  rule uses `withChildren` so it can't reintroduce this. Consider a `debt-` follow-up.
- **`spill` strategy is unreachable** in the new rule (size cap 50000 <
  `cache.spillThreshold` 100000), so it always uses `'memory'` — documented in the rule.
