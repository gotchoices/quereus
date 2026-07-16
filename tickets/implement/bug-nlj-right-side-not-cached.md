----
description: Nested-loop joins that can't use a hash/merge algorithm (e.g. `a JOIN b ON a.x > b.y`) re-read their entire right-hand table once per left row; add an optimizer rule that materializes a pure, uncorrelated right side once and replays it.
prereq:
files: packages/quereus/src/planner/rules/cache/rule-mutating-subquery-cache.ts, packages/quereus/src/planner/rules/cache/rule-nested-loop-right-cache.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/cache/reference-graph.ts, packages/quereus/src/planner/cache/materialization-advisory.ts, packages/quereus/test/reference-graph.spec.ts, packages/quereus/src/planner/nodes/join-node.ts, packages/quereus/src/runtime/emit/join.ts
difficulty: medium
----

# Cache the right side of a pure nested-loop join

## Summary (reproduced)

A join that stays a logical nested-loop `JoinNode` re-scans its right side once
per left row, because no optimizer rule ever wraps a **pure** right side in a
`CacheNode`. Confirmed via `query_plan()`:

```
select * from a join b on a.x > b.y       -- theta / non-equi
  JOIN            INNER JOIN ON condition
    IndexScan a
    IndexScan b   <-- NO CacheNode; re-opened per row of a
    BinaryOp a.x > b.y

select * from a join b on a.x = b.y        -- equi (control)
  HashJoin        <-- build side materialized once; fine
```

At runtime `emitLoopJoin.driveFromLeft` (`runtime/emit/join.ts:123-145`) calls
`rightCallback(rctx)` inside the per-left-row loop (`join.ts:128`), so the right
pipeline is restarted for every left row → N full scans of `b`. On a
high-per-read-latency vtab this is a 10–100× trap.

## Root cause

The comment at `join.ts:76` claims the optimizer facilitates restart "through a
cache node", but for pure right sides nothing injects one:

- `rule-mutating-subquery-cache.ts` caches only **side-effect-bearing** right
  sides (to pin write-once semantics); pure ones fall through.
- The materialization advisory's loop path (`materialization-advisory.ts`
  Rule 6, `:134`) keys on `stats.appearsInLoop`, but
  `ReferenceGraphBuilder` initializes `inLoop: false` and **never sets it
  true** (`reference-graph.ts:68-71`, `:110-120`) — the whole
  `appearsInLoop` / `loopMultiplier` machinery is dead. Its multi-parent path
  (Rule 5) needs a shared node instance, which a join right side never is.
- `rule-join-physical-selection.ts:95` only converts equi-joins to
  hash/merge (which materialize their build side); non-equi / cross joins
  return `null` and stay nested-loop with an uncached right side.

## Fix — add a dedicated cache rule for pure nested-loop right sides

Mirror `rule-mutating-subquery-cache` but drop the side-effect gate and add the
purity / correlation / size guards. Register it in the **PostOptimization**
pass, `nodeType: PlanNodeType.Join`, immediately after `mutating-subquery-cache`
(optimizer.ts:888-897). Placement matters: by PostOptimization,
`join-physical-selection` has already converted every equi-join it wants to, so
any surviving logical `JoinNode` **is** a nested loop — the exact structural
signal we need. No new reference-graph traversal is required.

Rule logic (`rule-nested-loop-right-cache.ts`):

1. `if (!(node instanceof JoinNode)) return null;`
2. **Driver gate.** Only the *left-driven* join types re-scan the right side:
   `inner`, `left`, `cross`, `semi`, `anti`. `right` / `full` use
   `driveFromRight` (`join.ts:151`), which buffers the left side once and scans
   the right **once** — caching their right side only wastes memory. Skip them.
   (Semi/anti still benefit: they early-`break` on first match but re-open the
   right pipeline per left row, so a replay buffer still saves reopen+scan.)
3. `const right = node.right;`
4. `if (CapabilityDetectors.isCached(right) && right.isCached()) return null;`
   (already cached — e.g. by cte/in-subquery cache).
5. **Purity gate.** `if (PlanNodeCharacteristics.subtreeHasSideEffects(right))
   return null;` — side effects are the mutating rule's job; don't double-wrap.
6. **Determinism gate.** `if (right.physical?.deterministic === false) return
   null;` — a non-deterministic right side (e.g. `random()`) must be re-evaluated
   per row to preserve today's observable behavior; caching would freeze the
   first scan's values.
7. **Correlation gate.** `if (isCorrelatedSubquery(right)) return null;`
   (`planner/cache/correlation-detector.ts`). A right subtree that references
   left attributes (a parameterized/lateral seek produced by predicate
   pushdown) is re-parameterized per left row and MUST NOT be cached. Note the
   plain `a JOIN b ON a.x > b.y` case is *uncorrelated*: the ON predicate is a
   separate `JoinNode.condition` child, not inside the right subtree — so the
   bare `IndexScan b` right side has no external refs and is cacheable.
8. **Size gate (memory safety).** `const rows = right.estimatedRows ??
   tuning.defaultRowEstimate; if (rows > tuning.join.maxRightRowsForCaching)
   return null;` (`maxRightRowsForCaching = 50000`,
   optimizer-tuning.ts:232). Materializing an unbounded right side trades I/O
   for memory — respect the existing threshold. Pick strategy/threshold the
   same way the mutating rule does (`CachingAnalysis.getCacheThreshold(right)`);
   consider `spill` for large-but-under-cap sizes as `materialization-advisory`
   does (`selectStrategy`), but memory + a threshold is acceptable for v1 — the
   `CacheNode` threshold already degrades to pass-through past its limit.
