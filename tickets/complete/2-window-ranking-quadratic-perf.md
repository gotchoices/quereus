description: Optimized O(n^2) window ranking functions (RANK, DENSE_RANK, PERCENT_RANK, CUME_DIST) to O(n)
files:
  packages/quereus/src/runtime/emit/window.ts
  docs/window-functions.md
----
## Summary

Replaced per-row O(n^2) ranking computations with a single O(n) pre-pass over sorted partition rows.

### What was built

- `PrecomputedRankings` interface and `precomputeRankings()` function: single linear scan over `orderByValues` detecting peer group boundaries via `arePeerRows()`, computing RANK, DENSE_RANK, PERCENT_RANK, and CUME_DIST for all rows in one pass.
- `computeRankingFunction` simplified to O(1) lookups into pre-computed arrays.
- Removed `computeRank()`, `areRowsEqualInOrderBy()`, `getOrderByKey()`, and `orderByKeyNormalizers` parameter chain — all O(n)-per-row helpers that caused the quadratic behavior.

### Key design points

- Reuses the already-materialized `orderByValues` from `sortRows` — no ORDER BY callbacks re-evaluated.
- `arePeerRows()` (synchronous, pre-computed values) shared between ranking pre-computation and frame peer-finding (DRY).
- ROW_NUMBER and NTILE unchanged — already O(1).

### Testing

Comprehensive coverage in `test/logic/07.5-window.sqllogic`:
- RANK/DENSE_RANK with ties (including NOCASE collation)
- PERCENT_RANK edge cases (single-row partition → 0, ties)
- CUME_DIST with peer groups at partition boundaries
- NTILE bucket distribution (multiple sizes)
- ROW_NUMBER (basic + partitioned)
- NULL handling in ORDER BY and PARTITION BY
- Multiple window functions in same query

All tests pass. Build clean. No lint regressions.

### Docs

Updated `docs/window-functions.md` Performance Optimizations section to document the O(n) ranking pre-computation and pre-evaluated ORDER BY value caching.
