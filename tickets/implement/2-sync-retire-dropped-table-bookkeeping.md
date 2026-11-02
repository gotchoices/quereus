description: When a synced table is dropped, delete its leftover conflict-tracking records instead of leaving them to be scanned and shipped to every new device forever.
prereq: sync-table-generation-identity
architecture: docs/sync.md#storage-layout
files:
  - packages/quereus-sync/src/metadata/table-identity.ts       # retire(): purge the generation's cv:/tb: records
  - packages/quereus-sync/src/metadata/keys.ts                 # per-generation scan bounds (already added by the prereq)
  - packages/quereus-sync/src/sync/sync-manager-impl.ts        # repairChangeLog — the cl: orphans this leaves behind
  - packages/quereus-sync/src/sync/maintenance.ts              # the sweep that runs repairChangeLog
  - packages/quereus-sync/test/sync/changelog-orphan-cleanup.spec.ts
  - docs/sync.md                                               # § Storage Layout "Table identity" subsection: what a drop reclaims and when
difficulty: medium
----

# Reclaim a dropped table's sync bookkeeping

After `sync-table-generation-identity` lands, dropping a table retires its generation, so its leftover cell versions and tombstones can no longer be matched by any incoming change (a same-name re-create mints a new generation). They are inert, but not free: every record stays on disk, is read by every full `cv:`/`tb:` scan (the snapshot sender's grouping pass, `pruneTombstones`, `clearExistingMetadata`), and its `cl:` entries are read by every delta extraction until `resolveLogEntry` finds no name for the generation and skips them. Nothing ever deletes them. This is the "secondary effect" of the original bug ticket: `evictExpiredBasisTables` reclaims the table's storage but not its sync metadata.

## Shape

`TableIdentityStore.retire(schema, table, batch)` already removes the `tg:` record. Extend it to stage, into the same batch, the deletion of every `cv:` and `tb:` record under the retired generation. Both are exact prefix scans (`buildTableColumnVersionScanBounds(generation)`, `buildTombstoneScanBounds(generation)`), bounded by the dropped table's size, which is the same bound the drop itself just paid to delete the rows. The scan is async, so `retire` becomes async; both callers (the local drop path in `handleTransactionCommit` and the replicated-DDL path in the applicator's `commitMetadata`) already await inside async functions.

Leave the `cl:` entries alone. The change log is HLC-first, so finding one generation's entries means a full scan, and the existing `repairChangeLog` sweep already deletes every entry whose record is gone. After this ticket the `resolveLogEntry` skip for a nameless generation becomes the same case as an overwritten cell: an orphan the next repair pass removes. Say so in `repairChangeLog`'s doc comment, and in `docs/sync.md` § Table identity state the two-step reclaim: records go with the drop, index entries go with the next repair sweep.

Relay-only deployments (no catalog) retire on the admitted `drop_table` migration, so they reclaim too.

## Test

One test, in `changelog-orphan-cleanup.spec.ts` or a sibling: drop a table that has cell versions and a tombstone, then assert the `cv:` and `tb:` prefixes hold nothing for that generation and that a following `repairChangeLog` removes its `cl:` entries and returns their count. Use the two-peer harness so the replicated-drop path is the one exercised (the local path is a subset).

## TODO

- [ ] `retire` purges the generation's `cv:`/`tb:` records in the caller's batch; make it async and update both callers.
- [ ] `repairChangeLog` doc comment and `docs/sync.md` § Table identity: the two-step reclaim.
- [ ] The test above.
- [ ] `yarn workspace @quereus/quereus-sync test`.
