---
description: VTab-supplied or ANALYZE-based statistics for cost estimation
prereq: VTab API, optimizer cost model, StatsProvider interface
---

## Summary

Statistics infrastructure for cost-based optimization, supporting two modes:

1. **VTab-supplied statistics**: Modules implement `getStatistics()` on VirtualTable to report row counts, distinct values, min/max, and histograms. MemoryTable provides exact stats from its BTree metadata.

2. **ANALYZE command**: `ANALYZE [table]` triggers collection. If the module implements `getStatistics()`, those stats are used; otherwise a full scan collects per-column statistics with reservoir-sampled histograms.

Statistics are cached on `TableSchema.statistics` and consumed by `CatalogStatsProvider` (the new default stats provider), which falls back to `NaiveStatsProvider` heuristics when unavailable.

## Key Files

- `src/planner/stats/catalog-stats.ts` — Types (`TableStatistics`, `ColumnStatistics`, `EquiHeightHistogram`) and `CatalogStatsProvider`
- `src/planner/stats/histogram.ts` — Histogram building and selectivity estimation
- `src/planner/stats/analyze.ts` — Scan-based statistics fallback collector
- `src/planner/nodes/analyze-node.ts` — `AnalyzePlanNode`
- `src/runtime/emit/analyze.ts` — ANALYZE runtime emitter
- `src/vtab/table.ts` — `getStatistics()` optional method on `VirtualTable`
- `src/vtab/memory/table.ts` — `MemoryTable.getStatistics()` implementation

## Review Notes

- **Test fix**: Added missing `import { describe, it, beforeEach, afterEach } from 'mocha'` and eslint directives to `test/optimizer/statistics.spec.ts`
- **Docs updated**: Added ANALYZE section to `docs/sql.md`, statistics section to `docs/module-authoring.md`, updated `StatsProvider` description in `docs/optimizer.md`
- All 25 statistics tests pass; full suite (665 tests) passes
- TypeScript compiles cleanly
