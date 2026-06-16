description: getChangesSince still materializes ALL facts (and all schema migrations) since sinceHLC into memory before grouping+bounding. batchSize caps the *response*, not the *scan*. For large deltas this is an unbounded memory spike. Consider a streaming/bounded extraction that stops scanning once batchSize whole transactions are accumulated.
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts        # collectChangesSince / collectAllChanges / collectSchemaMigrations
  - packages/quereus-sync/src/sync/change-grouping.ts          # buildTransactionChangeSets (currently consumes a fully-materialized array)
----

# Bound `getChangesSince` extraction at scan time, not just response time

## Problem

After `sync-getchangessince-transaction-grouping`, `getChangesSince` emits one
ChangeSet per source transaction, bounded at transaction granularity by
`config.batchSize`. But the bound is applied **after** the full scan: the delta
path (`collectChangesSince`) drains the entire `changeLog.getChangesSince`
iterator, the full path (`collectAllChanges`) drains every column-version and
tombstone, and `collectSchemaMigrations` drains the whole `sm:` range — all into
in-memory arrays — *before* `buildTransactionChangeSets` groups and truncates to
`batchSize` whole transactions. `batchSize` therefore caps the **response size**,
not the **scan footprint**.

This matches the memory profile of the pre-rewrite slice code, so it is not a
regression. It is acceptable today because deltas are expected to be small and
initial sync uses snapshots rather than this path. It becomes a problem if large
deltas are expected (e.g. a peer that has been offline a long time and whose
range is not TTL-expired into a snapshot).

## What a fix looks like

Stop scanning once `batchSize` whole transactions have accumulated, rather than
scanning everything and truncating. The HLC fact scan is already ordered by
`(wallTime, counter, siteId, opSeq)`, so transactions arrive contiguously and in
order — an early exit is natural on the fact side. The awkward part is schema
migrations: they come from a separate `sm:` scan that is **not** HLC-ordered, so
early exit there needs either an HLC-ordered migration index or a bounded
merge-scan that knows the current transaction watermark. Design the migration
side before implementing, or restrict the early-exit to the fact scan and accept
that migrations are still fully scanned (they are few).

Keep the existing invariants: whole transactions only (never split), one
ChangeSet per commit, `ChangeSet.hlc` = the commit's max fact HLC.
