description: collectChangesSince scan invariant can still break on the APPLY path — two same-pk versions (delete or column) arriving in one applyChanges batch both survive in the change log, re-attributing the older entry to the later version's HLC and re-introducing the transaction-split / duplicate-fact hazard on a relay.
prereq:
files:
  - packages/quereus-sync/src/sync/change-applicator.ts        # applyChanges 3-phase (resolve→apply→commit); resolveChange; commitChangeMetadata dedup branches
  - packages/quereus-sync/src/sync/sync-manager-impl.ts        # collectChangesSince LOAD-BEARING INVARIANT (~485-502)
  - packages/quereus-sync/test/sync/sync-manager.spec.ts       # applyChanges describe block (~554); getChangesSince grouping tests (~84-360)
difficulty: medium
----

# Fix: apply-path within-batch dedup gap (re-attribution still reachable on a relay)

## Background

`sync-stale-delete-entry-reattribution` restored the `collectChangesSince` LOAD-BEARING
INVARIANT — *for every non-null-resolving change-log entry, `logEntry.hlc ===
resolvedVersion.hlc`* — by deduping a pk's stale **delete** change-log entry whenever a newer
tombstone overwrites it (mirroring the existing **column** dedup). When the invariant holds,
scan-time boundary detection (keyed on `logEntry.hlc`) and grouping (keyed on the resolved
version's HLC) agree, so a transaction is never split across `getChangesSince` rounds.

That fix is **complete on the local write path** (`recordDataEvent` / `recordColumnVersions`,
which read the current version *before* each write and dedup synchronously).

## The bug

On the **apply path** (`applyChanges`), the dedup is incomplete. `applyChanges` is a 3-phase
pipeline: Phase 1 `resolveChange` resolves **all** incoming changes against the store *before
any writes*; Phase 3 `commitChangeMetadata` then writes. The dedup keys off the
already-fetched prior version (`resolved.oldTombstone` / `resolved.oldColumnVersion`), which is
read in Phase 1 from **pre-batch** state.

So when **two versions of the same key arrive in one `applyChanges` batch**, both
`resolveChange` calls observe the same pre-batch prior version and neither sees the other:

- **Delete:** two deletes for one pk (`hlcA < hlcB`, e.g. concurrent deletes from two origin
  sites relayed together). Both resolve with `oldTombstone = <pre-batch, often undefined>`,
  both are `applied`, and Phase 3 records **both** delete entries (`@hlcA` and `@hlcB`).
- **Column:** two writes to the same `(pk, column)` in one batch — identical shape via
  `oldColumnVersion`. This gap **pre-dates** the delete ticket; the delete path now merely
  reaches parity with it.

Both stale entries then resolve (non-null) to the single current version (`hlcB`), so on the
relay's subsequent `getChangesSince`:
- the `@hlcA` entry re-attributes to `txn(hlcB)` while boundary detection counts it under
  `txn(hlcA)` → **scan-bound mis-count → the later transaction can split across rounds**, and
- both entries resolve to the same `RowDeletion(hlcB)` → a **duplicate fact** in one ChangeSet.

This is exactly the hazard the original ticket eliminated for the local path, re-introduced on
any node that *applies* changes (a relay / coordinator). It needs ≥3 nodes (two origins +
one relay) and same-key versions landing in a single sync round — common with concurrent
deletes of the same row in a mesh.

## Expected behavior

After applying any batch, the change log holds **at most one entry per key** (per pk for
deletes, per `(pk, column)` for columns) and that survivor's HLC equals the current version's
— identical to the post-write-path invariant — regardless of how many versions of a key were
batched together. `getChangesSince` then emits each surviving fact exactly once with no
transaction split.

## Repro sketch

- Two ChangeSets in **one** `applyChanges` call, each deleting the same pk with increasing
  HLCs from different site IDs (so neither is skipped by the `change.hlc <= existingTombstone`
  guard). Assert via `getChangesSince(otherPeer)` that pk surfaces **once** (today: twice),
  and pair it with a `batchSize=1` multi-round walk (cf. the existing
  `walks a multi-round delta…` test) to assert no later transaction splits.
- Mirror for columns: two `(pk, column)` writes with increasing HLCs in one batch → one
  surviving `cl:` column entry.

## Direction (not prescriptive)

Make the apply-path dedup robust to in-batch repeats — e.g. track, within
`commitChangeMetadata`, the max HLC already written per key this batch and delete any prior
entry (including one written earlier in the same batch); or pre-collapse incoming changes by
key (keeping the max-HLC version, deleting losers' entries) before Phase 3. Keep the column
and delete paths symmetric. Re-confirm the `collectChangesSince` invariant comment still holds
verbatim once fixed.
