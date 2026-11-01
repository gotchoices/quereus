description: Let the planner account for how wide a table's rows are when pricing a read from a slow backend, so a scan of wide rows over a network is priced higher than a scan of narrow ones instead of both costing the same per row.
prereq: module-cost-profile-and-presets
architecture: docs/optimizer-costing.md
files: packages/quereus/src/vtab/cost-profile.ts, packages/quereus/src/vtab/module.ts, packages/quereus/src/planner/stats/table-cardinality.ts, packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts, packages/quereus-store/src/common/store-table.ts
tradeoffs: The per-row latency a module declares is already measured at a reference row width (200 bytes in both in-repo benchmarks), which folds throughput in for typical tables; a bandwidth term only changes plans for tables far wider or narrower than that, and it needs a per-table row-size statistic no module keeps today.
----

# Bandwidth needs a row size to multiply by

Parked from the `module-cost-profile-and-presets` plan pass. The cost profile prices a read as `firstRowLatencyMs + rows × perRowLatencyMs`. A `bytesPerSecond` field was considered and left out because the cost model has no notion of bytes per row: without a row size there is nothing to multiply a bandwidth by, and shipping the field without one would be a knob that does nothing.

## What it would take

1. **A row-size source.** Options weighed, in order of preference:
   - extend the module's row-count answer (`ModuleRowCount` from `getRowCount`) with an optional `avgRowBytes` — the store already keeps a running row count per table and could keep a running byte total beside it at the same write sites; `plannedRowCount` in `planner/stats/table-cardinality.ts` would carry it through;
   - estimate from declared column types (fixed widths for integers and reals, a guess for text and blobs) — cheap, always available, often wrong by an order of magnitude on text-heavy tables;
   - an `ANALYZE`-time column statistic — accurate but stale, and the whole point of the progressive optimizer (`docs/progressive-optimizer.md`) is not to need a scan to plan.
2. **The cost term.** Per-row wall-clock becomes `max(perRowLatencyMs, avgRowBytes / bytesPerSecond)` — latency-bound for narrow rows, throughput-bound for wide ones — applied in the one drain function (`readMs` in `rule-join-physical-selection.ts`) and the per-seek term in `index-nested-loop.ts`.
3. **Presets** gain a `bytesPerSecond` category figure (`localDisk` on the order of 1 GB/s, `browserIdb` 100 MB/s, `network` 10 MB/s, `distributed` 1 MB/s — unmeasured orders of magnitude).

## What would make it worth doing now

A reporter whose remote tables carry rows in the tens of kilobytes (documents, blobs) and whose plans drain them when a seek would have been cheaper.
