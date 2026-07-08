description: A syncing client can permanently lose changes because it marks data as "already received" off best-effort broadcasts that may never have arrived; fix so only ordered catch-up replies advance the progress marker.
files:
  - packages/quereus-sync-client/src/sync-client.ts        # handleMessage dispatch (~296-298), handleChanges (~389-414)
  - packages/quereus-sync-client/test/sync-client.spec.ts   # add reproducing test
  - packages/sync-coordinator/src/service/coordinator-service.ts  # broadcastChanges (~631-672) — related concern, log only
  - docs/sync.md                                            # ~line 977 conflates the two receive paths
difficulty: medium
----

## Root cause (confirmed)

The sync client tracks a per-client progress marker — a Hybrid Logical Clock
(HLC) timestamp, `lastSyncHLC`, the *received watermark*. Its contract: "I have
durably received everything at or below this HLC." Catch-up requests send
`get_changes sinceHLC=<watermark>`; the coordinator returns only newer changes.

Two distinct server→client message types carry changesets:

- **`changes`** — the reply to an explicit `get_changes` request
  (`sync-coordinator/src/server/websocket.ts:221`). Server-ordered, gap-free,
  contiguous. Safe to advance the watermark from.
- **`push_changes`** — a **fire-and-forget broadcast** relaying another peer's
  change (`sync-coordinator/src/service/coordinator-service.ts:635`). If
  delivery fails the coordinator only logs it (`broadcastChanges`, lines
  631-672) and never learns the client missed it.

The client's `handleMessage` routes **both** types to the same handler:

```
// sync-client.ts:296-298
case 'changes':
case 'push_changes':
  await this.handleChanges(message.changeSets || []);
  break;
```

and `handleChanges` (lines 389-399) advances the received watermark off *any*
batch it applies:

```
const maxHlc = maxHLC(changeSets.map(cs => cs.hlc));
if (maxHlc) {
  await this.syncManager.updatePeerSyncState(this.serverSiteId, maxHlc);
}
```

So a **successfully delivered** broadcast at HLC 6 advances the watermark to 6
even though a **dropped** broadcast at HLC 5 was never received. The next
catch-up is `get_changes sinceHLC=6` — HLC 5 sits at/below the watermark and is
never resent. Permanent loss, no recovery path.

(Note: there is only one watermark-advance site for received changes, not two.
The ticket's "two sites" refers to the two message types feeding the single
`handleChanges` path — that dispatch merge is the actual seam to split.)

## Fix

Split "apply" from "advance watermark". A broadcast (`push_changes`) may still
be applied eagerly as an optimization, but must **not** move `lastSyncHLC`. Only
the ordered `changes` reply advances it — so any broadcast the client missed is
redelivered on the next `get_changes`.

Concrete approach: separate the dispatch so the two types call `handleChanges`
with a flag (or two thin wrappers over a shared core) distinguishing
advance-watermark from apply-only. Keep the apply / event-emit / status-update
behavior identical for both; gate only the `updatePeerSyncState` call on the
ordered path.

Correctness note this preserves: applying a broadcast at HLC 6 while the
watermark stays at (say) 4 is fine — `applyChanges` is HLC-keyed and idempotent
(docs/sync.md, "Integrity During Sync"), so the later `get_changes sinceHLC=4`
re-delivering HLC 5 **and 6** re-applies 6 harmlessly.

## Coordinator-side broadcast reliability (related, out of scope here)

A failed broadcast being merely logged is the *upstream* half of the loss. The
client-side watermark fix fully closes the data-loss hole (missed broadcasts are
recovered on next catch-up), so coordinator broadcast reliability
(ack/retry/backpressure) is **not** required for correctness — it is a
latency/efficiency concern (how quickly a missed change is recovered), not a
correctness one. Do **not** build it under this ticket. If it merits tracking,
the reviewer should note it; otherwise it stays a documented tripwire at
`broadcastChanges`.

## TODO

- Split `handleMessage` dispatch in `sync-client.ts` so `push_changes` applies
  without advancing the watermark and `changes` advances it. Prefer a shared
  apply core + an `advanceWatermark: boolean` param over duplicating the body.
- Confirm no other caller of `handleChanges` exists that would regress.
- Add reproducing test to `test/sync-client.spec.ts` using the existing
  `MockWebSocket.simulateMessage`:
  - Seed mock `SyncManager` so `getPeerSyncState` starts empty/low.
  - `simulateMessage({ type: 'push_changes', changeSets: [<HLC 6>] })` — assert
    `updatePeerSyncState` was NOT called (watermark unmoved) and the change WAS
    applied (`applyChanges` invoked).
  - `simulateMessage({ type: 'changes', changeSets: [<HLC 5>] })` — assert
    `updatePeerSyncState` WAS called with HLC 5.
  - Assert a subsequent `requestChangesFromServer` / reconnect sends
    `get_changes sinceHLC=5` (not 6), i.e. HLC 5 is still fetchable — the
    dropped broadcast is recoverable.
- Update `docs/sync.md` ~line 977 ("After applying server changes, client
  updates peerSyncState ... with the max ChangeSet.hlc received") to state that
  **only** ordered `changes` replies advance the received watermark; broadcast
  `push_changes` are applied but never advance it. Reconcile with the message
  table (~line 915) and the dispatch checklist (~line 1701).
- Add a `NOTE:` tripwire comment at `broadcastChanges` in
  `coordinator-service.ts` recording that failed broadcasts are recovered only
  on the client's next catch-up (fine now; revisit if push-recovery latency
  becomes a problem).
- Validate: `yarn workspace @quereus/quereus-sync-client test` (Vitest), then
  `yarn build` and `yarn lint` from repo root. Stream long output with `tee`.
