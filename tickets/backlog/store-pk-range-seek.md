description: StoreTable.scanPKRange still visits the entire data store and post-filters (documented TODO) — use the PK-prefix/range byte bounds (buildPkPrefixBounds from store-backing-host-substrate) to seek and early-terminate user range scans on the leading PK column.
files:
  - packages/quereus-store/src/common/store-table.ts   # scanPKRange TODO; analyzePKAccess
  - packages/quereus-store/src/common/key-builder.ts   # buildPkPrefixBounds (landed for the backing host)
----

# Refine store PK range-scan bounds

`StoreTable.scanPKRange` iterates `buildFullScanBounds()` and relies on
`matchesFilters` for everything; the in-code TODO notes the bound keys must be
encoded under the same per-PK-column collations the data keys use
(`pkKeyCollations`). The backing-host substrate work introduced exactly that
prefix/bound encoding (`buildPkPrefixBounds`) plus an order-preserving
pending-merge iterate — the user-facing range scan should reuse them.

## Expected behavior

- LT/LE/GT/GE on the leading PK column become encoded-byte `gte/gt/lte/lt`
  iterate bounds (a superset window is fine — `matchesFilters` remains the
  authoritative collation-aware row filter, per the existing
  `honorsCollatedRangeBounds` advertisement).
- DESC leading PK and per-column key collations (NOCASE/RTRIM) produce correct
  windows; custom comparator-only collations fall back to the full scan
  (no registered byte encoder).
- Cost-model/explain expectations unchanged; correctness pinned by logic tests
  that compare range-scan results memory-vs-store (`yarn test:store`).
