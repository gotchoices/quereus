description: Unit tests for cost model functions verifying monotonicity, relative ordering, and boundary behavior
prereq: none
files:
  - packages/quereus/src/planner/cost/index.ts
  - packages/quereus/test/planner/cost.spec.ts
----

## Summary

90 unit tests covering all 16 exported cost functions plus `chooseCheapest`.

### Test categories

- **Unary functions** (seqScan, indexSeek, indexScan, sort, filter, distinct): data-driven loop covering zero/one/fractional rows, monotonicity, 1M and 1e9 inputs
- **Multi-param functions** (project, aggregate, hashAggregate, streamAggregate, limit, cache): boundary, monotonicity in each dimension, parameter effects
- **Join functions** (nestedLoop, merge, hash): boundary, scaling behavior (product vs sum), sort cost impact, build-side proportionality
- **Relative ordering**: indexSeek < indexScan < seqScan; merge/hash join < nested loop; stream agg < hash agg; limit < full scan — validated at multiple row counts
- **chooseCheapest()**: min cost, ties (first wins), single option, empty throws
- **Edge cases**: fractional rows, 1e9 rows, negative rows (no NaN)

### Review notes

- Tests are property-based (monotonicity, ordering, finiteness) rather than value-pinned, so cost constants can be tuned without test breakage
- DRY via data-driven loop for unary functions and `expectValidCost` helper
- All 90 tests pass; full suite (1412) passes

### Run

```
yarn workspace @quereus/quereus test --grep "Cost model"
```
