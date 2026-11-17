description: Inside a transaction, a query with a row limit can return too few rows or a wrong answer when the storage module stops reading at that limit, because rows the transaction deleted use up the limit before the isolation layer removes them. Fix by making the early stop a run-time instruction the isolation layer can see and withhold while it has staged changes.
architecture: docs/design-isolation-layer.md
files:
  - packages/quereus-isolation/test/plan-time-limit-truncation.spec.ts      # NEW (written in fix stage) — the reproduction; both cases fail at HEAD
  - packages/quereus-isolation/src/isolated-table.ts                        # mergedQueryWithConnection (~:476), underlyingFilterInfoForMerge (~:760), adaptFilterInfoForOverlay (~:741)
  - packages/quereus-isolation/src/isolation-module.ts                      # getBestAccessPlan (~:810) — keeps forwarding the limit; doc comment to update
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts       # probeAccessPlan (~:765) — the one place that knows a limit was granted; sort-absorb (orderedPlanFor ~:1003, buildAbsorbed ~:1015), runtime limit choice (~:1200)
  - packages/quereus/src/planner/rules/shared/index-style-context.ts        # IndexStyleContext — carry the granted bound
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts    # selectPhysicalNode (~:440) builds the leaf FilterInfo — stamp the bound
  - packages/quereus/src/vtab/best-access-plan.ts                           # request.limit contract doc (~:296)
  - packages/quereus/src/vtab/filter-info.ts                                # FilterInfo.limit doc (~:37)
  - docs/module-authoring.md                                                # "limit is a licence" (~:198), pushdown directives (~:788)
  - docs/design-isolation-layer.md
difficulty: hard
repro: verified
----

## The bug

`BestAccessPlanRequest.limit` licenses a module to stop producing rows early. The engine grants it only when `truncationIsSafe` (rule-grow-retrieve.ts) proves nothing between the scan and the LIMIT can discard a row, and that proof only looks at `Filter` nodes.

`IsolationModule.getBestAccessPlan` forwards the request unchanged, so the underlying module gets the licence. But the isolation merged read also discards rows the underlying produced: a committed row deleted, or re-keyed, inside the transaction is shadowed by the overlay. If those rows fill the limit, the underlying has already stopped and the rows that should replace them are never read.

Reproduced by `packages/quereus-isolation/test/plan-time-limit-truncation.spec.ts` (written in the fix stage, both cases fail at HEAD):

```sql
create table t (id integer primary key, a integer);
insert into t values (1, 1), (2, 2), (3, 3);
begin;
delete from t where id = 1;
select min(id) from t;            -- null, expected 2
-- or: update t set id = 10 where id = 1; select min(id) from t;   -- 10, expected 2
```

Run: `node --import ./packages/quereus-isolation/register.mjs node_modules/mocha/bin/mocha.js packages/quereus-isolation/test/plan-time-limit-truncation.spec.ts` from the repo root.

Routes that send a plan-time limit today: the `min`/`max` boundary rewrite (`rule-minmax-index-boundary`), a constant `order by … limit n [offset m]` absorbed into an index ordering, and a placeholder `order by … limit ?` (the ordered branch of `LimitChoiceNode`, planned at its largest bound N). No in-tree module truncates (memory ignores the limit, the store uses it only for pricing), so only out-of-tree modules such as lamina are exposed.

## Root cause

The truncation is invisible at run time. A module learns its licence in `getBestAccessPlan` and keeps it in private plan state, so the one layer that knows whether rows will be discarded later (the isolation merge, at run time, depending on whether this transaction has staged rows for the table) has no way to withhold it. Plans are cached across transactions, so the decision cannot be made at plan time either.

## Fix (chosen design)

Make the granted bound a run-time instruction on the scan, so a wrapper can see and withhold it.

