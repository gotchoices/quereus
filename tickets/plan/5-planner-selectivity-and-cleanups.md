description: Filters always assume they pass exactly half their rows because the real statistics the planner already collects can't reach the place that needs them; route the estimate through a stage that has access to those stats, and clean up a few smaller related loose ends.
files: packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/stats/index.ts, packages/quereus/src/planner/framework/context.ts, packages/quereus/src/planner/debug.ts
difficulty: medium
----

## Problem (primary)

Filter selectivity is hardcoded to `0.5` (`nodes/filter.ts:50-57`) — every filter is assumed to pass half its input. Meanwhile a real statistics layer exists (histograms, `OptContext.stats`, under `stats/`) but is *unreachable* from where the estimate is made: node-level `computePhysical` has **no context parameter**, so a filter can never consult stats.

Do **not** solve this by widening `computePhysical` to take a context (that would thread `OptContext` through every node). Instead, route selectivity estimation through a **Physical-pass rule** that already has `OptContext` (and therefore `stats`) in scope, letting it set the filter's selectivity from histograms when available and fall back to a heuristic otherwise.

Note relationship to the broader backlog vision `adaptive-query-optimization` (progressive/tiered stats): this ticket is the concrete near-term step that makes the *existing* catalog/histogram stats actually reachable for filter selectivity; it does not require the adaptive-feedback machinery.

## Expected behavior

When stats (e.g. a histogram) are available for a filter's predicate, the filter's estimated selectivity reflects them; when absent, it falls back to a documented heuristic (not silently always 0.5). The estimate is computed in a stage that legitimately holds `OptContext`.

## Secondary cleanups (fold in; each small)

- **Convergence-model contract is undocumented.** The pass convergence model silently prevents a rule from re-firing on its own output — filter-merge, for instance, loops *internally* to reach a fixpoint precisely because it cannot rely on being re-invoked on its own result. This is an unwritten contract that trips up new rule authors. Document it (in `docs/optimizer.md` and/or a `NOTE:` at the convergence site) so authors know a rule will not be re-offered its own output and must self-loop if it needs a fixpoint.
- **`planner/debug.ts` uses `any`.** Replace with proper types per the project no-`any` rule.
- **Dead `OptimizationContext` surface.** There is an `OptimizationContext` surface that appears unused; confirm it is dead across `packages/quereus` (including tests) and remove it, or document why it must stay.

## Direction

The primary change is a design choice about *where* the physical selectivity rule sits in the pass pipeline and how it reads `stats`; resolve that (which pass, what stats API it calls, heuristic fallback) before implementing. The secondary items are independent and mechanical; they can land in the same change or be split out if the primary grows large.

## Use case

`explain` on `select * from t where indexed_col = 5` over a table whose module supplies a histogram should show a selectivity derived from that histogram rather than a flat 0.5, while the same query over a stats-less table falls back gracefully.