9. Wrap: `const cached = new CacheNode(right.scope, right, strategy,
   threshold);` then reconstruct via
   `node.withChildren(node.condition ? [node.left, cached, node.condition] :
   [node.left, cached])`. **Use `withChildren`, not the raw `JoinNode`
   constructor** — `withChildren` (join-node.ts:254-294) threads `usingColumns`
   AND `existence` through verbatim; the manual constructor call the mutating
   rule uses drops `existence` (see tripwire below).

`sideEffectMode` for the RuleHandle: the rule only fires on side-effect-free
right sides (gate 5), so `'safe'` is defensible, but `'aware'` matches the
sibling cache rules and is future-proof if the purity gate is ever relaxed —
pick `'aware'` unless the registry's `validateSideEffectMode` complains.

## Dead-code cleanup — the `inLoop` machinery

The ticket requires the dead loop-detection path be **wired or removed**. The
new rule supersedes it for the only live case (nested-loop join right sides);
correlated-subquery loop contexts are already handled by run-once fences in the
scalar/IN/EXISTS emitters. So **remove** the never-firing scaffolding rather
than leave a detection path that silently never triggers:

- `reference-graph.ts`: drop `TraversalContext.inLoop` / `loopIterations`
  (always `false` / `1`), and `RefStats.appearsInLoop` / `loopMultiplier` plus
  the `if (context.inLoop)` block (`:110-113`). This is behavior-preserving.
- `materialization-advisory.ts`: delete Rule 6 (`:133-154`) and simplify Rule 4
  (`:111`) from `stats.parentCount <= 1 && !stats.appearsInLoop` to
  `stats.parentCount <= 1` (since `appearsInLoop` was always `false`,
  `!appearsInLoop` was always `true` — identical result).
- `test/reference-graph.spec.ts`: this spec asserts `appearsInLoop` /
  `loopMultiplier` exist (`:51,54,81,82,173,198`). Update it to the trimmed
  `RefStats` shape.

If, on closer look, the implementer prefers to **wire** instead (make the
reference graph set `inLoop`/`loopMultiplier` when descending into a nested-loop
JoinNode's right child, and let Rule 6 do the caching), that is an acceptable
alternative to the dedicated rule — but it entangles the deliberately
strategy-agnostic reference graph with join-driver semantics and is harder to
gate precisely (join type, driver side, correlation). The dedicated rule is the
recommended path; do **not** ship both a live rule and a live advisory loop path
or the right side gets double-wrapped.

## Tests

- **Golden plan** (`test/plan/golden-plans.spec.ts` or a new
  `test/plan/joins/*.spec.ts`): `select * from a join b on a.x > b.y` shows a
  `CacheNode` wrapping the right `IndexScan b`; an equi-join control still shows
  `HashJoin` (no double cache). Add a `right`/`full` join case asserting the
  right side is NOT cache-wrapped (driver gate). Add a correlated-right-side
  case asserting NOT cached.
- **Logic** (`test/logic/*.sqllogic`): a theta/cross join returns identical rows
  with and without the cache (results unchanged).
- **Scan-count** (`test/vtab/` — instrumented/counter memory vtab): the right
  table is scanned **once**, not N times, under a left-driven theta join. Look
  for an existing instrumented vtab pattern before writing a new one.

## Build / validate

- `cd packages/quereus`
- `yarn build 2>&1 | tee /tmp/build.log`
- `yarn test 2>&1 | tee /tmp/test.log; tail -n 80 /tmp/test.log`
- `yarn lint 2>&1 | tee /tmp/lint.log; tail -n 40 /tmp/lint.log`
- Regenerate goldens if the new CacheNode shifts existing snapshots (verify each
  shift is a legitimate new cache on a nested-loop right side, not a regression):
  the golden harness is `test/plan/golden-plans.spec.ts` — check its README for
  the update command.

## Notes / tripwires for the reviewer

- **Latent bug, out of scope:** `rule-mutating-subquery-cache.ts:70-79`
  reconstructs the `JoinNode` via the raw constructor and does **not** pass
  `existence`, so a side-effect-bearing right side on a join that also carries
  `exists … as` flag columns would drop those flags. `join-physical-selection`
  skips existence joins, but the mutating rule does not guard them. Flag this as
  a `NOTE:` at that site (or a follow-up `debt-` ticket) — do not fix inside
  this ticket; use `withChildren` in the NEW rule so it isn't reintroduced.
- Prereq `bug-cache-node-stale-across-statement-executions` has already landed
  (in `tickets/complete/`), so the CacheNode staleness hole this ticket was
  gated behind is closed — no blocker.

## TODO

- Add `rule-nested-loop-right-cache.ts` with the gates above (driver / cached /
  purity / determinism / correlation / size).
- Register the RuleHandle in `optimizer.ts` PostOptimization, after
  `mutating-subquery-cache`.
- Reconstruct the join via `JoinNode.withChildren` (preserve existence/using).
- Remove the dead `inLoop` / `appearsInLoop` / `loopMultiplier` scaffolding from
  `reference-graph.ts` + `materialization-advisory.ts` (Rule 6, simplify Rule 4)
  and update `test/reference-graph.spec.ts`.
- Add golden-plan, logic, and scan-count tests.
- Add a `NOTE:` tripwire at `rule-mutating-subquery-cache.ts` re: dropped
  `existence` on reconstruction.
- Build + test + lint green; regenerate goldens as needed.
