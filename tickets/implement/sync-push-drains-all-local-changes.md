description: A device with more unsent changes than fit in one batch only sends the first batch, and the recovery path can then delete the rows it never sent. The client must keep sending until nothing is left, and recovery must wait for all of it.
architecture: docs/sync.md#snapshots-replace-rows
files:
  - packages/quereus-sync-client/src/sync-client.ts # pushLocalChanges, handleApplyResult, handleSnapshotRequired
  - packages/quereus-sync-client/test/sync-client.spec.ts
  - packages/quereus-sync-client/README.md
  - docs/sync.md
repro: static
----

## The defect

`SyncManager.getChangesSince` returns at most `config.batchSize` facts (default 1000), rounded up to a whole transaction. `SyncClient.pushLocalChanges` calls it once and sends what comes back. Nothing sends the rest:

- `handleApplyResult` promotes the sent watermark and emits an event, but does not push again.
- The handshake pushes once, and the only other trigger is the next local write.
- `handleSnapshotRequired` pushes once, waits for that ack, and then takes the snapshot. A snapshot deletes every row in a covered table that the server's copy lacks, so any row past the first batch is lost.

I read this in the code and did not run it. The test below is the reproduction.

`sync-unrecorded-rows-adopt` depends on this fix, because adopting a populated database produces many batches at once. It is also a data-loss bug today, for a device that goes offline, writes more than one batch, and returns to a server that has pruned past its watermark.

## The fix

Sending continues until `getChangesSince` has nothing left past the acknowledged watermark.

- **Normal path.** When an ack promotes the watermark, `handleApplyResult` starts the next push. `pushLocalChanges` already returns null when there is nothing to send, so the chain ends by itself. Each ack costs one `getChangesSince` call, which reads the change log from the watermark and stops at the batch bound.
- **Recovery path.** `handleSnapshotRequired` replaces its single push and wait with a loop: push, wait for that ack, and repeat until `pushLocalChanges` returns null. The snapshot starts only after the loop ends. Put the loop in a small private method, for example `pushUntilDrained()`.

The two paths must not fight. During recovery the ack handler also starts a push, so a new flag or a check is needed to stop the ack-driven chain while the recovery loop owns sending. Otherwise the same batch goes out twice. That is harmless to the data, because pushes are idempotent, but the loop could wait on an id that a later ack has already subsumed. `waitForAck` already resolves in that case, so choose whichever is simplest and say which in the review handoff.

## Edge cases & interactions

- **Watermark does not advance.** An ack for an unknown or stale request id promotes nothing. Only start the next push when `promoteWatermark` really advanced, or the chain could spin. Check by inspection.
- **Server reports a failed push (`APPLY_CHANGES_ERROR`).** No ack arrives, so the chain stops and the recovery loop rejects as it does today. The existing NOTE in `handleSnapshotRequired` about staying parked still applies. Check by inspection.
- **Socket drops mid-drain.** `rejectAckWaiters` ends the loop, and the reconnect re-pushes from the last acknowledged watermark. Check by inspection.
- **Read-only client, or a snapshot in flight.** `pushLocalChanges` returns null, so the chain never starts. Check by inspection.
- **A local write arrives during a drain.** The debounced push may send an overlapping range. This is idempotent and already possible today. `promoteWatermark` handles out-of-order acks. Check by inspection.
- **Rejected rows.** An `apply_result` with `rejected` entries still acks and advances the watermark, so the drain continues. Rejected rows remain a separate, existing concern.

## Tests

One test in `packages/quereus-sync-client/test/sync-client.spec.ts`, using `MockSyncManager` with a queue of `getChangesSince` results (two batches, then empty): after `snapshot_required`, no `get_snapshot` is sent until the second batch has been sent and acknowledged. This fails today, because `get_snapshot` follows the first ack.

## TODO

- Add the failing test first.
- Add the drain to `handleApplyResult` and the loop to `handleSnapshotRequired`.
- Update the method comments on `pushLocalChanges` and `handleSnapshotRequired`, and the `snapshot_required` row in the client README if its wording implies one push.
- Check `docs/sync.md` for any statement that a push sends everything at once, and correct it.
- Run `yarn workspace @quereus/sync-client test` and `yarn build`.
