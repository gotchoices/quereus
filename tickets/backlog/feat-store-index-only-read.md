description: On the persistent store, every index match also fetches its full row even when the index already holds all the selected columns, which a reporter measured at about ten times the cost of reading the index alone.
files:
  - packages/quereus-store/src/common/store-table-scan.ts
tradeoffs: Needs the planner to understand and price covering indexes, which nothing credits today, and the store's index entries may not hold decodable column values, so this may be a larger change than the measured gain justifies.
----

Reported in GitHub issue #36, part 1, measured on 4.24.0 with IndexedDB in Chromium; not reproduced here. A covering range cost 0.046 ms per row whether or not the query selected a column outside the index, against the reporter's estimate of about 0.004 ms for reading the index alone. With both indexes present the planner also prefers a narrower non-covering index, because nothing credits coverage.

Part 2 of that issue is tracked on `feat-sort-absorb-blind-to-limit-general`.
