description: The older whole-database snapshot API can bring deleted rows back to life, because it throws away deletion records and never sends them to the replica being rebuilt.
files:
  - packages/quereus-sync/src/sync/protocol.ts        # Snapshot / TableSnapshot interfaces (no tombstone field)
  - packages/quereus-sync/src/sync/snapshot.ts         # getSnapshot (omits tombstones) / applySnapshot (clears, never restores)
  - packages/quereus-sync/test/sync/snapshot-tombstones-and-drift.spec.ts  # streaming-path analogue to mirror
difficulty: medium
----

## What's wrong

Quereus-sync has two ways to bootstrap a fresh replica from another replica's
state:

- the **streaming** path (`getSnapshotStream` / `applySnapshotStream`), and
- the older **non-streaming** path (`getSnapshot` returning an in-memory
  `Snapshot` object, applied with `applySnapshot`).

A **tombstone** is the record "row R was deleted at time h". It exists so that a
later-arriving *older* write for R is suppressed instead of re-creating ("resurrecting")
the row.

The streaming path was fixed (ticket `sync-snapshot-tombstones-and-drift-phase1`)
to carry tombstones in the snapshot, so deleted rows stay deleted after a
bootstrap. **The non-streaming path was not** — it is the same defect, still open:

- `getSnapshot` (`snapshot.ts`) collects only column-versions and schema
  migrations. The `Snapshot` / `TableSnapshot` interfaces (`protocol.ts`) have
  **no tombstone field**, so tombstones cannot travel.
- `applySnapshot` (`snapshot.ts:177-179`) **deletes** the receiver's existing
  tombstones during its metadata clear and never restores any.

Net effect: after a fresh replica is bootstrapped with `applySnapshot`, it has no
record that R was ever deleted. A straggler/older write for R — already in flight
or delivered later — is applied as if R were merely absent, so **R resurrects and
the two replicas permanently disagree**.

## Expected behaviour

Same guarantee the streaming path now has: a snapshot carries tombstones; a fresh
`applySnapshot` ends with the sender's tombstones, not an empty set; a straggler
older write for a deleted row stays suppressed.

## Notes for whoever picks this up

- This needs an **interface change** (`Snapshot` and/or `TableSnapshot` gaining a
  tombstone collection), which is why it was carved out of the phase-1 ticket
  rather than fixed inline there.
- The streaming path's producer/consumer and its test
  (`snapshot-tombstones-and-drift.spec.ts`, "snapshot carries tombstones") are the
  model to mirror. The non-streaming `applySnapshot` already got the *drift*
  half of the phase-1 fix (pre-commit clock-drift rejection); only the tombstone
  half remains.
- Watch the fully-deleted-row case: a row whose columns were all deleted has a
  tombstone but no live column-versions, so a per-table collection keyed off
  column-version tables would miss it. The streaming fix uses a **global**
  tombstone pass for exactly this reason.
- `getSnapshot`/`applySnapshot` are a public, README-documented API
  (`packages/quereus-sync/README.md:109-110`), so this is a reachable defect, not
  dormant.