1. **Engine stamps the granted bound into `FilterInfo.limit`.** When `probeAccessPlan` keeps a plan that was asked WITH a limit, the bound `limit + offset` travels with the plan (a new optional field on `IndexStyleContext`, e.g. `rowBound`), and `selectPhysicalNode` stamps it as `FilterInfo.limit` on the leaf it builds (no `offset` — the offset is still skipped by the `LimitOffsetNode` above, exactly as today). For the placeholder-LIMIT ordered branch, stamp the plan-time N (the largest bound the plan ever runs under). A re-probe that strips the limit, or a re-grow that replaces `moduleCtx`, must drop the bound.
2. **Contract change: a module truncates only to `FilterInfo.limit`.** `request.limit` stays a licence to *price* against the bound and to choose plans that need it (the ordered arm in `plan-time-limit-truncation-safety.spec.ts`); the stop itself must be read from `FilterInfo.limit` at `query()` time, never from state saved in `getBestAccessPlan`. Update the docs on `BestAccessPlanRequest.limit`, `FilterInfo.limit`, and `docs/module-authoring.md` (both the "`limit` is a licence" section and the pushdown-directives paragraph, which currently calls `FilterInfo.limit` a soft cap pushed only by `OrdinalSlice`). Say plainly why: a wrapping module must be able to withhold the stop.
3. **Isolation withholds the stop on merged reads.** In the merged path (overlay present for the table) the isolated table removes `limit` and `offset` from the FilterInfo it forwards to the underlying (`underlyingFilterInfoForMerge`) and to the overlay (`adaptFilterInfoForOverlay`), and applies them itself to the merged output: skip `offset` rows, then stop after `limit`. Do this once around the three merge arms (in `mergedQueryWithConnection` or `mergedQuery`), not per arm. The no-overlay fast path keeps forwarding FilterInfo untouched, so a transaction with no staged rows for the table, and every read outside a transaction, keeps the module's early stop.
   - The `offset` half fixes a second instance at the same site: an underlying that advertises `supportsOrdinalSeek` gets `FilterInfo.offset` from `OrdinalSlice` and seeks to the kth *committed* row, while staged inserts and deletes shift positions. `OrdinalSlice` does not re-apply the offset above the leaf (runtime/emit/ordinal-slice.ts), so the isolated table must apply it to the merged stream. No in-tree module advertises ordinal seek; this was read from the code, not run.
4. `IsolationModule.getBestAccessPlan` keeps forwarding `limit`/`offset` unchanged (the store's limit-aware pricing in `rowsToProduce` and an out-of-tree module's limit-only ordered arm both depend on it). Update its doc comment to say why that is now safe.

### Rejected alternatives

- **Strip `limit`/`offset` in `IsolationModule.getBestAccessPlan`.** Simple and always correct, but the store under isolation (the normal persistent configuration) loses its limit-aware pricing, and a module whose ordered arm exists only under a bound loses it — `min(c)` would become a full scan plus aggregate. Also loses the early stop outside transactions, where it is safe.
- **Probe the underlying twice (with and without the limit) and return the limit-free plan at the limited plan's price.** Only works when both probes pick the same shape; for the module shapes above they do not.

### Things to check while implementing

- Other readers of `FilterInfo.limit` change behaviour once granted plans carry it: `rule-key-set-seek.ts` (~:229, ~:248) and `rules/join/index-nested-loop.ts` (~:178, ~:205) decline leaves with a pushed limit; `equalitySeekKeyColumns` (vtab/filter-info.ts) stops treating such a seek as rows-per-key feedback; `enumeratesWholeTable` (runtime/emit/scan.ts ~:328) stops treating the scan as a whole-table pass. The last two are corrections (a truncated scan really does not see every row). For the first two, run the planner/optimizer specs and confirm no plan regresses; a granted bound only sits under a LIMIT with nothing that can discard rows in between, so those rewrites should rarely meet one. If one does regress, decide whether a separate field is warranted and record the reason.
- `OrdinalSlice` already writes `FilterInfo.limit` (the user's LIMIT, with `offset` as a seek). It overrides the leaf's FilterInfo, so a stamped bound underneath is simply replaced — confirm that.
- The store module does not read `FilterInfo.limit`; leave it that way unless trivially worthwhile.

## TODO

- Carry the granted bound from `probeAccessPlan` through `IndexStyleContext` to the leaf FilterInfo in `selectPhysicalNode`; cover the boundary rewrite, constant sort-absorb, and the placeholder-LIMIT ordered branch.
- Isolation merged read: withhold `limit`/`offset` from underlying and overlay, apply them to the merged output; leave the fast path untouched.
- Switch the double in `plan-time-limit-truncation.spec.ts` to truncate from `FilterInfo.limit` in `query()` (drop the `getBestAccessPlan` cap recording), and add one positive control in that spec proving the bound reaches the module (e.g. record the `FilterInfo.limit` the double saw on the `min(id)` scan outside a transaction is 1) — without it the spec would pass even if the engine never stamped the bound.
- Update the comment on `IsolationModule.getBestAccessPlan` and the doc comments on `BestAccessPlanRequest.limit` / `FilterInfo.limit`.
- Docs: `docs/module-authoring.md` (licence section + pushdown directives), `docs/design-isolation-layer.md` (merged read withholds the run-time stop; offset applied to the merged stream), and `docs/optimizer-retrieve.md` if it describes where the bound goes.
- `yarn build`, `yarn test`, `yarn lint` (quereus lint type-checks test files). Consider `yarn test:store` since store plans run under isolation.
