description: Strengthened fuzz and property tests with result validation, broader SQL generation, skewed data, multi-table queries, and large-scale stress tests
files:
  - packages/quereus/test/fuzz.spec.ts
  - packages/quereus/test/property-planner.spec.ts
----

## What was built

### fuzz.spec.ts (9 tests)
- **Result validation**: determinism check, COUNT non-negative, LIMIT enforcement, ORDER BY sortedness
- **Broadened SQL generation**: correlated subqueries, recursive CTEs, LIKE/GLOB patterns, more functions (total, group_concat), expression depth increased to 5
- **Variable sample counts** via fc.integer arbitraries (not Math.random)

### property-planner.spec.ts (27 tests)
- **Rule fire-rate tracking**: warns when optimizer rules never fire across runs (5 rules currently flagged)
- **Skewed data distributions**: high-cardinality skew, clustered NULLs, monotonic sequences — using fc-generated random thresholds for reproducibility
- **Multi-table queries**: 3-table join commutativity, multi-column join conditions
- **Large-scale stress tests** (500-1000 rows): join commutativity, aggregate invariants, semantic equivalence
- **Strengthened NULL algebra**: parameterized NULL IN, COALESCE with floats/empty strings, IS NULL/IS NOT NULL with floats

## Review fixes applied
- Replaced all `Math.random()` calls with `fc.integer()` arbitraries in both files to preserve fast-check reproducibility and shrinking
- Removed unused `OptimizerTuning` import from property-planner.spec.ts

## Test results
- Full suite: 1412 passing, 2 pending, 0 failures
- fuzz.spec.ts: 9 tests passing
- property-planner.spec.ts: 27 tests passing (including large-scale stress at 120s timeout)
