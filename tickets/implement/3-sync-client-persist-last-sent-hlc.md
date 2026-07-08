description: The client only remembers what it has already sent to the server in memory, so every process restart re-sends the entire change history from the beginning instead of resuming where it left off.
prereq: sync-client-reconnect-on-transient-error
files:
  - packages/quereus-sync-client/src/sync-client.ts        # lastSentHLC (~72), pushLocalChanges (~432), handleApplyResult (~341), disconnect() resets it (~233)
  - packages/quereus-sync/  # SyncManager peer-sync-state API (getPeerSyncState/updatePeerSyncState) — the received-watermark analogue to extend
  - docs/sync.md
difficulty: medium
----

## Problem

`lastSentHLC` (the high-water mark of what this client has pushed to the server) lives only
in memory (`sync-client.ts:72`) and is reset to `null` on `disconnect()` (~line 233).
`pushLocalChanges` computes its delta as `getChangesSince(serverSiteId, lastSentHLC ?? undefined)`,
so on a fresh process (or after a manual disconnect) `lastSentHLC` is `null` and the client
**re-sends its entire local history**. The server dedupes by HLC so it's not corrupting,
but it's a full-history replay every restart — wasteful and slow at scale.

Note the asymmetry: the **received** watermark (what we've pulled from the server) *is*
persisted via `SyncManager.getPeerSyncState` / `updatePeerSyncState`
(see `requestChangesFromServer` / `handleChanges`). The **sent** watermark is not.

## Design

Persist the sent watermark the same way the received one is — per peer (keyed by
`serverSiteId`), through the `SyncManager`, so it survives restarts and lives in the same
store as the rest of sync state.

- Add a sent-watermark accessor pair to `SyncManager` (e.g. `getPeerSentState(peerSiteId)` /
  `updatePeerSentState(peerSiteId, hlc)`), mirroring the existing peer-sync-state pair.
  Confirm the storage layer keys these separately from the received watermark.
- On successful ack (`handleApplyResult`, promotion of the matching request's HLC — see
  ticket #2), persist via `updatePeerSentState`.
- On connect/handshake, seed `lastSentHLC` from `getPeerSentState(serverSiteId)` instead of
  starting `null`.
- Do **not** clear the persisted sent watermark on `disconnect()` — only the in-memory
  copy. A reconnect must resume, not replay.

Ordering vs ticket #2: persistence should key off the correlated ack so we only persist a
watermark we actually confirmed sent. #2 is prereq-independent of this ticket but both edit
`handleApplyResult`; land #2 first if scheduled together, else reconcile the promotion path.

## TODO

- [ ] Add `getPeerSentState` / `updatePeerSentState` (or equivalent) to `SyncManager` +
      its store-backed impl in `packages/quereus-sync`; ensure separate keying from the
      received watermark.
- [ ] `sync-client.ts`: seed `lastSentHLC` from the persisted sent watermark on
      handshake/connect.
- [ ] `sync-client.ts`: persist sent watermark on confirmed ack; stop clearing the
      *persisted* value on `disconnect()`.
- [ ] Test: restart with a persisted `lastSentHLC` does not re-send already-sent history
      (assert `getChangesSince` is called with the persisted HLC, not `undefined`).
- [ ] Update `docs/sync.md` (delta-sync / restart resume).
- [ ] Tests green; lint.
