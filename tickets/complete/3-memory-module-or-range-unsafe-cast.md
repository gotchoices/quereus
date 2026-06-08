description: Remove unsafe `as any` cast for ranges in MemoryTableModule.findOrRangeMatch
prereq: none
files:
  packages/quereus/src/vtab/best-access-plan.ts
  packages/quereus/src/planner/analysis/constraint-extractor.ts
  packages/quereus/src/vtab/memory/module.ts
----
## What was built

Removed an unsafe `(filter as any).ranges` cast in `MemoryTableModule.findOrRangeMatch` by adding
proper type definitions at the vtab layer:

- **best-access-plan.ts** — Added vtab-level `RangeSpec` interface (`lower`/`upper` with `op` + `value`)
  and optional `ranges?: RangeSpec[]` on `PredicateConstraint`.
- **constraint-extractor.ts** — Planner's `RangeSpec extends VtabRangeSpec`, adding `valueExpr` for
  planner use. Clean type hierarchy.
- **module.ts** — `findOrRangeMatch` accesses `filter.ranges` directly with full type safety.
  Fallback `rangeCount = 2` when ranges is absent is now explicit in the type system.

## Testing

Covered by `test/optimizer/or-multi-range-seek.spec.ts`:
- Disjoint ranges, bounded ranges, mixed equality+range, 3-branch OR
- Plan verification (confirms IndexSeek usage)
- Primary key OR-range
- Edge cases (no matches, single matches)
- Regression tests for single range scan and IN-list multi-seek

Build passes. All OR_RANGE tests pass. The 1 failing test (`10.1-ddl-lifecycle.sqllogic:248`) is
pre-existing and unrelated.
