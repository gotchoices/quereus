---
description: When a query filters on both a primary-key range and an indexed column, the persistent storage backend always scans the primary-key range, even when its own cost estimate says the other index reads far fewer rows. The primary-key range estimate also ignores collected statistics, so it cannot tell a narrow range from a wide one.
files:
  - packages/quereus-store/src/common/store-module-access-plan.ts  # computeFilterAccessPlan (leading-PK range arm returns early), resolveArmEstimate, rowsToProduce, orderingAlreadySatisfied, the best-seek loop
  - packages/quereus-store/src/common/cost-profile.ts               # estimateSortCost, SORT_COST_PER_COMPARISON (0.1)
  - packages/quereus-store/test/pushdown.spec.ts                   # 'cost-based index choice (declaration order must not decide)' block is the model for the new tests
  - packages/quereus-store/test/key-set-seek-store.spec.ts          # guard: engine key-set probes must keep planning as before
repro: verified
---

# The primary-key range arm wins by position, and prices itself from a constant

## Reproduction (verified, 2026-11-09)

Scratch spec on a store-backed `t(id integer primary key, v integer)` with `create index ix_v on t (v)` and 1000 rows `(i, i % 100)`, plans read from `query_plan()`:

| query | state | chosen | est_cost | rows |
|---|---|---|---|---|
| `select id from t where id > 0 and v = 7` | not analyzed | `INDEX RANGE t USING primary` | 150.2 | 300 |
| `select id from t where v = 7` | not analyzed | `INDEX SEEK t USING ix_v` | 130.3 | 100 |
| `select id from t where id > 0 and v = 7` | after `analyze t` | `INDEX RANGE t USING primary` | 150.2 | 300 |
| `select id from t where v = 7` | after `analyze t` | `INDEX SEEK t USING ix_v` | 13.3 | 10 |
| `select v from t where id < 10` | after `analyze t` | `INDEX RANGE t USING primary` | 150.2 | 300 |
| `select v from t where id < 900` | after `analyze t` | `INDEX RANGE t USING primary` | 150.2 | 300 |

Every query returned the correct rows (10, 10, 9, …). This is a speed problem only: whichever path loses, its filters stay in the residual `Filter`.

Correction to the original fix ticket's arithmetic: the second argument of `AccessPlanBuilder.rangeScan(rows, c)` / `eqMatch(rows, c)` is a fixed per-seek cost, not a per-row cost. The real formulas (`packages/quereus/src/vtab/best-access-plan.ts`) are:

- leading-PK range: `0.2 + 0.5 × rows`, with `rows = 0.3 × N` → `0.2 + 0.15 N` (150.2 at N = 1000). It reads the data store directly, so no `pointRead` term.
- secondary `eq` seek: `0.3 + 0.3 × rows + pointRead × rows`, with `rows = 0.1 × N` and parity `pointRead = 1.0` → `0.3 + 0.13 N` (130.3 at N = 1000).

So without statistics the index is about 13% cheaper, not 2×. After `ANALYZE` the gap is 11× (13.3 against 150.2) because only the index arm reads the statistics.

## Root cause

One site: the leading-PK range branch of `computeFilterAccessPlan` in `store-module-access-plan.ts` (the `if (hasLeadingPkRange) { … return { ...plan, ...ordering }; }` block). It has two defects:

1. It `return`s before the secondary-index loop runs, so the arms never compare costs. The fix for `bug-store-index-choice-ignores-cost` made secondary indexes compete with each other, but the primary-key range still wins just by being checked first.
2. It sizes itself as `Math.floor(estimatedRows * 0.3)`, a hard-coded constant, where every secondary arm calls `resolveArmEstimate`. The primary-key column's histogram is in `tableInfo.statistics.columnStats` like any other column's, so `resolveArmEstimate(tableInfo, request.filters, 'range', [], firstPkColumn)` already gives the right answer. When no statistics apply it falls back to `ARM_SELECTIVITY.range = 0.3`, the same constant used today, so un-analyzed tables keep their current primary-key plan cost.

The point-lookup arm (full primary-key equality) and the primary-key multi-seek arm are out of scope and keep returning early. A single-row point lookup is the cheapest plan by construction, and the multi-seek arm's early return is what stops a full-key `IN` from being shadowed. Its comment (around the `resolvePrimaryKeyPins` call) refers to this ticket as backlog; update it.

## The rule to implement

**The leading-PK range becomes a candidate, not an early return.** Build it the same way as today, with three changes:

- rows from `resolveArmEstimate(..., 'range', [], firstPkColumn)` (still `Math.max(1, Math.floor(estimatedRows × selectivity))`);
- the produced-row count passed through `rowsToProduce(request, rows, ordering.providesOrdering, handledFilters)`, as every secondary single-window arm and the scan already do. Without this, a plan-time LIMIT shrinks a competing index arm's price but not the PK arm's, which would tilt the new comparison;
- cost stays `AccessPlanBuilder.rangeScan(producedRows, 0.2)`, with no `pointRead` term because it reads rows directly from the data store.

**Ranking: cost plus the sort the plan would force.** When the request has a `requiredOrdering`, a candidate whose `providesOrdering` does not satisfy it (`orderingAlreadySatisfied` false) is ranked at `plan.cost + estimateSortCost(plan.rows)`. Otherwise it is ranked at `plan.cost`. The penalty affects ranking only and is never added to the advertised `cost`. This answers the open question in the original ticket: `... where id > 0 and v = 7 order by id` should not give up the PK walk's ordering to save less than the sort costs. `chooseOrderingPlan` uses the same idea (`bestWalk.cost < filterPlan.cost + sortCost`), so this reuses it rather than adding a new heuristic. Put it in one small helper and use it in both places a seek candidate is ranked: the PK-range-versus-best-secondary comparison and the existing best-seek loop over secondary indexes. If the secondary loop's existing tests move because of the penalty, look at why before keeping the change. The expected effect there is nil or small, because both competitors usually fail the same ordering and the penalty grows with `rows`, which already tracks cost.

