description: A server that no longer has a table can keep changes for it and pass them on to devices that still have it. A change made offline and uploaded late was never passed on to a device that had already caught up; each kept change now gets a place in the server's arrival order, so every device that pulls after it arrived receives it.
architecture: docs/sync-unknown-tables.md#store-and-forward-relay
files:
  - packages/quereus-sync/src/metadata/quarantine.ts       # QuarantineEntry.position, serialized `p`, holdPosition(), getMany(), put(…, position?)
  - packages/quereus-sync/src/sync/change-applicator.ts    # HoldOptions / FilingOptions.hold, holdOptions(), HeldFact + heldFacts(), fileAtNextTick, positionsOfExistingHolds, fileFact 'held'
  - packages/quereus-sync/src/sync/sync-manager-impl.ts    # getChangesSince / getChangesToPush pass the axis; buildChangeSetsForPeer (now sync); collectForwardableChanges(peer, since, placeOf)
  - packages/quereus-sync/src/sync/change-grouping.ts      # filedAtOrigin doc only
  - packages/quereus-sync/test/sync/store-and-forward-relay.spec.ts
  - packages/quereus-sync/test/sync/store-and-forward-relay-e2e.spec.ts
  - docs/sync-unknown-tables.md
  - docs/sync-transactions.md
  - docs/migration.md
----

## Summary

Under `unknownTableDisposition: 'store-and-forward'`, a replica that lacks a table holds incoming changes for it in the quarantine store (`qt:` keys) and offers them to peers. A pull's `sinceHLC` is a filing position (where a fact sits in the order changes reached the serving replica), but held changes were filtered and placed by write time, so a change written before a reader's last pull and arriving after it was never offered to that reader.

Landed in `ticket(implement): bug-sync-held-change-late-arrival-not-relayed`:

- The hold step moved onto the commit chain: diverted changes are a fourth fact kind (`'held'`) filed by `fileAtNextTick` at positions off the apply's tick, in the same KV batch as the clock and applied facts. The separate post-commit hold write is gone; `ignore` still writes nothing.
- A re-held change keeps the position it was first held at (`positionsOfExistingHolds`, one batched `QuarantineStore.getMany` inside the commit-chain entry), which keeps two relays that both lack the table from passing a change back and forth. A plain `quarantine` hold re-held as forwardable takes a new position.
- `QuarantineEntry.position` is stored as `p` only when it differs from the change HLC; an entry without it reads as held at its write time.
- `collectForwardableChanges` takes the axis from its caller: `getChangesSince` filters and places by hold position (so held sets carry a `cursor`); `getChangesToPush` stays on write time.
- Tests: reproduction `late-arriving held change › relays a held change written before the reader's watermark but held after it, once` replaces the block that asserted the bug; the ordering and bound tests were revised to arrival order.

## Review findings

Read the implement diff first, then the handoff, then the surrounding code (`commitChangeMetadata`, `fileAtNextTick`, `collectChangesSince`, `change-grouping.ts`, the drain path).

**Checked, sound:**

- **Bound argument with merged groups** (the implementer's open question). On a pull, a held change and the applied part of its transaction filed in the same tick share one group, of which the change-log scan sees only the applied part. This is safe: facts in a tick are sorted by `compareHLC`, which orders wall time, counter, site, then opSeq, so one transaction's facts (applied and held) form one unbroken run, and no change-log entry from another group falls inside a merged group's position range. The union's per-group counts are at least the change-log scan's, so `buildTransactionChangeSets` cuts at or before the scan's cut `C`, and the resume position `M` covers nothing that was not collected. No test added: the property rests on the existing contiguity invariant, which `collectChangesSince` already depends on.
- **Loop-freedom / keep-first rule**: the lookup runs inside the commit-chain entry, so concurrent applies cannot both see an entry missing. The quarantine→forwardable new-position branch is correct (a reader past the old position was never offered it) and cannot loop (the other side's re-hold of a forwardable entry keeps its position). In-batch duplicates of one held change take two positions and the last write wins, which is harmless.
- **Drain path**: `drainHeldChanges` deletes by key, unchanged by the position (which is in the value). The put/delete race between a drain and a concurrent re-hold existed before and cannot arise once the table is present (nothing is diverted).
- **Echo exclusion, snapshot carve-out, legacy entries without `p`, `ignore` disposition, hold-only batches taking a tick**: all as the handoff states.
- **Error handling / resource cleanup**: no new failure paths; `getMany([])` returns early, so a batch with no holds does no extra read.
- **Tests**: the reproduction test pins the defect; the revised ordering and bound tests pin the new arrival-order contract. Nothing to cut. No test was added for the quarantine→forwardable branch: it needs a disposition change between two deliveries of one change (contrived), and the branch is a single condition.

**Fixed inline (minor):**

- `docs/sync-transactions.md` § Write side and § Read side did not mention held changes: added them to the "filed in the same write and tick" sentence and to the `getChangesSince` pseudocode.
- `docs/sync-unknown-tables.md` "Loop-free" did not state the quarantine→forwardable new-position rule the code implements; added one sentence.

**Tripwire:**

- The push path (`getChangesToPush`) still filters held changes by write time against the sent watermark, so a change held after a replica's last push but written before it is not pushed. This loses nothing today because a device's held changes come from the server it pushes to; parked as a `NOTE:` in `getChangesToPush` (`sync-manager-impl.ts`), with the condition (a replica that relays held changes to a peer other than its source).

**Major findings:** none, so no tickets filed.

**Validation:** `yarn workspace @quereus/sync test` 869 passing; `yarn workspace @quereus/sync typecheck` clean. The review edits are comments and docs only, so the build was not re-run.
