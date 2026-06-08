description: Hash aggregate physical operator with cost-based selection vs sort+stream aggregate
files:
  - packages/quereus/src/planner/nodes/hash-aggregate.ts (HashAggregateNode)
  - packages/quereus/src/planner/nodes/stream-aggregate.ts (minor cleanup)
  - packages/quereus/src/planner/rules/aggregate/rule-aggregate-streaming.ts (ruleAggregatePhysical)
  - packages/quereus/src/planner/cost/index.ts (hash/stream aggregate cost functions)
  - packages/quereus/src/runtime/emit/hash-aggregate.ts (emitHashAggregate)
  - packages/quereus/src/runtime/emit/aggregate.ts (exported shared utilities)
  - packages/quereus/src/runtime/register.ts (registered HashAggregate emitter)
  - packages/quereus/src/planner/optimizer.ts (rule ID: aggregate-physical)
  - packages/quereus/test/optimizer/hash-aggregate.spec.ts (12 new tests)
  - docs/optimizer.md (Aggregation section updated)
----

## What was built

A `HashAggregateNode` physical operator that builds a hash map keyed by GROUP BY columns, accumulates aggregate state per group, and emits all groups at the end. The optimizer rule (`ruleAggregatePhysical`) selects between hash aggregate and sort+stream aggregate based on cost.

## Key design decisions

- **No GROUP BY** → always StreamAggregate (single accumulator, no hash map needed)
- **Already sorted input** → always StreamAggregate (no sort overhead, preserves ordering)
- **Unsorted input** → cost comparison: sort+stream vs hash. Hash wins for any non-trivial input (sort is O(n log n) while hash is O(n))
- Hash aggregate uses `serializeKeyNullGrouping` for collation-aware, NULL-grouping key hashing
- Hash aggregate does NOT preserve ordering (`computePhysical` returns `ordering: undefined`)

## Review findings addressed

- **DRY**: Extracted shared `cloneInitialValue` and `findSourceRelation` from `aggregate.ts` as exports, imported in `hash-aggregate.ts` instead of duplicating
- **Redundant dedup**: Removed second deduplication pass in `combineAttributes` (rule file) — first loop already prevents duplicates
- **Type safety**: Replaced `(props as any).uniqueKeys` with `props.uniqueKeys` in both `HashAggregateNode` and `StreamAggregateNode` `getLogicalAttributes()`

## Testing

12 dedicated tests in `test/optimizer/hash-aggregate.spec.ts`:
- Plan selection: HashAggregate for unsorted GROUP BY, StreamAggregate for scalar and pre-sorted
- Correctness: GROUP BY results, NULL grouping, DISTINCT aggregates, HAVING, multiple aggregates, multi-column GROUP BY, NOCASE collation grouping
- Physical properties: HashAggregate has no ordering property
- Edge cases: empty table with GROUP BY returns no rows

All 886 tests pass (1 pre-existing failure in semi-anti-join unrelated to this work).
