description: Test coverage for ruleAggregatePhysical — branch coverage raised from 70.8% to 86.66%
files:
  packages/quereus/test/plan/aggregate-physical-selection.spec.ts
  packages/quereus/test/logic/109-aggregate-physical-selection.sqllogic
  packages/quereus/src/planner/rules/aggregate/rule-aggregate-streaming.ts
  packages/quereus/test/plan/_helpers.ts
---

## Summary

Added 16 plan-shape tests in `aggregate-physical-selection.spec.ts` and a sqllogic integration suite in `109-aggregate-physical-selection.sqllogic` that together cover every reachable branch of `ruleAggregatePhysical`.

Branches covered:
- Scalar aggregate (no GROUP BY) → StreamAggregate
- Already-sorted source (single PK, composite PK full match, composite PK prefix) → StreamAggregate without Sort
- Unsorted source → HashAggregate (cost-based)
- `isOrderedForGrouping` edge cases: expression GROUP BY, reversed composite PK, extra keys beyond PK, non-prefix key, column mismatch

Remaining uncovered branches (3) are unreachable via SQL with current cost constants and engine behavior. A follow-up ticket was filed: `tickets/plan/dead-sort-stream-aggregate-branch.md`.

## Testing

```bash
yarn test:plans                # 64 passing (includes 16 aggregate-physical tests)
yarn test:all                  # 2100 passing (includes sqllogic 109)
```

## Review notes

- Tests are interface-driven: SQL queries → plan operator assertions via `query_plan()` TVF
- Minor overlap with pre-existing `aggregate-strategy.spec.ts` (3 basic cases) is acceptable — different focus
- Docs in `docs/optimizer.md` are accurate and up-to-date
- Resource cleanup properly handled via `beforeEach`/`afterEach`
