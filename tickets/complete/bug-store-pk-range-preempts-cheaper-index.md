---
description: When a query filters on both a primary-key range and an indexed column, the persistent storage backend now picks whichever access path its cost estimate says is cheaper, instead of always scanning the primary-key range, and it sizes that range from collected statistics.
files:
  - packages/quereus-store/src/common/store-module-access-plan.ts  # computeFilterAccessPlan decision flow, leadingPkRangePlan, seekRankingCost, seekSurvivesVeto
  - packages/quereus-store/test/pushdown.spec.ts                   # describe 'primary-key range against a secondary-index seek (cost decides)'
  - docs/store.md                                                  # § Query Planning: how the arms compete
repro: verified
---

# Primary-key range competes on cost with secondary-index seeks

## What shipped

In `computeFilterAccessPlan` (store-module-access-plan.ts), a bound on the leading primary-key column used to return a `_primary_` range scan before any secondary index was looked at, sized at a fixed 30% of the table. Now:

- `leadingPkRangePlan` builds the PK range as a candidate. Its rows come from `resolveArmEstimate`'s `range` arm on the leading PK column, so an analyzed table uses that column's histogram and an un-analyzed one keeps the 0.3 constant. A plan-time LIMIT shrinks it through `rowsToProduce`, like the other single-window arms.
- `seekRankingCost` ranks a seek at its declared cost plus `estimateSortCost(rows)` when the request requires an ordering the plan does not provide. This is used for ranking only; the advertised cost is not changed.
- `seekSurvivesVeto` (added in review) applies the seek-versus-scan veto to each secondary candidate inside the loop. Only the seeks that survive it compete on rank.
- Decision order: PK point lookup and PK multi-seek still return early. After them, the best surviving secondary seek beats the PK range only if it ranks strictly lower. With no surviving seek, the PK range wins if there is one; if not, the scan wins when every seek was vetoed, and after that come the cost-only fallback and then the scan.

PK point lookups and multi-seeks still return early. The ticket kept them out of scope.

## Review findings

**Defect found and fixed: veto applied after ranking.** The implementation ranked the secondary seeks with the sort penalty and only then put the winner through the veto. A seek that provides the required ordering could out-rank a cheaper seek, lose to the scan, and leave the scan as the plan, even though the cheaper seek had beaten the scan. Reproduced on the default cost profile with 1000 analyzed rows: `select id from u where a = 0 and b >= 300 order by b`, with `a = i % 2` and `b = i`. ix_b ranks ≈1050 but costs more than the scan (1000). ix_a ranks ≈1100 but costs ≈650. The old code chose a full scan plus sort; it now chooses ix_a. Fix: `seekSurvivesVeto` is checked per candidate before ranking. The block comment explaining the exemptions moved onto that function, and the four comments that pointed at "the comparison site" now link to it. One side effect: when the cheapest seek is vetoed but another one survives, the survivor is now chosen rather than the scan. That is correct by the veto's own test. Added test: `a seek that out-ranks a cheaper one but loses to the scan does not discard the cheaper one`, in pushdown.spec.ts. I confirmed it fails against the implement-stage code and passes with the fix.

**Implementer's open questions:**
- Key-set probes: no special case is needed. `rule-key-set-seek`'s `probeModuleCosts` sends requests that carry only the runtime-set filter, so a probe can never also carry a leading-PK bound. In `index-nested-loop` probes, the old early PK-range return failed that rule's "seek uses the join key" check. Letting the secondary seek compete there is the same or better.
- PK range under a plan-time LIMIT: it uses the same `rowsToProduce` gate as the other arms, and the scan it must stay below never shrinks, because a PK bound is always an unclaimed filter for the scan. No new test: the gate is shared code that the secondary arms already exercise.

**Tests from the implement stage:** I kept all five. Each pins one branch of the decision: the cost comparison without statistics, the sort penalty in both directions, the narrow PK range winning, and the histogram sizing that reproduces the original defect. None of them restates the implementation.

**Edge noticed, not changed:** on a measured-empty table (`estimatedRows = 0`), the PK range's row count is clamped to 1, so it costs 0.7 against the scan's 0. The doc comment's "never above the scan" claim says `N ≥ 1`. The behavior is the same as before this ticket and does not matter in practice, so no NOTE was added.

**Docs:** I updated docs/store.md § Query Planning to say that each seek faces the scan first and that the PK range always prices below the scan. I also corrected `computeFilterAccessPlan`'s doc, which no longer claims the function never weighs ordering.

**Source size:** store-module-access-plan.ts is 1,851 lines (`wc -l`). The size is already tracked in `debt-oversized-source-files`, and I added the new count there.

**Validation:**
- `yarn workspace @quereus/store typecheck`: clean.
- `yarn workspace @quereus/store test`: 2000 passing.
- `yarn test:store`: 11128 passing, 0 failing. The `28.2-orderby-expression-extras` failure from the implement stage has since been fixed by the triage commit.
- `yarn test` (all workspaces): every suite passing.
- `yarn lint` for this package is a no-op by design.
