description: Coverage tests for `src/planner/stats/` cardinality estimation — unit tests + sqllogic.
prereq: none
files:
  packages/quereus/test/planner/stats/basic-estimates.spec.ts
  packages/quereus/test/planner/stats/histogram.spec.ts
  packages/quereus/test/planner/stats/catalog-stats.spec.ts
  packages/quereus/test/planner/stats/index.spec.ts
  packages/quereus/test/logic/108-cardinality-estimation.sqllogic
  packages/quereus/src/planner/stats/{basic-estimates,catalog-stats,histogram,index,analyze}.ts
  docs/zero-bug-plan.md §6
---

## Summary

Raised `src/planner/stats/` coverage from 64.8%/51.1%/40.3% to 92.6%/87.4%/97.7% (branches/lines/functions).

## Final coverage (verified)

| File | Lines | Branches | Functions |
|---|---|---|---|
| basic-estimates.ts | 100% | 100% | 100% |
| catalog-stats.ts | 98.3% | 94.7% | 100% |
| histogram.ts | 100% | 86% | 100% |
| index.ts | 100% | 90% | 100% |
| analyze.ts | 18.7% | 100% | 0% |
| **Total** | **87.45%** | **92.59%** | **97.67%** |

`analyze.ts` line coverage is intentionally low: it's exercised end-to-end via `test/optimizer/statistics.spec.ts` and the new `108-cardinality-estimation.sqllogic`, not unit-level.

## Tests added (147 unit + 1 sqllogic)

- **basic-estimates.spec.ts** — All `BasicRowEstimator` methods: filter (30% selectivity, floor 1), join (inner/left/right/full/cross/default, case-insensitive), aggregate (scalar/multi-group, [0.1,0.8] clamp), distinct (70%), limit (offset underflow), `getRowEstimate`/`ensureRowEstimate` (non-writable property invariant).
- **histogram.spec.ts** — `buildHistogram` degenerate inputs (empty, single, all-same), bucket cap, cumulative monotonicity; `selectivityFromHistogram` all operators (`=`/`==`/`<`/`<=`/`>`/`>=`/unsupported), boundary values, `<`/`>` complementary sanity.
- **catalog-stats.spec.ts** — `CatalogStatsProvider`: BinaryOp (`=`,`==`,`!=`,`<>`,`>`,`<`,`>=`,`<=`,LIKE), UnaryOp (IS NULL, IS NOT NULL), IN (listSize/NDV, clamp 1.0, children fallback), BETWEEN (with/without histogram, non-literal bounds, Promise literals), joinSelectivity (NDV, FK→PK both directions, multi-column PK fallback, non-equi), distinctValues (case-insensitive), indexSelectivity (delegation + fallback), zero rowCount, unknown nodeType fallback.
- **index.spec.ts** — `NaiveStatsProvider` heuristics per predicate type; `joinSelectivity` cap 0.5; `distinctValues` 50%/floor/undefined-on-zero; `indexSelectivity` 20% improvement; `createStatsProvider` both maps, fallbacks; `defaultStatsProvider` identity.
- **108-cardinality-estimation.sqllogic** — End-to-end ANALYZE: 40→45 rows, skewed categories, equality+range filters, inner+left joins, re-ANALYZE after inserts.

## Review notes

- Lint: 3 pre-existing issues in new tests (unused import, unused eslint-disable, `any` cast) were fixed during review. `eslint src/planner/stats test/planner/stats` now passes clean.
- Tests use lightweight mock plan nodes (cast via `as unknown as ScalarPlanNode`) rather than building real plans — keeps them focused on the stats logic under test.
- `test:coverage` verified the reported numbers reproduce locally.

## Validation

```bash
yarn workspace @quereus/quereus build     # passes
yarn workspace @quereus/quereus test      # 2419 passing, 0 failing
npx c8 --include 'src/planner/stats/**' ... node test-runner.mjs  # 87.45/92.59/97.67
npx eslint src/planner/stats test/planner/stats  # clean
```
