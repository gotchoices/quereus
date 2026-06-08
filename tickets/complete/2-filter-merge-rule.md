description: Optimizer rule to merge adjacent Filter nodes into a single AND-combined Filter
files:
  - packages/quereus/src/planner/rules/predicate/rule-filter-merge.ts
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/test/optimizer/filter-merge.spec.ts
  - packages/quereus/test/logic/08-views.sqllogic
  - docs/optimizer.md
----

## What was built

`ruleFilterMerge` — a structural rewrite rule that merges adjacent FilterNodes into a single Filter with an AND-combined predicate:

```
Filter(pred_outer) → Filter(pred_inner) → source
→ Filter(pred_outer AND pred_inner) → source
```

Iteratively absorbs all directly adjacent filters in one visit (handles triple+ stacks). Registered in the Structural pass at priority 21 (after predicate-pushdown at 20), so pushdown fires first and may create adjacent filters for merge to clean up.

## Testing

- **filter-merge.spec.ts** (3 tests):
  - View WHERE + outer WHERE → single merged Filter, correct results
  - Nested views → adjacent filters merged (fewer than original count), correct results
  - Correctness preservation → results match expected output through merged filters
- **08-views.sqllogic**: Filter merge correctness case with view WHERE + outer WHERE
- All 277 passing tests unaffected (1 pre-existing failure in 08.1-semi-anti-join.sqllogic, unrelated)

## Key decisions

- Retrieve boundaries between filters prevent merge across view nesting levels (by design)
- The rule is always safe: `Filter(A) → Filter(B)` ≡ `Filter(A AND B)`
- Uses established `(node as any).expression` pattern consistent with predicate-normalizer.ts and constraint-extractor.ts

## Docs

- Added `ruleFilterMerge` and `rulePredicatePushdown` entries to the Predicate section in docs/optimizer.md rule catalog
