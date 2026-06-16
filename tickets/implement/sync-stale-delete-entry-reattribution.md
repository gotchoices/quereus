description: Dedupe delete change-log entries (mirror the column path) so a delete→reinsert→delete key-reuse leaves at most one delete entry per pk, restoring the scan-time-bound invariant in collectChangesSince and fixing the transaction split.
prereq:
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts        # recordDataEvent delete branch (~347-360); collectChangesSince load-bearing-invariant comment (~474-484)
  - packages/quereus-sync/src/sync/change-applicator.ts        # resolveChange delete branch (~186-206), ResolvedChange (~28-34), commitChangeMetadata delete branch (~303-305)
  - packages/quereus-sync/src/metadata/change-log.ts           # deleteEntryBatch (entryType 'delete' is valid; just never called)
  - packages/quereus-sync/src/metadata/tombstones.ts           # getTombstone
  - packages/quereus-sync/test/sync/sync-manager.spec.ts       # un-skip "does not split a transaction when a stale delete entry re-attributes" (line ~267)
  - docs/sync.md                                               # § Transaction-granularity bounding — remove "Known edge case (delete key-reuse)" block (~302-309)
difficulty: medium
----

# Implement: dedupe stale delete change-log entries to fix scan-time transaction split

## Problem (confirmed reproducible)

`collectChangesSince` (`sync-manager-impl.ts`) detects transaction boundaries off the
**log entry's** HLC (`deterministicTxnId(logEntry.hlc)`), but `buildTransactionChangeSets`
groups off the **resolved version's** HLC (`resolveLogEntry` returns `tombstone.hlc` for a
delete). The scan-time bound is only equivalent to the grouped bound when, for every
non-null-resolving log entry, `logEntry.hlc === resolvedVersion.hlc`.

That invariant holds for **column** entries because an overwrite deletes the prior
change-log entry — both write paths call `changeLog.deleteEntryBatch(..., 'column', ...)`:
- write path: `recordColumnVersions` (`sync-manager-impl.ts:394-404`)
- apply path: `commitChangeMetadata` (`change-applicator.ts:307-318`)

It does **not** hold for **delete** entries: `deleteEntryBatch` is never called with
`'delete'`. A `delete → reinsert(key reuse) → delete` sequence on one primary key leaves
the first delete's change-log entry (`@hlc_d1`) behind. After the second delete the
tombstone is `@hlc_d2`, so the stale `@hlc_d1` log entry resolves (non-null) to
`RowDeletion(hlc_d2)` — it **re-attributes** to the later transaction. The scan-time loop
counts that resolved change under the *earlier* log transaction, reaches `batchSize` one
boundary too early, and `break`s before scanning the later transaction's remaining facts.

Net effect with `batchSize` smaller than the delta: a later multi-fact transaction
(e.g. `{ delete pk[1], insert pk[2] }`) is **split** across two `getChangesSince` rounds —
the pk[1] delete comes out in one ChangeSet and the pk[2] insert arrives only after the
watermark advances. This violates the documented "a transaction is **never** split"
guarantee. (Local reinsert does not consult tombstones, so this is reachable with the
default `allowResurrection: false`.)

The skipped regression test `test/sync/sync-manager.spec.ts` →
"does not split a transaction when a stale delete entry re-attributes" (~line 267) encodes
exactly this case and is the acceptance test.

## Fix: dedupe delete entries the same way columns are deduped

Restore the invariant by deleting a pk's stale delete change-log entry whenever a newer
tombstone replaces it — so at most one delete entry survives per pk, with HLC equal to the
current tombstone. Boundary detection and grouping then agree again, and the pre-existing
(harmless) duplicate-delete emission for this sequence also goes away.

### Write path — `recordDataEvent`, delete branch (`sync-manager-impl.ts:347-360`)

Before `recordDeletionBatch`, look up any existing tombstone for the pk and, if present,
delete its stale delete change-log entry:

```ts
if (type === 'delete') {
    const existing = await this.tombstones.getTombstone(schemaName, tableName, pk);
    if (existing) {
        this.changeLog.deleteEntryBatch(batch, existing.hlc, 'delete', schemaName, tableName, pk);
    }
    const hlc = nextHlc();
    this.tombstones.setTombstoneBatch(batch, schemaName, tableName, pk, hlc);
    this.changeLog.recordDeletionBatch(batch, hlc, schemaName, tableName, pk);
    ...
}
```

