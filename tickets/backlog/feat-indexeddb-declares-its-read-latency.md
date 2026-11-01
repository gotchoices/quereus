description: The browser storage backend (IndexedDB) now tells the query planner it is "browser storage" using a generic category figure; measure it in a real browser to confirm or correct that figure, and decide whether the fixed 25-millisecond switches for parallel lookups should become cost-based for backends this fast.
prereq: store-providers-adopt-cost-presets
files: packages/quereus-plugin-indexeddb/src/provider.ts, packages/quereus-plugin-indexeddb/bench/README.md, packages/quereus-plugin-indexeddb/bench/arms.mjs, packages/quereus/src/planner/optimizer-tuning.ts, packages/quereus/src/planner/rules/join/rule-fanout-batched-outer.ts, docs/optimizer-costing.md
tradeoffs: The measurement needs a real browser run by a person (the plugin's bench is a manual harness, and fake-indexeddb timings are meaningless), the numbers are device-dependent, and the category figure may already be close enough — so a maintainer may prefer to keep the category until a reporter shows a plan a measured number would fix.
----

# Declare IndexedDB's read latency, and settle the 25 ms gates for sub-millisecond backends

The planner prices a per-row read latency and converts declared milliseconds into cost units (`tuning.latencyCostPerMs`, default 1000). Since `store-providers-adopt-cost-presets`, the IndexedDB provider declares the engine's `browserIdb` category preset (first row 1 ms, each further row 0.01 ms) spread with its measured `pointRead` / `seekPositioning` ratios; the decision is recorded in the `NOTE:` at the provider's `costProfile`. That category is grounded in the bench tables below but was not measured for the purpose.

## What the plugin's bench already says

From `packages/quereus-plugin-indexeddb/bench/README.md` (Chromium 151 / Windows 11, 200-byte rows, medians):

- first-row latency: the smallest whole round trip (arm B, 20 rows in 1 request) is 0.4 ms at 20,000 rows and 2.0–2.5 ms at 100,000; net of row payload, roughly 0.3–2.3 ms;
- full-scan rate: arm C pages 256 rows per request — about 0.0047 ms per row at 20,000 rows and 0.011 ms at 100,000;
- a resolved point read costs about three sequentially scanned rows (`costProfile.pointRead = 3.0`, the derivation is at the provider).

With the cost-unit conversion those translate to roughly 300–2,300 cost units per open and 5–11 per row; the `browserIdb` preset sits at 1,000 per open and 10 per row, inside both bands.

## What to do

- Re-measure first-row and per-row latency in a real browser (the harness may need an arm that times a single cold iterator open and a long sequential iterate separately) and record the tables in the bench README. If the measurement lands outside the `browserIdb` category's order of magnitude, override `firstRowLatencyMs` / `perRowLatencyMs` on top of the spread preset — no decimals beyond what the tables support; otherwise keep the category and record that it was confirmed.
- Check the reporter's shape from GitHub issue #30 (`entry` ≈ 20k, `txn` ≈ 10k, join on the primary key, with and without a selective filter on `entry`) plans as the bench says it should.

## The separate decision: the 25 ms gates

`batchedOuterThresholdMs`, `gatherThresholdMs` and `prefetchProbeThresholdMs` all default to 25 ms (`optimizer-tuning.ts`) — chosen against a synthetic high-latency test fixture. IndexedDB's honest first-row latency clears none of them, so batched index-nested-loop seeks, parallel gathers and prefetch probes never fire on it, even though overlapping its requests is exactly what they are for (the #30 reporter expected batching to engage). Options: keep fixed gates and let a host lower them; make the gates cost-based (fire when the modelled latency saving exceeds the modelled overhead, both in cost units); or derive a per-backend threshold. This is a design decision in its own right — a fixed gate also keeps the parallel machinery away from in-process backends whose latency is noise — and should be stated explicitly, not folded into the declaration.
