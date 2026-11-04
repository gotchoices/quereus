description: A device that has fallen behind by more than one batch of changes receives only the first batch when it connects and then reports itself as synced. It should keep fetching until nothing is left, and only then report synced.
architecture: docs/sync-protocol.md#delta-sync-optimization
files:
  - packages/quereus-sync-client/src/sync-client.ts # handleChanges, requestChangesFromServer, requestSnapshot, runSnapshotTransfer, connect
  - packages/quereus-sync-client/test/sync-client.spec.ts
  - packages/quereus-sync-client/README.md
  - docs/sync-protocol.md
repro: verified
severity: wrong-result
likelihood: normal-use
----

## Reproduction

One `get_changes` request gets one `changes` reply, holding at most `batchSize` facts (default 1000), rounded up to a whole transaction. `handleChanges` in `sync-client.ts` does not ask again, and it sets the status to `synced` after any reply.

Confirmed with a throwaway spec (since deleted) using a real coordinator and two real clients over a WebSocket. Client B received one row and disconnected. Client A wrote 2000 more rows, as 40 transactions of 50 rows with 3 columns each, and pushed them all. B then reconnected.

| B's connection | Rows on B, of 2001 |
| --- | --- |
| 1st, when it reported `synced` | 351 |
| 1st, 3 seconds later | 351 |
| 2nd | 701 |
| 3rd | 1051 |
| 4th | 1401 |

B's status sequence on the first connection was `connecting, syncing, synced`. Each connection fetched 350 rows: 7 transactions, 1050 facts, which is the first whole-transaction cut at or past 1000.

## Cause

The one site is `handleChanges` in `packages/quereus-sync-client/src/sync-client.ts`. After an ordered `changes` reply it does not continue the pull, and it does not distinguish "applied a batch" from "caught up". The coordinator is correct: its bound returns a gap-free prefix in timestamp order.

## Design

**Keep asking until a reply is empty.** After applying a non-empty `changes` reply and advancing the received watermark, send `get_changes` again with the new watermark. An empty reply ends the pull, and it is the only thing that reports `synced`.

- **An empty reply is a reliable stop signal.** The change-log scan starts strictly after `sinceHLC`, the migration and forwarded-change reads filter on `> sinceHLC`, and the origin filter in `collectChangesSince` spends no batch budget. A read therefore returns nothing only when nothing is left.
- **The bug report's "shorter than a full batch" stop cannot work on the client.** The batch size is the coordinator's config (`SYNC_BATCH_SIZE`), the client's own `batchSize` is unrelated, and a reply can overshoot by up to a transaction. A `hasMore` field on the reply would save the final round trip, but it changes a wire message to avoid one small request per catch-up. This design leaves the wire format and `PROTOCOL_VERSION` unchanged, and the push side ends the same way (`sync-push-drains-all-local-changes`).
- **Requests are sequential.** The next request goes out only after the batch is applied and the watermark persisted, so the client handles one batch at a time and an interrupted pull resumes from the watermark.

**Continue only on a real advance.** `PeerStateStore.setPeerState` has no forward-only guard, and `handleChanges` writes the watermark unconditionally. Compare the reply's max HLC (hybrid logical clock timestamp) with the current `getPeerSyncState`:

- Greater, or no watermark yet: write it and request the next batch.
- Not greater: write nothing, send nothing, and do not report `synced`. This cannot loop against a misbehaving server, it ends a duplicate chain (for example one started by a reply still applying when the socket was replaced), and it stops a stale reply from moving the watermark backward.

**Broadcasts must not report `synced` during a pull.** `handleChanges` is also the `push_changes` path and sets `synced` too, so a live write from another device during a long catch-up would falsely report completion. Add a `caughtUp` flag:

- Set true only by an empty `changes` reply.
- Cleared in `connect()` and at the start of `runSnapshotTransfer`, the two places that begin a new pull.
- `handleChanges` sets `synced` only when `caughtUp` is true and the existing `!this.stopReconnect` guard passes. No other site sets `synced`.

