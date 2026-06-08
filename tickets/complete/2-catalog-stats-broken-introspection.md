description: Fixed CatalogStatsProvider introspection helpers — column-level selectivity estimation now uses correct property paths
files:
  packages/quereus/src/planner/stats/catalog-stats.ts
  packages/quereus/test/optimizer/statistics.spec.ts
----
## What was built

Fixed 6 property-path mismatches and 3 dead switch-cases in `CatalogStatsProvider`'s predicate
introspection helpers, which caused all selectivity estimation to silently fall through to
`NaiveStatsProvider` heuristics. Replaced duck-typed `as any` casts with properly typed imports.

## Key files

- `packages/quereus/src/planner/stats/catalog-stats.ts` — Fixed helpers: `estimatePredicateSelectivity`,
  `extractColumnFromPredicate`, `extractConstantValue`, `extractBetweenBounds`, `extractEquiJoinColumns`.
  Added `UnaryOp` case for IS NULL/IS NOT NULL, moved LIKE into `BinaryOp` branch.
- `packages/quereus/src/planner/stats/histogram.ts` — Unchanged; used by range/BETWEEN selectivity.
- `packages/quereus/test/optimizer/statistics.spec.ts` — 10 new selectivity tests + existing histogram/ANALYZE tests.

## Testing

35 statistics-related tests pass (10 new CatalogStatsProvider selectivity tests):

- Equality (`=`): returns `1/NDV`
- Not-equal (`!=`): returns `1 - 1/NDV`
- Range with histogram (`>`): histogram-derived selectivity
- Range without histogram (`<`): 1/3 heuristic
- IS NULL: `nullCount / rowCount`
- IS NOT NULL: `1 - nullCount / rowCount`
- BETWEEN with histogram: histogram bounds
- LIKE: 1/3 heuristic
- Join FK→PK: `1/ndv_pk`
- Join without FK: `1/max(ndv_left, ndv_right)`

Full suite: 927 passing, 3 pending.

## Review notes

- Stale comment about "duck typing" updated to reflect typed imports.
- `extractInListSize` updated to use typed `InNode` import instead of anonymous duck-typed cast.
- Docs (optimizer.md, sql.md, module-authoring.md) already accurate; no changes needed.
