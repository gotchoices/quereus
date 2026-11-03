description: A device with more unsent changes than fit in one batch now keeps sending until none are left, and the recovery that replaces its data waits for all of them first, so rows past the first batch are no longer lost.
architecture: docs/sync.md#snapshots-replace-rows
files:
  - packages/quereus-sync-client/src/sync-client.ts # PushOutcome, pushLocalChanges, handleApplyResult, promoteWatermark, handleSnapshotRequired, pushUntilDrained, connect
  - packages/quereus-sync-client/test/sync-client.spec.ts
  - packages/quereus-sync-client/README.md
  - docs/sync.md
  - docs/sync-protocol.md
repro: verified
----

## What changed

One read of local changes returns at most one batch (`batchSize`, default 1000 facts, rounded up to a whole transaction), and the client used to send only that. Now:

- **Normal path.** When an acknowledgement moves the sent watermark forward, `handleApplyResult` pushes again. The chain ends when a read finds nothing past the watermark.
- **Recovery path (`snapshot_required`).** `pushUntilDrained` pushes a batch, waits for its acknowledgement, and repeats. The snapshot starts only after a read finds nothing left.
- **Keeping the two apart.** A new flag, `recoveryOwnsPush`, stops the acknowledgement chain while the recovery loop runs. The ticket left the choice open. The alternative of letting both run was safe but sent every batch twice during recovery.

## Where this departs from the ticket

Each of these is a judgment call the reviewer should check.

- **`pushLocalChanges` no longer returns `null`.** The ticket said to loop until it returned null, but null also meant "no socket", "snapshot in flight" and "the send was dropped". A loop built on that would read a dropped send as "all done" and take the snapshot, deleting the unsent rows. It now returns `sent`, `drained` or `held`, and only `drained` lets the snapshot proceed. This was a live bug before this ticket: the new test for it failed on the old code, where `get_snapshot` went out after a failed push on an open socket.
- **Removed the wait for pushes already in flight** at the start of recovery. It is redundant now, because the loop only ends once a read from the acknowledged watermark comes back empty. It was also a hazard: it could wait on a push from a previous socket and relied on a later acknowledgement to rescue it, which the flag would have suppressed. The cost is that a push in flight when recovery starts can be sent once more. In the end-to-end check below, 7 batches took 8 pushes.
- **`connect()` now rejects acknowledgement waiters when it replaces a socket.** It detaches the old socket's handlers, so nothing else would release them. A parked recovery would keep the flag set and could resume on the new connection. No test covers this line; check it by inspection.
- **`MockSyncManager` models batching instead of using a queue of results.** It now honours `sinceHLC` and has a `changesPerCall` limit, because existing tests with a fixed result would otherwise re-push forever once acknowledgements chain.

## Tests added

All in `packages/quereus-sync-client/test/sync-client.spec.ts`. All three failed before the fix.

- `keeps pushing after each ack until no batch is left`: the normal path sends the second batch on the first acknowledgement and stops by itself after the last.
- `on snapshot_required: sends every batch of unsent work before taking the snapshot`: no `get_snapshot` until the second batch is acknowledged, and no batch goes out twice.
- `on snapshot_required: a push that could not be sent holds the snapshot back`: a failed send on an open socket does not lead to a snapshot.

The ticket asked for one test. The other two cover the normal-path half of the bug and the dropped-send case, each of which would otherwise have no coverage. Cut them if you disagree.

## Validation

- `yarn workspace @quereus/sync-client test`: 90 passing. `yarn workspace @quereus/sync-coordinator test`: 135 passing. Typecheck passes for both, and `yarn build` passes.
- A throwaway end-to-end spec, now deleted, ran real sync managers against a real coordinator with `batchSize` forced to 1 and 7 offline inserts. Normal path: all 7 rows reached the other device and the chain stopped. Recovery, with the server pruned past the device's watermark: all 7 offline rows survived on the device and reached the other device, and the row deleted on the server was removed by the snapshot. It ran only on the fixed code, so it shows the fix works rather than reproducing the old loss; the mock-socket tests above are the reproduction.

## Known gaps

- **A failed or dropped push ends the normal-path chain.** The rest stays safely on the device until the next local write or reconnect. Recorded as a `NOTE:` at the chain in `handleApplyResult`.
- **Recovery can stay parked with the socket open.** After `APPLY_CHANGES_ERROR` or a dropped send, nothing retries until the socket next drops. No data is lost. The existing `NOTE:` in `handleSnapshotRequired` now covers the dropped send too.
- **`requestSnapshot()` called by the application during a recovery drain** makes the recovery stop without its catch-up `get_changes`, which waits for the next handshake. Before this change it joined the transfer and caught up. I treated this as contrived, since that method's contract already says to call it only with nothing pending.
- **Peer relay is untouched.** `handleRequestChanges` still sends one batch, and no code in `packages/sync-coordinator/src` sends `request_changes` today.
- **The pull direction has the same shape of bug** and is tracked separately by `bug-sync-client-pull-stops-after-one-batch`.
