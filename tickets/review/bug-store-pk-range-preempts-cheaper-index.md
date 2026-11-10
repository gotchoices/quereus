---
description: When a query filters on both a primary-key range and an indexed column, the persistent storage backend now picks whichever access path its cost estimate says is cheaper, instead of always scanning the primary-key range, and it sizes that range from collected statistics.
files:
  - packages/quereus-store/src/common/store-module-access-plan.ts  # computeFilterAccessPlan decision flow, new leadingPkRangePlan + seekRankingCost, doc comments
  - packages/quereus-store/test/pushdown.spec.ts                   # new describe 'primary-key range against a secondary-index seek (cost decides)'
  - docs/store.md                                                  # § Query Planning: one paragraph on how the arms compete
repro: verified
---

# Primary-key range competes on cost with secondary-index seeks

## What changed

In `computeFilterAccessPlan` (store-module-access-plan.ts) the leading-primary-key range used to `return` before any secondary index was looked at, and sized itself as a fixed `0.3 × N`. Now:

- `leadingPkRangePlan` builds it as a candidate. Rows come from `resolveArmEstimate(tableInfo, filters, 'range', [], firstPkColumn)`, so an analyzed table uses the PK column's histogram and an un-analyzed one keeps the `0.3` constant. Produced rows go through `rowsToProduce` like the other single-window arms. Cost is still `rangeScan(rows, 0.2)`, with no `pointRead` term.
- `seekRankingCost` ranks a seek at `plan.cost`, plus `estimateSortCost(plan.rows)` when the request has a `requiredOrdering` the plan does not satisfy. Ranking only; the advertised cost is unchanged. Used in the secondary best-seek loop and in the PK-range comparison.
- Decision after the secondary loop and the unchanged veto. With a PK range candidate: the secondary seek wins only if it survived the veto **and** ranks strictly below the PK range. Otherwise the PK range wins: on a tie, when the seek was vetoed, and when the only secondary result is cost-only. With no PK range candidate the flow is the same as before.
- PK point lookup and PK multi-seek still return early (out of scope per the ticket). Their comment no longer calls this ticket backlog.

## Plans confirmed with `query_plan()` (1000 rows `(i, i % 100)`, `ix_v on t(v)`)

| query | state | chosen | est_cost |
|---|---|---|---|
| `where id > 0 and v = 7` | not analyzed | ix_v | 130.3 |
| `where id > 0 and v = 7 order by id` | not analyzed | primary | 150.2 (ix_v ranks ≈196.7 with the sort) |
| `where id > 0 and v = 7 order by id` | analyzed | ix_v | 13.3 (PK range now ≈497.7) |
| `where id < 10 and v = 7` | analyzed | primary | 7.7 |
| `select v from t where id < 10` / `id < 900` | analyzed | primary | 7.7 / 452.7 |

The ticket predicted 4.7 and 449.7 for the last row. The engine's `selectivityFromHistogram` comes out about 5 rows high on these `<` bounds (15 rows for `id < 10`, 905 for `id < 900`; the true counts are 10 and 900, since ids start at 0). That is the engine's histogram interpolation and is not touched here.

## Tests added (pushdown.spec.ts, one `describe` after 'cost-based index choice')

Each case asserts the chosen index (`planDetails` matching `USING ix_v` / `USING primary`) and the returned rows:

- un-analyzed `id > 0 and v = 7` → ix_v: the PK range no longer wins by being checked first.
- un-analyzed `... order by id` → primary: pins the sort penalty. Without it, ix_v would win here.
- analyzed `... order by id` → ix_v: a selective seek still wins after paying for the sort, because the PK range is sized from statistics.
- analyzed `id < 10 and v = 7` → primary: the choice follows cost, not "an index always wins".
- analyzed `id < 10` vs `id < 900`: the two `est_cost` values differ and each is within ±5 (ten rows) of `0.2 + 0.5 × true count`. This reproduces the defect that the PK range ignored statistics.

## Validation

- `yarn workspace @quereus/store typecheck`: clean.
- `yarn workspace @quereus/store test`: 1999 passing, `key-set-seek-store.spec.ts` included. No existing expectation moved, including the secondary-vs-secondary 'cost-based index choice' cases under the new sort penalty.
- `yarn test` (all workspaces): all passing.
- `yarn test:store`: 3815 passing, 1 failing. The failure is `28.2-orderby-expression-extras.sqllogic`: a UNIQUE violation inserting `'A'` into a text primary key that already holds `'a'`, which the store keys under NOCASE. The previous ticket (`bug-order-by-ordinal-with-collate-ignored`) added that test without running store mode, and an INSERT never reaches this planning code. It is written up in `tickets/.pre-existing-error.md`.

## Known gaps and things for the reviewer to check

- **Key-set probes**: requests carrying a `runtimeSet` get no special case. When such a probe also bounds the leading PK column, the module now answers with the cheaper of the PK range and the secondary multi-seek, so the cost line the engine fits through 2 and 1000 keys is the lower of the two plans. Both plans name an index, so the probe never reads as "declined". The existing key-set suite stays green, but no test builds a key-set semi join whose probe also carries a leading-PK bound. Add one if you think this case matters.
- **PK range under a plan-time LIMIT**: the PK range's `rows` and `cost` now shrink to `limit + offset` when it claims every filter and satisfies the ordering, as the secondary arms already did. The ticket asked for this, and no existing test moved, but no test pins it on the PK arm.
- The veto still compares the secondary seek to the scan on `vetoCost` without the sort penalty, as specified ("the veto is unchanged"). So a secondary seek that misses a required ordering can pass the veto and then lose to the PK range on rank. That is intended.
