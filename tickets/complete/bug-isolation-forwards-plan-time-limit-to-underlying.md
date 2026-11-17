description: Inside a transaction, a query with a row limit could return too few rows or a wrong answer when the storage module stopped reading at that limit, because rows the transaction deleted used up the limit first. The early stop is now a run-time instruction the isolation layer can see and withhold while it has staged changes.
architecture: docs/design-isolation-layer.md
files:
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts
  - packages/quereus/src/planner/rules/shared/index-style-context.ts
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts
  - packages/quereus/src/planner/nodes/table-access-nodes.ts
  - packages/quereus/src/runtime/emit/ordinal-slice.ts
  - packages/quereus/src/planner/rules/aggregate/rule-minmax-index-boundary.ts
  - packages/quereus-isolation/src/isolated-table.ts
  - packages/quereus-isolation/src/isolation-module.ts
  - packages/quereus/src/vtab/best-access-plan.ts, packages/quereus/src/vtab/filter-info.ts
  - packages/quereus-isolation/test/plan-time-limit-truncation.spec.ts
  - packages/quereus/test/optimizer/monotonic-limit-pushdown.spec.ts, packages/quereus/test/optimizer/minmax-index-boundary.spec.ts
  - docs/module-authoring.md, docs/optimizer-retrieve.md, docs/design-isolation-layer.md, docs/optimizer.md, docs/optimizer-streaming.md, docs/invariants.md
----

## What shipped

**Contract.** `BestAccessPlanRequest.limit` (with `offset`) licenses a module to *price* against `limit + offset` rows and choose a plan that only pays off under that bound. The only stop a module may apply is `FilterInfo.limit`, read at `query()` time. A wrapping module (the isolation layer) must be able to withhold the stop at run time, and plans are cached across transactions, so the stop cannot live in state the wrapped module kept from planning.

**Engine stamps the granted bound.** `probeAccessPlan`, the single place that sends `request.limit`, returns `{ plan, rowBound }` with `rowBound = limit + offset` when it keeps a plan asked with a limit. `buildAbsorbed` (constant `order by … limit n [offset m]`, the `min`/`max` boundary read, the ordered branch of a `limit ?` choice) records it as `IndexStyleContext.rowBound` unless a residual predicate remains. `ruleSelectAccessPath` stamps it as `FilterInfo.limit` only on a bare `SeqScan`/`IndexScan`/`IndexSeek` leaf (`stampRowBound`); a leaf wrapped in a collation-residual or reattached-claim `Filter` gets no stamp. `OrdinalSlice` replaces any planned limit/offset with its own window.

**Isolation withholds the stop on merged reads.** `IsolatedTable.mergedQueryWithConnection` strips `limit` and `offset` before both sides of the merge and applies them to the merged stream (`applyRowWindow`). The no-overlay fast path and committed-snapshot reads forward `FilterInfo` untouched. `IsolationModule.getBestAccessPlan` still forwards `request.limit`/`offset` so pricing keeps working.

**Review addition: a LimitOffset is never grown into a Retrieve.** See findings.

## Tests

- `packages/quereus-isolation/test/plan-time-limit-truncation.spec.ts`: a positive control (the bound reaches the underlying when nothing is staged), the deleted-row and re-keyed-row reproductions for `min(id)`, and an ordinal-seek case (`order by id limit 2 offset 1` after deleting id 1 returns `[3, 4]`).
- `monotonic-limit-pushdown.spec.ts`: the leaf now observes `limit = 105` (`limit 5 offset 100`) when the slice rule cannot fire.

Validation in review: `yarn build`, `yarn test` (all workspaces, 11181 quereus passing), `yarn test:store` (11174 passing), `yarn lint`, `yarn typecheck` — all green.

## Review findings

Read the `ticket(implement): bug-isolation-forwards-plan-time-limit-to-underlying` diff first, then every touched file and doc.

- **Correctness of the isolation strip — checked, no issue.** Every underlying/overlay `query()` call inside the merge (`mergedQuery`'s three arms, `queryOverlayAsMergeEntries`) is reached only through `mergedQueryWithConnection`, so all receive the unwindowed `FilterInfo`. `findUnderlyingUniqueConflict` builds its own `FilterInfo` and never had a window. No other in-tree module forwards `FilterInfo` to a wrapped module. `applyRowWindow` handles `limit 0`, absent limit, and offset-only correctly.
- **In-tree truncation — checked.** Neither memory nor store reads `FilterInfo.limit` at query time; the store only prices with `request.limit` (`rowsToProduce`). So the fix matters for out-of-tree batching modules and for the contract; in-tree answers were never affected. The test double is the only truncating module, which is why the positive control matters.
- **Other `FilterInfo.limit` readers — checked, no issue.** `rule-key-set-seek` and `index-nested-loop` decline a stamped leaf; a stamped leaf sits directly under a LIMIT, which the INL peel gate already refuses. No plan or optimizer spec regressed.
- **Major, fixed inline: `fallbackIndexSupports`' LimitOffset arm (pre-existing, flagged by the implementer).** Growing a LimitOffset swallows it into `Retrieve.source`, which never executes once an index-style context exists, so a committed grow would drop the LIMIT entirely. Its only acceptance condition was "the plan provides the equipped ordering", which makes swallowing a Sort sound but never a LIMIT; `docs/invariants.md` (OPT-026) and `docs/optimizer-retrieve.md` stated that wrong rule. It was dormant (probed `order by … limit n offset m` with and without filters, via subquery, desc, secondary index — all correct; the top-down pass never revisits the LimitOffset after `tryLimitedSortAbsorb`), and the min/max rewrite relied on an "absent OFFSET is load-bearing" refusal to stay out of it. Rather than file a ticket, removed the arm at its one site: `canTranslateToIndexConstraints` no longer accepts `LimitOffset` (comment says why), the arm and its now-unused imports are gone, `fallbackIndexSupports` probes with a plain `ask(request)` since it never asks with a limit, and its context no longer calls `grantedRowBound`. Any commit of that arm was wrong and any decline equals not entering it, so the removal cannot change a correct plan; full suites confirm. Updated the min/max rule NOTE and spec comment (the pinning test is kept), OPT-026, and the optimizer-retrieve § Re-probing and § The granted row bound bullets.
- **Tripwire, already parked by the implementer:** a Filter re-grow over an absorbed `where … order by … limit n` drops the run-time stop (`NOTE:` at the `indexCtx` construction in `fallbackIndexSupports`). Answers unaffected. Left as is.
- **Docs — checked.** module-authoring, optimizer-retrieve, design-isolation-layer, optimizer, optimizer-streaming, best-access-plan and filter-info comments all describe the new contract consistently. Fixed one stale `grantedRowBound` doc line that referred to the removed re-grow path. No `docs/invariants.md` entry for the "stop only on `FilterInfo.limit`" rule: it is a module-authoring contract already stated there and on the type, not an engine invariant with a code guard, so none added.
- **Tests — checked.** All four isolation cases pin a defect or the positive control the defect tests depend on; no test restates the implementation. No tests added or cut in review: the LimitOffset-arm removal is guarded by the existing "LIMITOFFSET survives directly above the access leaf" spec.
- **Source hygiene — no issue.** New helpers are small and single-purpose; `rule-grow-retrieve.ts` shrank by ~75 lines in review.
- **Type safety / error handling / resource cleanup — no findings.** `applyRowWindow` returns from the `for await`, which closes the merged generator and its inner iterators.
