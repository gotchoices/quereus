description: Differential testing — optimizer rule on vs off produces identical results
files:
  packages/quereus/test/fuzz.spec.ts
  packages/quereus/src/planner/optimizer-tuning.ts
  packages/quereus/src/planner/framework/registry.ts
  packages/quereus/src/planner/optimizer.ts
----

## What was built

Phase 5 of `fuzz.spec.ts` — an `Optimizer Equivalence` describe block with 6 differential
property-based tests. Each test creates paired databases (full optimizer vs specific rules
disabled), seeds identical data, runs random queries, and asserts identical result sets.

### Rule categories tested

- **Predicate rules**: `predicate-pushdown`, `filter-merge`
- **Join rewrite rules**: `join-greedy-commute`, `join-key-inference`
- **Subquery rules**: `subquery-decorrelation`
- **Cache/CTE rules**: `cte-optimization`, `in-subquery-cache`, `mutating-subquery-cache`, `scalar-cse`
- **Distinct rules**: `distinct-elimination`
- **All rewrite rules** (catch-all): all of the above plus `projection-pruning`

Only rewrite-phase rules are tested — impl-phase rules prevent physical plan generation
entirely, so disabling them causes expected failures rather than result mismatches.

### Key design points

- Seeding verified: each insert checked for identical success/failure on both databases
- Comparison is order-independent (JSON-sorted rows)
- Both-error = OK, one-error = bug, mismatch = bug
- Resource cleanup via `finally` block closing both databases
- Reuses existing fuzz infrastructure (arbitraries, schema generators, `tryCollectRows`)

### Testing

- 6/6 optimizer equivalence tests pass (~3s)
- Full suite: 1722 passing, 3 pending (pre-existing)
- Build clean, no type errors

### Usage

```bash
yarn workspace @quereus/quereus test --grep "Optimizer Equivalence"
```