### Apply path — `commitChangeMetadata`, delete branch (`change-applicator.ts:303-305`)

`resolveChange` (delete branch, ~186-206) already fetches `existingTombstone` and only
returns `outcome: 'applied'` when there is no tombstone or the incoming HLC strictly wins
(`compareHLC(change.hlc, existingTombstone.hlc) > 0`). In the latter case the new tombstone
overwrites the old one, leaving the old delete log entry stale. Plumb that prior tombstone
through `ResolvedChange` — mirror the existing `oldColumnVersion` field:

- Add `oldTombstone?: Tombstone` to the `ResolvedChange` interface (~28-34); import
  `Tombstone` from `../metadata/tombstones.js`.
- In `resolveChange`'s applied-delete return, set `oldTombstone: existingTombstone ?? undefined`.
- In `commitChangeMetadata`'s delete branch, before `recordDeletionBatch`:
  `if (resolved.oldTombstone) ctx.changeLog.deleteEntryBatch(batch, resolved.oldTombstone.hlc, 'delete', change.schema, change.table, change.pk);`

Plumbing the already-fetched tombstone is preferred over a second `getTombstone` read.

### Why not key boundary detection off the resolved HLC (rejected)

A re-attributed entry appears at its *log* position (before the later transaction's own
entries), so keying the boundary counter off the resolved HLC makes `currentTxnId` jump out
of order and the counter mis-fire. Dedup at write time is the clean fix.

## Notes / out of scope

- `change-log.ts:deleteEntryBatch` already accepts `entryType: 'delete'` (it builds the key
  generically) — no signature change needed.
- Stale **column** change-log entries left behind by a row *delete* (`deleteRowVersions`
  removes `cv:` rows but not their `cl:` entries) resolve to null and are correctly skipped,
  so they are not a correctness bug. Cleaning them would shrink the scan footprint the
  bounding work targeted, but it is **out of scope** here — note it in the review handoff if
  you touch the area, don't expand scope.
- Update the load-bearing-invariant comment in `collectChangesSince`
  (`sync-manager-impl.ts:474-484`): once delete entries are deduped, the DELETE-not-deduped
  caveat no longer applies — rewrite it to state the invariant now holds for both entry types.

## Acceptance

- Un-skip the regression test (`it.skip` → `it`, ~line 267); it passes.
- All existing quereus-sync tests stay green (the ticket cites ~254 sync tests).
- Add a `delete → reinsert → delete` coverage case to the round-trip / multi-round delta
  tests — mixed with a multi-fact transaction and a `batchSize` smaller than the delta —
  asserting across rounds: no repeats, no gaps, and the multi-fact transaction is never
  split. (The existing regression test asserts the single-round shape; this adds the
  multi-round watermark-advance assertion.)
- Remove the "Known edge case (delete key-reuse)" block in `docs/sync.md` (~302-309) and, if
  warranted, fold a one-line "delete entries are deduped like columns" note into the
  surrounding § Transaction-granularity bounding prose so the invariant is documented.

## TODO

- [ ] `recordDataEvent` delete branch: look up existing tombstone, delete its stale delete change-log entry before recording the new tombstone/entry.
- [ ] `ResolvedChange`: add `oldTombstone?: Tombstone` (import `Tombstone`).
- [ ] `resolveChange` applied-delete return: set `oldTombstone`.
- [ ] `commitChangeMetadata` delete branch: delete the stale delete change-log entry via `oldTombstone.hlc`.
- [ ] Rewrite the load-bearing-invariant comment in `collectChangesSince` to reflect delete dedup.
- [ ] Un-skip the regression test; confirm it passes.
- [ ] Add the multi-round delta coverage case (delete→reinsert→delete + multi-fact txn, small batchSize): no repeats/gaps/split.
- [ ] Remove the docs/sync.md "Known edge case (delete key-reuse)" caveat; optionally add the dedup note.
- [ ] Run `yarn workspace @quereus/quereus-sync test` (stream with `2>&1 | tee /tmp/sync-test.log`) and `yarn lint` (in packages/quereus); all green.
