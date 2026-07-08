description: The sync client now remembers on disk how far it has pushed to the server, so after a restart it resumes sending from there instead of re-sending its whole change history.
files:
  - packages/quereus-sync-client/src/sync-client.ts        # seedSentWatermark (~530), promoteWatermark persist (~443), async handleApplyResult (~416), disconnect keeps persisted (~278)
  - packages/quereus-sync/src/sync/manager.ts              # SyncManager: updatePeerSentState / getPeerSentState
  - packages/quereus-sync/src/sync/sync-manager-impl.ts    # impl delegating to PeerStateStore (~1232)
  - packages/quereus-sync/src/metadata/peer-state.ts       # get/setPeerSentState (pt: keyed); deletePeerState NOTE
  - packages/quereus-sync/src/metadata/keys.ts             # PEER_SENT_STATE prefix + buildPeerSentStateKey + siteIdToBase64Url
  - packages/quereus-sync/src/index.ts                     # export buildPeerSentStateKey
  - packages/quereus-sync-client/test/sync-client.spec.ts  # "sent watermark persistence" describe + backward-drag guard test
  - packages/quereus-sync/test/sync/sync-manager.spec.ts   # "peerSentState" describe
  - docs/sync.md                                           # delta-sync restart-resume + key table
----

## What was built

The sync client's push high-water mark (`lastSentHLC` — the HLC of the newest local
change the server has acknowledged) was in-memory only and reset to `null` on
`disconnect()`, so every fresh process replayed its whole local history to the server
(harmless — server dedupes by HLC — but wasteful). The fix persists the **sent**
watermark per peer, mirroring the already-persisted **received** watermark:

- `SyncManager` gained `updatePeerSentState` / `getPeerSentState`, implemented in
  `SyncManagerImpl` via `PeerStateStore.setPeerSentState` / `getPeerSentState`, which
  read/write a new `pt:{siteId}` KV key — keyed **separately** from the received
  watermark's `ps:{siteId}`, reusing the `PeerState` byte layout.
- `SyncClient`: **seeds** `lastSentHLC` from the persisted value on each handshake
  (forward-only, never dragging an ahead-of-persisted in-memory watermark backward),
  **persists** on a confirmed forward-advancing ack, and on **disconnect** clears only
  the in-memory copy so a reconnect resumes rather than replays.

Full design detail in the implement handoff (commit `a21b4926`) and `docs/sync.md`.

## Review findings

Adversarial pass over the implement diff (`a21b4926`), read before the handoff summary.
Scrutinized: correctness of the seed/persist/clear state machine, HLC serialization
round-trip fidelity, async-reentrancy of the now-`async` `handleApplyResult`, key-prefix
separation, DRY of the base64url encode factoring, docs accuracy, and test coverage.

**Correctness — CLEAN.** The three-part state machine is sound:
- Seed (`seedSentWatermark`, sync-client.ts ~530) runs after `serverSiteId` is set and
  before `subscribeToLocalChanges`/`pushLocalChanges`, so the first delta push already
  sees the seeded watermark. The forward-only guard (`compareHLC(persisted, lastSentHLC) > 0`)
  correctly protects the auto-reconnect path, where `connect()` does **not** reset
  in-memory state (confirmed: only `disconnect()` clears `lastSentHLC`).
- Persist (`promoteWatermark` ~443) writes only on a correlated, forward-advancing ack;
  the promote critical section (delete pending, assign `lastSentHLC`) is synchronous
  before the persist `await`, so interleaved `apply_result` handling can't corrupt the
  watermark. Worst case on a same-key persist race is re-persisting a lower value → a
  harmless re-send on next restart, never data loss. Not worth guarding.
- HLC round-trips fully through `serializeHLC`/`deserializeHLC` (wallTime, counter,
  siteId, opSeq all 30 bytes) and through the `PeerState` 38-byte layout, so a seeded
  watermark compares identically to the in-memory one.

**Tests — floor raised.** Implement added 4 client + 3 store cases covering seed, persist,
no-persist-on-uncorrelated-ack, and retain-across-disconnect. **Gap found and fixed inline
(minor):** the forward-only backward-drag guard in `seedSentWatermark` — the property that
protects auto-reconnect — had no test. Added *"never drags an ahead-of-persisted in-memory
watermark backward when seeding"* to the `sent watermark persistence` describe. Client suite
now 63 passing.

**Docs — accurate.** `docs/sync.md` key table (`pt:` row), the delta-sync watermark section,
and the ASCII ack-flow diagram were all updated to describe sent-vs-received separation and
restart-resume; verified against the code.

**Known gaps from the handoff — assessed, no action:**
- *No end-to-end `SyncClient` → real `SyncManagerImpl` → KV → restart test.* The two halves
  are each unit-tested; the seam is not integration-tested. Acceptable — the seam is a thin
  two-method delegation and the HLC round-trip is covered. Left as the handoff's noted
  candidate for a future e2e in `sync-protocol-e2e.spec.ts`; not filed as a ticket.
- *Read-only clients seed but never push.* Confirmed harmless — `pushLocalChanges` returns
  early on `readOnly`, so the seeded `lastSentHLC` is never read. Intended; no gate needed.
- *`pt:` reuses `PeerState` and discards `lastSyncTime`.* Intentional DRY reuse; not a bug.

**Tripwire (unchanged, from implement):** orphaned `pt:` entry on peer removal —
`deletePeerState` deletes only `ps:`. Parked as a `NOTE:` at `peer-state.ts` `deletePeerState`.
Inert (no full-peer-removal caller today).

**Pre-existing latent defect found → filed to backlog (`debt-peer-state-getallpeers-key-decode`).**
`PeerStateStore.getAllPeers()` (peer-state.ts ~104) reconstructs each peer's `SiteId` by
parsing the key suffix as **hex**, but `buildPeerStateKey` writes it as **base64url** — so
every reconstructed id would be garbage. Dormant: `getAllPeers` has no callers today, so
nothing observes the corruption. Not introduced by and unrelated to this ticket's watermark
work; surfaced while reviewing the touched file. Filed as dormant debt (not fixed here — out
of scope, and it needs its own round-trip test).

## How it was validated

- `yarn workspace @quereus/sync run build` + `yarn workspace @quereus/sync-client run build` — green.
- `yarn workspace @quereus/sync-client run test` → **63 passing** (was 62; +1 review-added).
- `yarn workspace @quereus/sync run test` → **432 passing**.

(stderr in both runs is intentional error-path logging from negative tests, not failures.)
Only the `quereus` package has a real lint; this diff touches only `sync`/`sync-client`
(whose lint is a no-op), and the TypeScript builds — the real type check — passed for both.
