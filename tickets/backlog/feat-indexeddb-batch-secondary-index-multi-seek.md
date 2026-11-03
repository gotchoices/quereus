description: In the browser, looking up many keys through a secondary index opens a separate database transaction and makes two requests for each key, which a reporter measured at 14 times the cost of the same lookups by primary key.
files:
  - packages/quereus-store/src/common/store-table-scan.ts # scanMultiSeek, produceMultiSeekEntries
  - packages/quereus-plugin-indexeddb/src/store.ts # readBatch, readBatchedForward
tradeoffs: The figures are the reporter's and need a real browser to confirm, sharing one read transaction across windows has to respect IndexedDB's transaction auto-close, and the store interface would need a batched read other backends may not benefit from.
----

Reported in GitHub issue #35, measured on 4.24.0 in Chromium; not reproduced here because it needs a browser. The issue reports 0.265 ms per key against 0.019 for a primary-key multi-seek, and raw IndexedDB benchmarks in the issue suggest about 5.8 times of that is recoverable without any planner change.

Expected: a secondary-index multi-seek reuses one read transaction across its key windows and avoids the second request where it can. Measure before and after with the issue's harness. This also carries what remains of GitHub issue #30, since a cheaper seek changes which join plan wins on that query.
