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

## What shipped

One read of local changes returns at most one batch (`batchSize`, default 1000 facts, rounded up to a whole transaction), and the client used to send only that.

- **Normal path.** When an acknowledgement moves the sent watermark forward, `handleApplyResult` pushes again. The chain ends when a read finds nothing past the watermark.
- **Recovery path (`snapshot_required`).** `pushUntilDrained` pushes a batch, waits for its acknowledgement, and repeats. The snapshot starts only after a read finds nothing left.
- **Keeping the two apart.** The `recoveryOwnsPush` flag stops the acknowledgement chain while the recovery loop runs, so batches are not sent twice.
- **`pushLocalChanges` returns `sent`, `drained` or `held` instead of an id or null.** Null also meant "no socket", "snapshot in flight" and "send dropped", so a loop built on it would read a dropped send as "all done" and take the snapshot, deleting the unsent rows. Only `drained` lets the snapshot proceed.
- **The wait for pushes already in flight at the start of recovery is gone.** The loop's final empty read makes it redundant. A push in flight when recovery starts can be sent once more; this was observed and is harmless.
- **`connect()` rejects acknowledgement waiters when it replaces a socket,** because it detaches the handlers that would otherwise release them.

Tests added in `packages/quereus-sync-client/test/sync-client.spec.ts`: the normal-path chain, recovery draining every batch before the snapshot, and a failed send holding the snapshot back. `MockSyncManager` now models batching (`changesPerCall`, honours `sinceHLC`).

## Review findings

**Checked by reading the diff with fresh eyes, then the surrounding code:**

- Batch reads are a contiguous prefix in HLC (hybrid logical clock) order on both the bounded path and the from-zero path, because `groupByTransaction` sorts and `buildTransactionChangeSets` cuts on a transaction boundary. Advancing the watermark to a batch's max therefore skips nothing, and forwardable changes and schema migrations hold to the same rule. A read cannot be falsely empty.
- Watermark safety with overlapping pushes: every push starts from an acknowledged watermark, so out-of-order and subsumed acknowledgements stay correct. Traced through concurrent debounced pushes and stale ids from a previous socket.
- Interleaving: `handleMessage` is unserialized, so waiting on an acknowledgement inside a handler cannot deadlock. A stale acknowledgement landing after the loop ends can only re-read from the watermark, or be held while bootstrapping.
- Error paths: a `getChangesSince` failure in the recovery loop lands in the deferred branch with no snapshot, and in the normal path it reaches `handleMessage`'s catch. A socket drop, `disconnect()`, `connect()` replacement and `APPLY_CHANGES_ERROR` all release waiters, and the `finally` clears the flag.
- Two recoveries overlapping on one client: the flag is a boolean, so one can clear it under the other. The worst result is a duplicate send, and the second loop is held once the first starts its snapshot. No change needed.
- The `connect()` line has no test. It was checked by inspection: the rejection is synchronous and the loop's `finally` clears the flag.
- Tests: all three pin a defect the old code had or a new contract, so none were cut and none were added.
- Docs: read `docs/sync.md`, `docs/sync-protocol.md` and the client README against the new behaviour. The implementer's edits are accurate.

**Major, filed:**

- `fix/sync-client-pushes-back-server-changes` (verified by a throwaway end-to-end spec with a real coordinator and clients, since deleted). The push read excludes only changes written by the server, and a coordinator writes none, so devices send back everything they received. This ticket's fix turns that from one batch per trigger into the full volume: a device with no local writes that joined a 7-transaction database sent all 7 back, each `applied: 0`. Separately, a row a device pulled but had not pushed past its watermark returns to the server after the delete was pruned. In the run, B kept the row while A did not. `docs/sync-protocol.md` § Sync Flow already says a device sends "its own local changes", so this is a bug against the spec rather than an open question. The resurrection's handshake push is not part of this diff, so it should predate this ticket for the first batch, but that was not run on the old commit. The fix needs an API decision and has to preserve the store-and-forward relay, so it was not made inline.

**Minor, fixed in this pass:**

- `docs/sync-protocol.md` said the snapshot alone reaches rows the server deleted long ago; added the known exception, pointing at the new ticket.
- Corrected the stale file-size figure in the `SnapshotBootstrap` extraction `NOTE:` in `sync-client.ts` (~1170 to ~1370 lines, measured with `wc -l`). That note's "if the file grows much further" condition is close to tripping; no split was done here.

**Tripwires:**

- Added a `NOTE:` in `pushUntilDrained`: unlike the acknowledgement chain, the loop has no "did it advance" check, and relies on every read's max HLC exceeding the watermark.
- Kept the implementer's `NOTE:`s: the normal-path chain stalling after a failed push (`handleApplyResult`) and recovery staying parked with the socket open (`handleSnapshotRequired`).

**Considered and left alone:**

- `requestSnapshot()` called by the application during a recovery drain stops the recovery without its catch-up `get_changes`. That method's contract already says to call it only with nothing pending, and the next handshake catches up.
- `handleRequestChanges` (peer relay) still sends one batch; nothing in `packages/sync-coordinator/src` sends `request_changes`.
- The pull direction has the same shape of bug and is already tracked by `bug-sync-client-pull-stops-after-one-batch`.
- `pendingLocalChangeCount` is only ever written, never read. It predates this ticket and is harmless.

**Validation:** `yarn workspace @quereus/sync-client test` 90 passing; `yarn workspace @quereus/sync-coordinator test` 135 passing; typecheck passes for both. `yarn workspace @quereus/sync-client lint` is that package's no-op. The review did not re-run `yarn build`; the only source change in this pass is two comments.
