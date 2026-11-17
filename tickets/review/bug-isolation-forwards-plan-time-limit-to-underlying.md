description: Inside a transaction, a query with a row limit could return too few rows or a wrong answer when the storage module stopped reading at that limit, because rows the transaction deleted used up the limit first. The early stop is now a run-time instruction the isolation layer can see and withhold while it has staged changes; review the fix.
architecture: docs/design-isolation-layer.md
files:
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts                # probeAccessPlan returns ProbedPlan { plan, rowBound }; grantedRowBound; buildAbsorbed / fallbackIndexSupports record it; OrderedBound.plan is a ProbedPlan
  - packages/quereus/src/planner/rules/shared/index-style-context.ts                 # IndexStyleContext.rowBound
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts             # stampRowBound — bare leaf only
  - packages/quereus/src/planner/nodes/table-access-nodes.ts                         # TableAccessNode.withRowBound
  - packages/quereus/src/runtime/emit/ordinal-slice.ts                               # override now replaces any planned limit/offset explicitly
  - packages/quereus-isolation/src/isolated-table.ts                                 # mergedQueryWithConnection strips limit/offset; applyRowWindow
  - packages/quereus-isolation/src/isolation-module.ts                               # getBestAccessPlan doc: why forwarding request.limit is now safe
  - packages/quereus/src/vtab/best-access-plan.ts, packages/quereus/src/vtab/filter-info.ts   # contract docs
  - packages/quereus-isolation/test/plan-time-limit-truncation.spec.ts               # reproduction + positive control + ordinal-seek case
  - packages/quereus/test/optimizer/monotonic-limit-pushdown.spec.ts                 # one assertion updated to the new contract
  - docs/module-authoring.md, docs/optimizer-retrieve.md (new § The granted row bound), docs/design-isolation-layer.md (new § Run-time row window), docs/optimizer.md, docs/optimizer-streaming.md
----

## What changed

**Contract.** `BestAccessPlanRequest.limit` (with `offset`) is now a licence to *price* against `limit + offset` and to choose a plan that only pays off under that bound. The only stop a module may apply is `FilterInfo.limit`, read at `query()` time. Reason, stated in the docs: a wrapping module (the isolation layer) must be able to withhold the stop at run time, and plans are cached across transactions.

**Engine stamps the granted bound.**
- `probeAccessPlan` (the single funnel that sends `request.limit`) now returns `{ plan, rowBound }`, where `rowBound = limit + offset` when the plan was asked with a limit and kept.
- The context built from that plan records it as `IndexStyleContext.rowBound`: `buildAbsorbed` (constant `order by … limit n [offset m]`, the `min`/`max` boundary read, and the ordered branch of a `limit ?` LimitChoice, where it is the plan-time N) and `fallbackIndexSupports` (only its LimitOffset arm asks with a limit). `grantedRowBound` omits it when the context has a residual predicate.
- A re-grow builds its context from its own probe, so it drops the bound (as the ticket required). NOTE left at the site: a Filter re-grow over an absorbed `where … order by … limit n` loses the stop even when carrying it would be sound.
- `ruleSelectAccessPath`'s index-style branch stamps it via `stampRowBound` as `FilterInfo.limit`, **only on a bare `SeqScan`/`IndexScan`/`IndexSeek`**. If `selectPhysicalNode` wrapped the leaf in a `Filter` (collation residual over a coarser index, or a reattached claimed-but-unconsumed filter), no stamp: that Filter can reject rows the module counted, and under isolation staged rows reach it unchecked against constraints the `FilterInfo` does not carry. This goes beyond the ticket text; it closes a gap where the old private-state truncation could underproduce under a collation residual.
- `OrdinalSlice`'s override now strips the base `limit`/`offset` before writing its own, so the slice owns the run-time window explicitly. Before, it relied on its LIMIT always being finite.

**Isolation withholds the stop on merged reads.** `IsolatedTable.mergedQueryWithConnection` removes `limit` and `offset` from the FilterInfo before `mergedQuery`, so all three merge arms (primary, secondary, unordered) and both sides (underlying and overlay) get it unwindowed. `applyRowWindow` then skips `offset` rows of the merged output and stops after `limit`. The no-overlay fast path and committed-snapshot reads forward FilterInfo untouched. `IsolationModule.getBestAccessPlan` still forwards `request.limit`/`offset`, so store pricing (`rowsToProduce`) and bound-only ordered arms keep working.

## Tests

- `packages/quereus-isolation/test/plan-time-limit-truncation.spec.ts`. The double now truncates from `FilterInfo.limit` (and honours `FilterInfo.offset`) in `query()` and records each limit it sees. The private plan-time cap is gone.
  - *reaches the underlying when the transaction staged nothing*: positive control. `select min(id)` hands the module `FilterInfo.limit = 1`. Without it the other cases would pass even if the engine stamped nothing.
  - *is not used up by a deleted committed row* / *by a re-keyed committed row*: the original reproduction (`min(id)` returned NULL / 10, expected 2).
  - *an ordinal seek counts positions in the merged stream*: new. An `OrdinalSeekModule` double advertises `monotonicOn` + `supportsOrdinalSeek`. After `delete … where id = 1`, `order by id limit 2 offset 1` must be `[3, 4]`; without the fix it was `[2, 3]`. This verifies the ticket's offset arm, which the fix stage had only read from code.
  - All three regression cases were confirmed failing with the isolation strip temporarily removed, and passing with it.
- `packages/quereus/test/optimizer/monotonic-limit-pushdown.spec.ts`, *vtab does NOT observe offset/limit when rule cannot fire*: the limit assertion is now `105` (`limit 5 + offset 100`, the planner's granted bound). `offset` is still asserted undefined. This is the intended behaviour change, and it also pins `limit + offset` stamping for constant sort-absorb.

Validation: `yarn build`, `yarn test` (all workspaces green), `yarn lint`, `yarn typecheck`, `yarn test:store` (11174 passing) all pass.

## Things for the reviewer to check

- **Other `FilterInfo.limit` readers.** `rule-key-set-seek` and `index-nested-loop` decline leaves with a pushed limit; `equalitySeekKeyColumns` and the scan emitter's `enumeratesWholeTable` treat a stamped leaf as not whole-table / not rows-per-key. No planner or optimizer spec regressed. I did not hunt for a plan where one of these declines now costs something; the bound only sits under a LIMIT with nothing discarding in between, so INL/key-set targets there should be rare.
- **Bare-leaf-only stamping** means an out-of-tree module that claims a non-seek filter (LIKE etc.) no longer gets a stop where it would have truncated before. Answers are unaffected; only batch prefetch is lost. The docs now say so (module-authoring "limit is a licence", optimizer.md handledFilters section).
- **Pre-existing, not touched: `fallbackIndexSupports`' LimitOffset arm swallows the LimitOffset into `Retrieve.source`, which never executes.** If that arm ever commits a plan, the LIMIT is lost outright, or applied as `limit + offset` with the offset never skipped. My change keeps the bound consistent there (stamped like any other kept plan) but does not fix the swallow. I could not reach the arm: `order by … limit n offset m` directly, via subquery, via CTE, and with a pushed filter all return correct rows, because the top-down pass absorbs the Sort under the LimitOffset first and the grow rule is not re-applied to the replacement node. Decide whether this deserves a `debt-` ticket (repro would be `static`).
- The OrdinalSlice offset arm was verified with a double. No in-tree module advertises ordinal seek.
- `docs/invariants.md` has no entry for the truncation licence. I did not add one.
