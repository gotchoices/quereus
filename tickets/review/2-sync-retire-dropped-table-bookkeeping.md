description: Dropping a synced table now deletes its leftover conflict-tracking records right away, and the next maintenance sweep clears its change-log entries, so they no longer pile up and get scanned forever.
prereq: sync-table-generation-identity
architecture: docs/sync.md#storage-layout
files:
  - packages/quereus-sync/src/metadata/table-identity.ts       # retire() is async and stages the record deletions
  - packages/quereus-sync/src/sync/sync-manager-impl.ts        # local drop path awaits; repairChangeLog and resolveLogEntry comments
  - packages/quereus-sync/src/sync/change-applicator.ts        # awaits the transitions
  - packages/quereus-sync/src/sync/snapshot.ts                 # awaits the transitions
  - packages/quereus-sync/src/sync/snapshot-stream.ts          # awaits the transitions
  - packages/quereus-sync/src/sync/manager.ts                  # repairChangeLog public doc
  - packages/quereus-sync/test/sync/table-identity-strands-metadata.spec.ts
  - docs/sync.md                                               # Table identity, repair section, format-version wording
----

# Reclaim a dropped table's sync bookkeeping

## What changed

Dropping a table retires its generation (the per-peer random identity its sync records are filed under). Until now the records stayed on disk for good. Reclaim now has two steps:

- **Cell versions (`cv:`) and tombstones (`tb:`) go with the drop.** `TableIdentityStore.retire` scans the generation's two exact prefixes and stages each deletion into the caller's batch, so they commit atomically with the `tg:` removal.
- **Change-log entries (`cl:`) go with the next `repairChangeLog` sweep.** The log is ordered by clock first, so finding one generation's entries takes a full scan, and that sweep already runs one. A retired generation resolves to no name, so its entries resolve to `null` and get deleted.

`retire` is now async, and so are `applySchemaChangeTransitions` and `applyLocalTableTransitions`.

## Differences from the ticket

- The ticket named two callers. There are four: the local capture and the applicator, plus the two snapshot receivers (`snapshot.ts`, `snapshot-stream.ts`), which go through `applySchemaChangeTransitions`. All four await.
- The test went in `table-identity-strands-metadata.spec.ts` rather than `changelog-orphan-cleanup.spec.ts`. That file already has the reconciled two-peer fixture and a `sync bookkeeping does not outlive a dropped table` block.
- The docs also needed a correction outside § Table identity: the format-version paragraph said a drop retires a generation "without touching a row record", which is no longer true.

## Where to look hardest

- **Ordering inside `retire`.** The in-memory index forgets the generation before the first `await`, so nothing running during the scan can resolve the name to it. A scan that throws leaves the index ahead of disk, which is the existing recovery case: all four callers run under `withIdentityRecovery` or the capture's own catch. This was checked by reading the code; no test injects a scan failure.
- **Same-batch staging.** The purge only sees committed records, so anything staged earlier under the same generation would survive it. I found no such path: local capture runs transitions before any data or re-key staging, and the three other callers use a dedicated identity batch. `alter primary key; drop` in one transaction finds no generation at re-key time and skips it. This was also checked by reading, not by a test.

## Tests

Added one test, in `table-identity-strands-metadata.spec.ts`:

- `a drop deletes the table's cell versions and tombstones, and the next repair sweep its change-log entries` runs on both peers, so it covers the local drop (a) and the replicated drop (b). It counts raw KV records for the generation before the drop, after the drop, and after repair, and checks the repair's return value. With the purge disabled it fails with `cv: 3, tb: 1` still on disk after the drop.

Validation: `yarn workspace @quereus/sync typecheck` is clean and `yarn workspace @quereus/sync test` shows 769 passing. No other workspace's tests were run; the changed functions have no callers outside this package.

Relay-only reclaim was checked once with a throwaway spec, since deleted: a manager with no catalog held 2 cell versions and 1 tombstone, held 0 and 0 after an admitted `drop_table`, and repair returned 3. No committed test pins this, because it takes the same `applySchemaChangeTransitions` path.

## Known gaps

- **Snapshot receivers pay a redundant scan.** `snapshot.ts` retires and then clears all metadata anyway. The cost is bounded by the dropped table's size, and I left it alone.
- **Eviction needed no change, by reading only.** `evictExpiredBasisTables` acts only on `detached` tables, which are already out of the catalog, so the drop that detached them has already retired the generation. The exception is the gap `docs/sync.md` already documents: a drop run while sync is detached leaves a live `tg:` record, and nothing reclaims that table's records.

## Tripwires parked

Both are `NOTE:` comments on `TableIdentityStore.stageRecordDeletions`:

- A drop holds one delete per record in memory until its batch commits. If that shows up on very large tables, purge in chunks.
- An inbound batch already staged under the generation can commit after the scan, leaving records nothing purges. They are inert because every scan skips a nameless generation. The race comes from reading the code and has not been reproduced. If such records ever accumulate, add a sweep for nameless generations.
