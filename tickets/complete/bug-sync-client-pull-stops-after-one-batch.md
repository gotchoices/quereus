description: A device that had fallen behind by more than one batch of changes received only the first batch when it connected and then reported itself as synced. It now keeps fetching until nothing is left, and only then reports synced.
architecture: docs/sync-protocol.md#delta-sync-optimization
files:
  - packages/quereus-sync-client/src/sync-client.ts # handleChanges, advanceReceivedWatermark, requestSnapshot, runSnapshotTransfer, connect, disconnect
  - packages/quereus-sync-client/test/sync-client.spec.ts
  - packages/quereus-sync-client/README.md
  - packages/sync-coordinator/test/_e2e-harness.ts # comment on waitForSynced only
  - docs/sync-protocol.md
repro: verified
----

## What changed

The client now pulls in a loop. After it applies a non-empty `changes` reply and moves the received watermark, it sends `get_changes` again from the new watermark. Only an empty reply ends the loop and reports `synced`. The wire format and `PROTOCOL_VERSION` are unchanged.

- **`caughtUp` flag.** An empty ordered reply sets it. `connect()`, `disconnect()`, the socket's `onclose` and the start of a snapshot transfer clear it. `handleChanges` sets `synced` only when it is true, so a `push_changes` broadcast during a pull, or during a parked `snapshot_required` recovery, no longer reports completion.
- **`advanceReceivedWatermark`.** This method writes the watermark only on a forward move and returns whether it moved. The loop continues only on true, and only if the socket the reply arrived on is still the current one.
- **`requestSnapshot()`.** It now sends `get_changes` after a successful transfer, as the other two transfer paths already did. The branch that joins a running transfer does not, because whoever started the transfer does the catch-up.
- **Rename.** The `advanceWatermark` parameter of `handleChanges` is now `ordered`, since it also drives the loop.

The ticket's scenario, a real coordinator and two real clients with 2000 rows written while B was disconnected, went from 351 of 2001 rows on B at its first `synced` to 2001 of 2001. That figure comes from the implement stage's throwaway spec, which was deleted and was not re-run in review.

## Usage notes

- `onRemoteChanges` fires once more per catch-up, with an empty result, for the final empty reply. A client already up to date already sees this.
- `isSynced` now turns true one round trip later than before. `waitForSynced` in the coordinator's end-to-end harness relies on it, and its comment is updated.
- `requestSnapshot()` resolves when the catch-up request has gone out, not when the catch-up ends. Watch the status for `synced`.

## Review findings

Read the implement diff first, then the server read path (`getChangesSince`, `collectChangesSince`, `buildTransactionChangeSets`, `collectForwardableChanges`) and the coordinator's `get_changes` handling.

### Fixed in this pass

- **Defect: a late apply could send `get_changes` on a replacement socket before its handshake finished.** The implement ticket listed this case only as a duplicate chain. A reply still applying when `connect()` replaced the socket went on to send `get_changes` on the new socket, even if that socket's handshake had not been acknowledged. `serverSiteId` survives the replacement, so nothing stopped the send. The coordinator answers that request with `NOT_AUTHENTICATED`, which reaches the app through `onError`. This path came from reading the code; it was not reproduced against a real coordinator. `handleChanges` now continues only if `this.ws` is still the socket the reply arrived on. The watermark still moves, because the data did land.
- **Known gap closed: `synced` after the connection was gone.** The implement ticket flagged that an apply in flight when `disconnect()` ran or the socket closed moved the status from `disconnected` to `synced`. `disconnect()` and `onclose` now clear `caughtUp`.
- **Tests added, four in `sync-client.spec.ts`:** a reply applying during a socket replacement sends nothing on the new socket; an empty reply applying during a new `connect()` does not report `synced` (this pins the implementer's deviation of setting the flag before the first `await`, which had no test); and a broadcast applying during `disconnect()` or a socket close does not report `synced`. With all these fixes and that deviation temporarily undone, 4 tests failed and 110 passed; the source was then restored.
- **Docs:** added the socket-replacement and late-apply rules to the pull-loop passage in `docs/sync-protocol.md`.

### Checked, no change needed

- **An empty reply is a reliable stop signal.** Confirmed in the code: the change-log scan starts after `sinceHLC`, the origin check comes before the batch counter, stale log entries spend no budget, and forwarded changes filter on `> sinceHLC`.
- **The watermark cannot skip data.** `ChangeSet.hlc` is the transaction's maximum, and `buildTransactionChangeSets` cuts migrations and forwarded changes at the same boundary as data changes, so a reply is a gap-free prefix.
- **A single chain cannot stall on a non-empty reply.** Every server read returns only HLCs above `sinceHLC`, so its maximum always moves the watermark. The no-advance branch is reached only by a duplicate chain or a misbehaving server.
- **Implementer's four tests.** Each pins a behaviour from the ticket, so none were cut.
- **Other consumers.** `quoomb-web` only displays the status and does not use `isSynced`. Coordinator specs and the rest of the docs needed no change. The `synced` status in `docs/sync.md` is on a different type that carries `lastSyncHLC`, not this client's `SyncStatus`.
- **Performance.** One extra watermark read per reply, and one extra round trip per catch-up. Neither was measured; both are small next to the apply itself.
- **Type safety, resource cleanup, file size.** No new types needed and no new timers or listeners. `sync-client.ts` was 1561 lines at the implement commit (`wc -l`) and is slightly longer now; this ticket added under 60 net lines to it, and I did not file a split.

### Tripwires

- **Pull ended with the socket open:** the implement ticket's `NOTE:` in `handleChanges`, widened to include a failed apply and a throwing `onRemoteChanges`, since those end the pull the same way.
- **Overlapping chains:** a new `NOTE:` in `advanceReceivedWatermark`. The compare and write are not atomic, so two chains on one socket (`connect()` then `requestSnapshot()`) can step the watermark back, or skip a range whose apply then fails. The socket check above removes the socket-replacement source of overlap, so this explicit call sequence is the one I found left.

### Major findings and new tickets

None. Both defects were small enough to fix here.

### Validation

All passing on the final behaviour:

- `yarn tsc -b tsconfig.build.json`
- `yarn lint` (repo-wide)
- `yarn test` (repo-wide), including `@quereus/sync-client` at 114 and `@quereus/sync-coordinator` at 138
- `yarn workspace @quereus/sync-client typecheck` and `yarn workspace @quereus/sync-coordinator typecheck`

After those runs I added only the comment in `advanceReceivedWatermark`, then re-ran the build and the sync-client tests.
