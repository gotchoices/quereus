description: competing-plan ordering selection in MemoryTableModule + providesOrdering invariant
files: packages/quereus/src/vtab/memory/module.ts, packages/quereus/src/vtab/best-access-plan.ts, packages/quereus/test/optimizer/ordering-index-competition.spec.ts, packages/quereus/test/optimizer/desc-index-ordering.spec.ts, packages/quereus/test/vtab/best-access-plan.spec.ts
----

## What landed

Replaced the arbitrary `cost * 0.9` "ordering discount" in `MemoryTableModule.adjustPlanForOrdering`
with a real **Plan A vs Plan B** competition between the chosen filter plan (with optional sort cost)
and an ordering-walk over a satisfying index (with residual-filter cost). Strengthened
`validateAccessPlan` to require `orderingIndexName` whenever `providesOrdering` is non-empty AND to
require `indexName === orderingIndexName` when both are set — catching the original cross-index
correctness bug at the boundary for any vtab module.

### Key changes

- **`packages/quereus/src/vtab/memory/module.ts`**
  - New tuning constants: `SORT_COST_PER_COMPARISON = 0.1`, `RESIDUAL_FILTER_COST_PER_ROW = 0.2`.
  - Helper `estimateSortCost(rows)` for `O(n log n)` cost estimate (returns 0 for ≤1 rows).
  - `adjustPlanForOrdering` now competes:
    - **Plan A**: keep filter plan; claim ordering only if its index satisfies and the access
      pattern is monotonic (no OR_RANGE, no multi-IN on an ordered column). Otherwise leave the
      plan unchanged and add an external-sort cost for comparison only.
    - **Plan B**: cheapest ordering-walk produced by new `evaluateOrderingOnlyPlans`, which for
      each ordering-satisfying index either reuses a useful seek/range from `evaluateIndexAccess`
      or falls back to a pure ordering scan via `AccessPlanBuilder.rangeScan`. Adds residual cost
      per unhandled filter.
  - Plan B always sets `indexName === orderingIndexName === <chosen index name>`, satisfying the
    new validator invariant.

- **`packages/quereus/src/vtab/best-access-plan.ts`**
  - `validateAccessPlan` now throws `StatusCode.FORMAT` when `providesOrdering` is non-empty without
    `orderingIndexName`, or when `indexName` and `orderingIndexName` disagree.

### Tests

- New `packages/quereus/test/optimizer/ordering-index-competition.spec.ts` covers:
  - Selective filter on secondary index + ORDER BY on PK column (results in PK order).
  - Same-index range + ORDER BY (no SORT).
  - Tiny table, no index on filter column → PK ordering scan + residual filter.
  - Pure ORDER BY matching secondary index (ordering-only IndexScan).
  - PK range + ORDER BY on PK (no SORT).
  - Cost-comparison crossover sweep at sizes 3 / 50 / 500 — output always sorted regardless
    of which physical plan wins.
- `packages/quereus/test/vtab/best-access-plan.spec.ts` updated existing `providesOrdering`
  fixtures to include `orderingIndexName`, plus new regression tests for the validator.
- `packages/quereus/test/optimizer/desc-index-ordering.spec.ts` continues to pass under the
  new cost model (DESC index for ORDER BY DESC, multi-IN forces SORT, composite ASC/DESC index).

## Use cases

```sql
-- Selective filter on secondary index, ORDER BY on PK column.
-- Plan A (idx_status seek + sort) typically wins for selective filters.
CREATE TABLE t (id INTEGER PRIMARY KEY, status TEXT) USING memory;
CREATE INDEX ix_status ON t(status);
SELECT id FROM t WHERE status = 'active' ORDER BY id;

-- Tiny table or unselective filter, no useful index for the filter col.
-- Plan B (PK ordering scan + residual filter) wins.
SELECT id FROM t WHERE payload = 'aa' ORDER BY id;

-- Same-index seek + ORDER BY matches that index — no SORT inserted.
CREATE INDEX ix_score ON t(score);
SELECT id, score FROM t WHERE score >= 30 ORDER BY score;

-- Pure ordering, no filters — ordering-only IndexScan on the matching index.
SELECT * FROM t ORDER BY score;
```

## Validation

- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus run build` — clean.
- `yarn workspace @quereus/quereus run test` — 2703 passing, 2 pending, 0 failing.
- `yarn test:store` — not run; memory-only changes. Worth running before a release that touches
  the store path, but no expected breakage.

## Notes for future work

- `indexSatisfiesOrdering` strips equality-bound columns from the index but not from
  `requiredOrdering`. So `where x = c order by x` on an index whose only column is `x` reports
  false even though ordering is trivially satisfied. Pre-existing limitation; out of scope for this
  ticket.
- The cost-tuning knobs (`SORT_COST_PER_COMPARISON`, `RESIDUAL_FILTER_COST_PER_ROW`) are reasonable
  starting points calibrated against the existing `AccessPlanBuilder` cost units. If a stable plan
  later flips, retune the constants rather than chasing the test.
