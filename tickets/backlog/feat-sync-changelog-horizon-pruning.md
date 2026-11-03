description: Let a long-running sync server drop old entries from its change index by age, so the index is bounded by recent activity instead of by the whole database, now that the server can safely refuse a client that needs history older than what it kept.
prereq: bug-sync-delta-served-past-retention-horizon
architecture: docs/sync.md
files:
  - packages/quereus-sync/src/metadata/change-log.ts           # ChangeLogStore.pruneEntriesBefore — exists, never called
  - packages/quereus-sync/src/sync/sync-manager-impl.ts        # pruneTombstones raises the delta floor; this sweep must too
  - packages/quereus-sync/src/sync/maintenance.ts              # runSyncMaintenancePass, where the new sweep would be listed
  - docs/sync.md                                               # § change log, the paragraph on time-horizon pruning
tradeoffs: Pure storage optimisation with no reported deployment where the change log is materially larger than the data it indexes; it adds a second horizon-driven sweep whose first run over a long-neglected log needs chunking to avoid a memory spike.
----

## Background

`@quereus/sync` keeps an HLC-ordered index (KV prefix `cl:`, the "change log") over live per-cell values and live tombstones so a peer can ask "everything after this point in time" and get a range scan instead of a full database scan. Since `sync-changelog-orphan-cleanup` the index is bounded by live data (one entry per live cell plus one per live tombstone). That is a legitimate cost, not a leak, so this is an optimisation.

`ChangeLogStore.pruneEntriesBefore(hlc)` already exists and its scan-and-stop logic is sound (keys sort by `(wallTime, counter, siteId, opSeq)`, matching `compareHLC`). Calling it with the retention horizon would cap index size by *time* rather than dataset size, attractive for a server hosting large, mostly-cold databases. It drops entries for still-live cells, so a delta from below the pruned point is incomplete.

## Why it was parked, and what changed

Enabling this without a refusal path hands a client offline past the horizon a silently truncated delta. `bug-sync-delta-served-past-retention-horizon` introduces the **delta floor**: the HLC below which a replica can no longer serve a complete incremental delta, raised by every prune of deliverable history and enforced by the server, with client recovery via full snapshot. With that in place this sweep becomes safe by construction: it raises the floor to the greatest HLC it prunes, in the same write batch, and the server refuses anything below.

## Open questions to settle before implementing

- **Axis.** The floor mechanism makes the choice less consequential than it was: whatever is pruned, the floor says so. Time-based (`Date.now() - retentionHorizonMs`, matching tombstone expiry) keeps one knob; watermark-based (prune below the minimum known peer watermark) is lossless but the coordinator records no client watermarks and a peer that never returns pins the log forever. Expect time-based to win; say why in the implement ticket.
- **Cost of the sweep.** `pruneEntriesBefore` accumulates every deleted key into one unbounded `WriteBatch` before writing. On a first run over a long-neglected log that is a large memory spike; it needs chunked batches, and the floor raise has to land with the last chunk (or with each chunk, forward-only) so a crash mid-sweep never leaves pruned entries below the recorded floor.
- **Is it needed at all.** Revisit when a deployment shows the change log materially larger than the data it indexes (measure both before filing the implement ticket), or when the refusal path has shipped and the sweep is a small addition to `runSyncMaintenancePass`.