**Ties keep the PK range** (strict `<` for a secondary seek to displace it). The PK range is the first candidate, which matches the "first candidate wins a tie" rule the secondary loop follows.

**The seek-versus-scan veto is unchanged and only judges secondary seeks.** A PK range always prices below the full scan. With a PK range bound there is at least one filter the scan leaves unclaimed, so `rowsToProduce` gives the scan its full `N` rows, and `0.2 + 0.5 × r ≤ 0.2 + 0.5 N < N` for any `N ≥ 1`. So the decision is:

- the secondary loop and veto run as today and produce either a winning secondary seek or nothing (no index usable, or the veto rejected it);
- if a PK range candidate exists: return the secondary seek when it ranks strictly below the PK range, otherwise the PK range. When the veto rejected the secondary seek, return the PK range, not the scan. When the only secondary result is a cost-only fallback, also return the PK range: a cost-only plan is a full scan advertising a lower cost, which is the case the existing comment at the `costOnlyFallback` return warns about;
- no PK range candidate: exactly today's flow.

Rank with `plan.cost`, not `vetoCost`. The parity repricing in `vetoCost` exists so that a shape-constant estimate cannot switch an arm off for every query when it is judged against the scan. The secondary-vs-secondary loop already ranks on `plan.cost`, and this comparison is the same kind of comparison.

**Engine-synthesized key-set probes** (`request.filters` carrying a `runtimeSet`) get no special case. Today a PK range always wins such a probe. After the change the probe gets the cheaper of the two, so the cost line the engine fits through 2 and 1000 keys becomes the minimum of two plans. That is still increasing in key count, and the veto exemption for these requests is untouched. `key-set-seek-store.spec.ts` must stay green. If it does not, stop and record what moved rather than adding an exemption by guesswork.

`chooseOrderingPlan` still wraps the result and needs no change.

## Expected plans after the fix (same 1000-row table as the reproduction)

Worked from the formulas above with `SORT_COST_PER_COMPARISON = 0.1`. Implementers should confirm them against `query_plan()`, not copy them in:

- not analyzed, `where id > 0 and v = 7` → `ix_v` (130.3 < 150.2).
- not analyzed, `where id > 0 and v = 7 order by id` → `primary` (ix_v ranks 130.3 + sort(100 rows) ≈ 130.3 + 66.4 = 196.7 > 150.2). This is the case that shows the sort penalty is working; without it `ix_v` would win.
- analyzed, `where id > 0 and v = 7 order by id` → `ix_v` (13.3 + sort(10) ≈ 16.6, against a PK range now sized at ~999 rows ≈ 500).
- analyzed, `where id < 10 and v = 7` → `primary` (PK range ≈ 0.2 + 0.5 × 9 = 4.7 < 13.3). This is the counterpart that shows the choice is decided by cost, not by "an index always wins".
- analyzed, `select v from t where id < 10` and `... where id < 900` → different `est_cost`, near `0.2 + 0.5 × 9` and `0.2 + 0.5 × 899`.

## Tests

Add one `describe` in `pushdown.spec.ts` next to `cost-based index choice (declaration order must not decide)`, modelled on it: each case asserts the chosen path (`planDetails` matching `USING ix_v` / `USING primary`) **and** the returned rows. One case per bullet above. Seed the 1000 rows in a single multi-row `insert`. A 3-row table cannot show this: at `N = 3` both arms clamp to one row and the PK range wins on its smaller fixed cost. The `id < 10` / `id < 900` pair is the reproduction for the statistics arm. Assert that their `est_cost` values differ and each sits within a small tolerance of the expected figure. Do not assert exact floats.

Also run `yarn workspace @quereus/store test` (or the package's `test` script) and `yarn test:store`. A logic test that asserted a `primary` plan on a table carrying a secondary index could move. Check that any such change is the cost rule working as specified before updating the expectation.

## Docs and comments

- Update the doc comment on `computeFilterAccessPlan` / `computeBestAccessPlan`, which says the PK returns are early, to describe the PK-range candidate and the ranking rule.
- Update the comment in the PK equality branch that names this ticket as "backlog … do not fix it here".
- The `ARM_SELECTIVITY` doc block lists the arms that fall back to shape constants. Mention that the leading-PK range uses the `range` entry.

## TODO

- Make the leading-PK range branch of `computeFilterAccessPlan` build a candidate (rows via `resolveArmEstimate(..., 'range', [], firstPkColumn)`, produced rows via `rowsToProduce`) instead of returning.
- Add the ranking helper (`plan.cost`, plus `estimateSortCost(plan.rows)` when a `requiredOrdering` exists and `orderingAlreadySatisfied` fails) and use it in the secondary best-seek loop and in the PK-range comparison.
- Wire the decision: secondary winner after the veto against the PK range (strict `<` to displace). A vetoed secondary or a cost-only-only result falls back to the PK range. No PK range means today's flow.
- Update the doc comments listed above.
- Add the `pushdown.spec.ts` describe block (plan and rows per case, plus the `id < 10` / `id < 900` `est_cost` pair).
- Run the store package tests, `key-set-seek-store.spec.ts` especially, and `yarn test:store`. Examine any moved plan expectation before accepting it.
