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
  - packages/quereus-sync/test/metadata/table-identity.spec.ts
  - docs/sync.md                                               # Table identity, repair section, format-version wording
----

# Reclaim a dropped table's sync bookkeeping

## What was built

Dropping a table retires its generation (the per-device random identity its sync records are filed under). Until now those records stayed on disk for good. Reclaim now has two steps:

- **Cell versions (`cv:`) and tombstones (`tb:`) go with the drop.** `TableIdentityStore.retire` scans the generation's two exact prefixes and stages each deletion into the caller's batch, so they commit atomically with the `tg:` removal.
- **Change-log entries (`cl:`) go with the next `repairChangeLog` sweep.** The log is ordered by clock first, so finding one generation's entries takes a full scan, and that sweep already runs one. A retired generation resolves to no name, so its entries resolve to `null` and get deleted.

`retire`, `applySchemaChangeTransitions` and `applyLocalTableTransitions` are now async. All four callers await them: local capture, the applicator and both snapshot receivers.

## Review findings

**Defect found and fixed: the drop could erase a new table's mapping.** `retire` staged the `tg:` delete before its scan. The scan gave a local commit time to run, so a `create table t` or a rename onto `t` could commit a new `tg:t` record first. The retire batch then committed and deleted that record. Everything kept working until the next open, when the new table's records would resolve to nothing. `retire` now stages the delete after the scan, and only if the name is still free. A new test in `test/metadata/table-identity.spec.ts` failed before the fix and passes after it. It drives `TableIdentityStore` directly; the end-to-end path through a replicated drop was traced by reading, not run.

**Filed: `bug-sync-local-create-during-replicated-drop-loses-bookkeeping` (backlog).** A local re-create that commits after the engine ran a replicated drop, but before sync retires the generation, inherits that generation, and the retire then deletes the new table's records. This was found by reading (`repro: static`) and predates this ticket, but the purge makes the loss unrecoverable.

**Fixed inline:** rewrapped three doc comments the implementer left with uneven line breaks (`manager.ts`, and `repairChangeLog` and `resolveLogEntry` in `sync-manager-impl.ts`).

**Tripwires:** none added. The implementer's two `NOTE:` comments on `stageRecordDeletions` stand: one delete per record held in memory until commit, and inbound records that commit after the scan. Reading the scan sites confirmed that the delta, snapshot and repair scans all skip a nameless generation, so the second one's "inert" claim holds for them.

**Checked by reading, nothing found:**

- **Scan bounds:** the generation is length-prefixed in the key, so the prefix scan cannot reach a neighbouring generation.
- **Failure recovery:** a throwing scan reaches `load()` through `withIdentityRecovery` or the capture's own catch, on all four callers.
- **Same-batch staging:** the implementer's claim holds. Local capture runs transitions before any data or re-key staging, and the other three callers use a dedicated identity batch.
- **Data in the same batch as a drop:** `computeBatchTableFates` diverts it before metadata is filed, so it cannot mint a generation for the dropped name.
- **`repairChangeLog` during a retire whose batch then fails:** this can delete entries of a generation that `load()` restores. It does no harm, because the engine has already dropped that table.
- **Eviction:** `evictExpiredBasisTables` acts only on tables already out of the catalog, which leave through a real `drop table`, so no change is needed. The gap for a drop run while sync is detached is already documented in `docs/sync.md`.
- **Caches:** the metadata stores hold no per-record caches, so nothing in memory outlives the purge.

**Considered and left alone:** the snapshot receivers scan a dropped table's records and then clear all metadata anyway. The extra scan is bounded by the dropped table's size, and special-casing it isn't worth a second retire path.

**Tests:** the implementer's test stays. It runs a local and a replicated drop against raw record counts, and it failed with the purge disabled per the handoff (not re-run here). I added the one regression test above, and cut none.

**Docs:** read `docs/sync.md` § Table identity, the repair section and the format-version paragraph, plus the mentions in `docs/sync-schema.md`. They match the code. No doc change was needed for the fix, since it doesn't change what a drop reclaims. The stale ticket reference in `table-identity.ts` is gone.

**Validation:** `yarn workspace @quereus/sync typecheck` exits 0, and `yarn workspace @quereus/sync test` shows 770 passing, 0 failing. Lint was not run: this package's lint script is a no-op. No other workspace's tests were run, and no caller of the changed functions exists outside this package.
