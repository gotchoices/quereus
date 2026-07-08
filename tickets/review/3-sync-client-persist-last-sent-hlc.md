description: The sync client now remembers on disk how far it has pushed to the server, so after a restart it resumes sending from there instead of re-sending its whole change history.
files:
  - packages/quereus-sync-client/src/sync-client.ts        # seedSentWatermark (~505), promoteWatermark persist (~445), handleApplyResult async (~410), disconnect keeps persisted (~275)
  - packages/quereus-sync/src/sync/manager.ts              # SyncManager interface: updatePeerSentState / getPeerSentState
  - packages/quereus-sync/src/sync/sync-manager-impl.ts    # impl delegating to PeerStateStore (~1232)
  - packages/quereus-sync/src/metadata/peer-state.ts       # getPeerSentState / setPeerSentState (pt: keyed)
  - packages/quereus-sync/src/metadata/keys.ts             # PEER_SENT_STATE prefix + buildPeerSentStateKey
  - packages/quereus-sync/src/index.ts                     # export buildPeerSentStateKey
  - packages/quereus-sync-client/test/sync-client.spec.ts  # "sent watermark persistence" describe + mock
  - packages/quereus-sync/test/sync/sync-manager.spec.ts   # "peerSentState" describe
  - docs/sync.md                                           # delta-sync restart-resume + key table
difficulty: medium
----

## What was built

The sync client's push high-water mark (`lastSentHLC` — the HLC of the newest local
change the server has acknowledged) was in-memory only and reset to `null` on
`disconnect()`. So every fresh process (and every manual disconnect/reconnect) started
with `lastSentHLC = null`, and `pushLocalChanges` computed its delta as
`getChangesSince(serverSiteId, undefined)` → a full-history replay. The server dedupes by
HLC so it wasn't corrupting, just wasteful at scale.

Fix mirrors the **received** watermark, which was already persisted per peer via
`SyncManager.getPeerSyncState` / `updatePeerSyncState`. Now the **sent** watermark is
persisted the same way, under a separate key prefix:

- `SyncManager` gained `updatePeerSentState(peerSiteId, hlc)` / `getPeerSentState(peerSiteId)`,
  implemented in `SyncManagerImpl` by delegating to `PeerStateStore.setPeerSentState` /
  `getPeerSentState`. These write/read a new `pt:{siteId}` KV key — keyed **separately**
  from the received watermark's `ps:{siteId}`, reusing the same `PeerState` byte layout
  (30-byte HLC + 8-byte timestamp).
- `SyncClient`:
  - **Seed** — on every handshake ack (`seedSentWatermark`, called from
    `handleHandshakeAck` after `requestChangesFromServer`, before push), `lastSentHLC` is
    seeded from `getPeerSentState(serverSiteId)`. Seeding only takes the persisted value
    when it is *ahead of* the in-memory one, so an auto-reconnect holding an already-advanced
    in-memory watermark is never dragged backward.
  - **Persist** — on a confirmed, correlated ack (`promoteWatermark`, invoked from the now-
    `async` `handleApplyResult`), the client persists via `updatePeerSentState` — but only
    on a real forward advance, so we only ever persist a watermark we actually confirmed
    sent. Uncorrelated/stale/duplicate acks don't persist (they already don't promote).
  - **Disconnect** — clears only the in-memory `lastSentHLC`; the persisted `pt:` value is
    intentionally retained so a reconnect resumes rather than replays.

This depends on ticket #2 (`sync-client-apply-result-correlation-id`, already landed): the
`requestId` correlation is what makes "persist only the confirmed watermark" precise.

## How to validate

Build + tests, from repo root:

- `yarn workspace @quereus/sync run build` and `yarn workspace @quereus/sync-client run build`
  (both green — the interface added two **required** methods, so any missing implementer
  fails to compile).
- `yarn workspace @quereus/sync-client run test` → 62 passing (4 new under
  **"sent watermark persistence"**).
- `yarn workspace @quereus/sync run test` → 432 passing (3 new under **"peerSentState"**).
- `yarn build` full sequential build was run and passed for **all** packages (sync-coordinator,
  vscode ext, quoomb-web included) — confirms no downstream `SyncManager` consumer broke.

Key test cases (client, `sync-client.spec.ts`):
- **restart resume**: with `peerSentState` pre-seeded, the post-handshake delta push calls
  `getChangesSince` with the persisted HLC (not `undefined`) — the core anti-replay assertion.
- **persist on ack, and only then**: nothing persisted until the matching `apply_result`;
  the persisted value equals the batch's max `ChangeSet.hlc`.
- **no persist on uncorrelated ack** (`requestId: apply-999`).
- **retain across manual disconnect**: in-memory cleared, durable value survives, reconnect
  re-seeds and resumes from it.

Store-level (`sync-manager.spec.ts` → "peerSentState"): store/retrieve, undefined for unknown
peer, and **separate keying** — writing sent and received watermarks for the same peer does
not clobber each other.

## Known gaps / things for the reviewer to probe

- **Tests are a floor.** The client suite runs against a `MockSyncManager`, not a real
  `SyncManagerImpl` over a real KV store; the store round-trip is covered separately in the
  sync package. There is **no end-to-end test** wiring `SyncClient` → real `SyncManagerImpl`
  → KV → process-restart → reconnect. The two halves are each tested; their seam is not
  integration-tested. Worth a reviewer's eye on whether that seam deserves an e2e test
  (candidate home: `packages/quereus-sync/test/sync/sync-protocol-e2e.spec.ts`).
- **Read-only clients**: seeding runs before the `readOnly` push branch, so `lastSentHLC`
  gets seeded even for pull-only clients that never push. Harmless (no push path reads it),
  but confirm that's intended vs. gating the seed on `!readOnly`.
- **`pt:` layout reuses `PeerState`**: the sent record stores an unused `lastSyncTime`
  (persist wall-time), and `getPeerSentState` discards it (returns only the HLC). Intentional
  DRY reuse; flagged so it's not mistaken for a bug.

## Review findings (tripwires parked during implementation)

- **Orphaned `pt:` on peer removal** — `PeerStateStore.deletePeerState` deletes only the
  received watermark (`ps:`), not the sent watermark (`pt:`), and `getAllPeers()` iterates
  only `ps:`. No caller does full peer removal/GC today, so the leftover `pt:` entry is
  inert. Parked as a `NOTE:` code comment at `peer-state.ts` `deletePeerState`. Becomes real
  work only if/when stale-peer GC is added.
