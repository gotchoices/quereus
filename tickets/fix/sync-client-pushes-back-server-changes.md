description: Devices send the server's own data back to it, not just their own edits. This wastes a full upload whenever a device joins, and it can bring back rows that were deleted on the server, leaving devices permanently disagreeing.
architecture: docs/sync-protocol.md#sync-flow-master-to-many-masters
files:
  - packages/quereus-sync-client/src/sync-client.ts # pushLocalChanges reads getChangesSince(serverSiteId, lastSentHLC)
  - packages/quereus-sync/src/sync/sync-manager-impl.ts # getChangesSince, collectChangesSince, collectAllChanges, collectForwardableChanges
  - packages/quereus-sync/src/sync/manager.ts # SyncManager interface
  - packages/sync-coordinator/test/_e2e-harness.ts # real client and coordinator harness, used for the reproduction
  - docs/sync-protocol.md
repro: verified
----

## What is wrong

The protocol document says a device sends "its own local changes (those made while offline)". The code sends more than that. `pushLocalChanges` reads `getChangesSince(serverSiteId, lastSentHLC)`, and that read leaves out only changes *written by* the given site. A coordinator writes nothing itself: everything it holds was written by some device. So the filter removes nothing, and every change a device received from the server counts as unsent until the device's sent watermark passes it.

That has two effects.

**A device re-uploads what it downloads.** A new device with no local writes joined a database holding 7 transactions, with `batchSize` forced to 1 so that each transaction is its own batch. It sent all 7 back to the server, and each batch reported `applied: 0`. From reading the code, the same applies to changes a device receives by broadcast or `get_changes`, and a snapshot apply writes change-log entries that a later read picks up (`snapshot-stream.ts`); only the join was run. Before `sync-push-drains-all-local-changes` only the first batch went out per trigger (read from the diff, not run). Now the push continues until nothing is left, so the full volume is uploaded right away. By extension a device joining a large database would upload all of it; only the 7-transaction case was measured.

**A deleted row can come back.** Observed with a real coordinator and two real clients:

1. Devices A and B are connected. A inserts rows 1 and 2, and they reach B as broadcasts. B writes nothing, so its sent watermark stays behind them.
2. B disconnects. A deletes row 1. The server prunes that tombstone (the record of the delete), which raises its delta floor (the point below which it can no longer serve a complete delta).
3. B reconnects. Its handshake push, and then the push-first step of `snapshot_required` recovery, send row 1's cells to the server. With no tombstone left to block them, the server applies them (`applied: 3`).
4. The snapshot now contains row 1, so B keeps it.

Final state, about 1.5 seconds after B reconnected: B holds rows 1 and 2, and A holds only row 2. The server applied row 1 and the snapshot gave it to B, though its rows were not queried directly. A's own unpruned tombstone should keep blocking the row, so the devices would not converge; that is inferred, not observed over time. This defeats what `snapshot_required` is for, which is removing rows the server deleted long ago.

The handshake push in step 3 was not changed by `sync-push-drains-all-local-changes`, so the resurrection should predate it for rows in the first batch; that ticket extends it to every batch. This was reasoned from the diff, and the reproduction was run only on the code after that ticket.

## Expected behaviour

A device never pushes back to its server a change it learned only from that server. Specifically:

- A device with no local writes sends no data changes after joining or catching up.
- Offline work still goes out in full before a snapshot. A device's own inserts, updates and deletes must survive recovery.
- In the scenario above, row 1 ends up deleted on all three parties.
- A push batch that contains only changes needing no upload must not make the push look finished while real work remains. The recovery snapshot deletes rows on the strength of that "nothing left" answer.

## Constraints to weigh

- **Store-and-forward relay.** `collectForwardableChanges` deliberately re-offers changes from a third device, with that device's original site id, to peers that still have a retired table. A filter on "written by this site" alone would stop that relay.
- **Server data loss.** Today's re-upload could incidentally refill a server restored from an old backup. Nothing documents this as a feature, but check whether anything relies on it.
- **The manager API is transport-neutral.** `getChangesSince` also serves the server's replies to devices, where sending other devices' changes is the whole point. The narrowing belongs to the device's push, whether through an option on the read or a separate read.
- **Reads are bounded.** Filtering after a bounded read can return an empty batch while later batches still hold real work, and the watermark cannot advance past changes that were filtered out without an acknowledgement.

## Reproduction

Use `packages/sync-coordinator/test/_e2e-harness.ts`. To expire the tombstone on the server, get the store entry through the service's `getStore`, set the manager's `retentionHorizonMs` to -1, and call `pruneTombstones()`. To count pushes, wrap `service.applyChanges`.