As a result, a broadcast no longer flips the status to `synced` during a parked `snapshot_required` recovery (the existing `NOTE:` in `handleSnapshotRequired`). That is the correct report, because the gap is still open.

**Explicit `requestSnapshot()` must catch up afterwards.** The other two transfer paths call `requestChangesFromServer()` after the transfer, and the comment on the drop path in `handleChanges` says a catch-up always follows, but `requestSnapshot()` sends none. Today its status sits at `syncing` until a broadcast happens to flip it. Under the `caughtUp` rule it would stay there until the next reconnect, and a pull reply dropped during the transfer would not be re-fetched. Call `requestChangesFromServer()` after a successful transfer. The branch that joins a transfer already running stays as it is, because whoever started the transfer does the catch-up.

## Paths checked, no change needed

These come from reading the code and were not run.

- **Reply dropped during a snapshot transfer.** `handleChanges` returns early, so the chain ends, and all three transfer paths then catch up.
- **A later request refused with `snapshot_required`.** The normal recovery runs. A client with no watermark can reach this: a request with no `sinceHLC` is never refused, but the follow-up from a first batch that stopped below the delta floor can be. The recovery is correct there.
- **`disconnect()` during an apply.** `serverSiteId` is null, so there is no watermark write and `requestChangesFromServer` does nothing.
- **Failed apply.** `applyChanges` throws to the `handleMessage` catch, so the watermark does not move and the chain ends. The next reconnect resumes from the watermark.
- **`onRemoteChanges`.** It fires once more per catch-up, with an empty result, for the final empty reply. A client already up to date gets this today, so consumers already see it.
- **`bug-sync-late-push-skipped-by-newer-watermark` (backlog).** It concerns the same watermark but a different cause: a push that reaches the server after the watermark has passed its timestamp. This fix neither solves nor worsens it.

## Tripwire to record

Add at the continuation site: `// NOTE: a get_changes the server answers with GET_CHANGES_ERROR ends the pull with the socket open, so the status stays syncing and the remainder waits for the next reconnect. If that shows up, retry on a backoff timer.` The first request already behaves this way, and the push side has the same note in `handleApplyResult`.

## Tests

Add to `packages/quereus-sync-client/test/sync-client.spec.ts`, using `MockWebSocket`. No end-to-end spec is needed: the default batch size makes one slow to set up (the throwaway took about 10 seconds), and `change-grouping.spec.ts` and `store-and-forward-relay.spec.ts` already cover the server's bound.

- A non-empty `changes` reply sends a `get_changes` carrying the reply's max HLC and leaves `isSynced` false; a following empty reply makes `isSynced` true and sends nothing more. This is the reproduction.
- A `push_changes` arriving before the empty reply leaves `isSynced` false.
- A non-empty reply at or below the current watermark sends nothing and writes no watermark.
- After `requestSnapshot()` completes, a `get_changes` goes out carrying the snapshot's HLC.

Existing tests that send a non-empty `changes` reply will now see one extra `get_changes`, so adjust any that assert on exact sent messages. A search of the client spec found no `isSynced` assertion after a non-empty reply.

## TODO

- Add `caughtUp`, cleared in `connect()` and `runSnapshotTransfer`
- Split the watermark step out of `handleChanges` into a small method that writes only on a forward move and returns whether the watermark advanced
- In `handleChanges`, after applying and emitting events: an ordered empty reply sets `caughtUp`; an ordered reply that advanced calls `requestChangesFromServer()`; set `synced` only when `caughtUp` is true
- Add the tripwire `NOTE:` at the continuation site
- Call `requestChangesFromServer()` after a successful transfer in `requestSnapshot()`, and update its doc comment
- Add the tests above
- Update `docs/sync-protocol.md`: the SYNCING line in the client state machine (`synced` only after an empty reply), and a short passage on the pull loop in § Delta Sync Optimization next to the push loop
- Update `packages/quereus-sync-client/README.md`: the `isSynced` description and the `changes` row in the protocol table
- Build, because the coordinator's end-to-end specs load the built `@quereus/sync-client`; then run `yarn workspace @quereus/sync-client test` and `yarn workspace @quereus/sync-coordinator test`, plus typecheck for both
