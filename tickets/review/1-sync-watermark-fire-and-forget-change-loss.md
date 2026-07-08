description: A syncing client could permanently lose changes by marking data "received" off best-effort broadcasts that may never have arrived; now only ordered catch-up replies advance the progress marker, so a missed broadcast is redelivered on the next catch-up.
files:
  - packages/quereus-sync-client/src/sync-client.ts        # dispatch split + handleChanges advanceWatermark param
  - packages/quereus-sync-client/test/sync-client.spec.ts  # reproducing tests + mock durable-state mirror
  - packages/sync-coordinator/src/service/coordinator-service.ts  # NOTE tripwire at broadcastChanges
  - docs/sync.md                                           # message table, delta-sync item 1, dispatch checklist
difficulty: medium
----

## What was wrong

The sync client keeps a **received watermark** — an HLC (Hybrid Logical Clock)
timestamp, `peerSyncState[serverSiteId]`, meaning "I have durably received
everything at or below this HLC." Catch-up requests send `get_changes
sinceHLC=<watermark>`; the coordinator returns only strictly-newer changes.

Two server→client message types carry changesets, and the client routed **both**
to the same handler, which advanced the watermark off any batch it applied:

- **`changes`** — the ordered reply to `get_changes`. Server-ordered, gap-free.
  Safe to advance the watermark.
- **`push_changes`** — a **fire-and-forget broadcast** relaying a peer's change.
  If delivery fails the coordinator only logs it and never learns the client
  missed it.

So a delivered broadcast at HLC 6 advanced the watermark to 6 even though a
**dropped** broadcast at HLC 5 was never received. Next catch-up became
`get_changes sinceHLC=6` — HLC 5 sits at/below the watermark and is never
resent. Permanent loss, no recovery path.

## What changed

Split "apply" from "advance watermark":

- `sync-client.ts` — `handleMessage` now dispatches the two types separately:
  `changes` → `handleChanges(sets, true)`, `push_changes` →
  `handleChanges(sets, false)`. `handleChanges` gained an `advanceWatermark:
  boolean` param; the `updatePeerSyncState` call is now gated on it. Apply /
  event-emit / status-update behavior is **identical** for both paths — only the
  watermark advance is gated.
- A broadcast is still applied eagerly (an optimization). Because `applyChanges`
  is HLC-keyed and idempotent, the later `get_changes sinceHLC=<lower
  watermark>` re-delivering and re-applying that broadcast is harmless.
- `coordinator-service.ts` — added a `NOTE:` tripwire at `broadcastChanges`
  recording that a failed/dropped broadcast is only logged, and that correctness
  no longer depends on delivery (client recovers on next catch-up). See tripwire
  note below.
- `docs/sync.md` — message table (`changes` vs `push_changes`), delta-sync item
  1, and the dispatch checklist now state that only ordered `changes` advance
  the received watermark.

## How to validate / exercise

`yarn workspace @quereus/sync-client test` → **65 passing**. Key tests in
`test/sync-client.spec.ts`:

- `message handling › applies push_changes but does not advance the received
  watermark` — `push_changes` applied (`applyChangesCalls` non-empty) but
  `updatePeerSyncStateCalls` empty.
- `received watermark advancement › advances the watermark on an ordered
  `changes` reply` — `changes` advances to the reply's max HLC.
- `received watermark advancement › does not lose a change when a later
  broadcast arrives before the ordered reply` — the **reproducing** test:
  broadcast HLC 6 applied without advancing; ordered reply HLC 5 advances to 5;
  a subsequent `requestChangesFromServer` sends `get_changes sinceHLC=5` (equals
  `serializeHLCForTransport(hlc5)`, not `hlc6`), proving the dropped HLC 5 is
  still fetchable.

Type-check: `yarn workspace @quereus/sync-client build` and `yarn workspace
@quereus/sync-coordinator build` both clean. `yarn lint` from root: clean
(quereus real lint passed; sync packages are no-op lints).

## Reviewer: treat tests as a floor. Known gaps / things to scrutinize

- **Test-harness behavior change.** `MockSyncManager.updatePeerSyncState` now
  also sets `this.peerSyncState = hlc` (mirroring a durable store), so a later
  `getPeerSyncState` / `get_changes` reads back the confirmed watermark. This is
  required for the recovery assertion. All 65 tests pass, so no existing test
  depended on the old no-write behavior — but confirm the mirror is a faithful
  stand-in for the real `SyncManager` (does a real advance become immediately
  visible to `getPeerSyncState`? If the real store is async/eventually-durable,
  the recovery latency differs, though correctness does not).
- **No end-to-end test against a real coordinator.** Coverage is unit-level over
  the client dispatch with a mock. The full loop (coordinator drops a broadcast →
  client recovers on next `get_changes`) is argued, not exercised. If an
  integration harness exists, an e2e drop-and-recover test would harden this.
- **Idempotency is assumed, not re-verified here.** The "apply HLC 6 twice
  harmlessly" argument rests on `applyChanges` being HLC-keyed/idempotent
  (docs/sync.md "Integrity During Sync"). This change does not test that
  property directly — if it ever regresses, double-apply of a re-delivered
  broadcast becomes a real bug. Worth a glance that the idempotency invariant
  still holds.
- **`push_changes` with empty/malformed changeSets** takes the same
  `message.changeSets || []` guard as before — unchanged, but note the
  `advanceWatermark` gate is inside the `changeSets.length > 0` check, so an
  empty ordered `changes` reply still does not advance (unchanged behavior).

## Tripwire (recorded, NOT a ticket)

Coordinator broadcast reliability: a failed `push_changes` broadcast is only
logged, never acked/retried. Parked as a `NOTE:` comment at `broadcastChanges`
in `packages/sync-coordinator/src/service/coordinator-service.ts`. It is now a
**latency/efficiency** concern only (how fast a missed change is recovered), not
a correctness one — the client-side watermark fix closes the data-loss hole.
Revisit only if push-recovery latency becomes a problem (then consider
ack/retry/backpressure). Do not file as a ticket unless that condition trips.
