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

A delivered broadcast at HLC 6 advanced the watermark to 6 even though a
**dropped** broadcast at HLC 5 was never received. Next catch-up became
`get_changes sinceHLC=6` — HLC 5 sits at/below the watermark and is never
resent. Permanent loss, no recovery path.

## What changed

Split "apply" from "advance watermark" in `sync-client.ts`: `handleMessage`
dispatches `changes` → `handleChanges(sets, true)` and `push_changes` →
`handleChanges(sets, false)`; the `updatePeerSyncState` advance is gated on the
new `advanceWatermark` param. Apply / event-emit / status behavior is identical
for both paths — only the watermark advance is gated. A broadcast is still
applied eagerly; the later `get_changes sinceHLC=<lower watermark>` re-delivers
and idempotently re-applies it.

`coordinator-service.ts` gained a `NOTE:` tripwire at `broadcastChanges`
(dropped broadcast only logged; correctness no longer depends on delivery).
`docs/sync.md` message table, delta-sync item 1, and dispatch checklist now
state only ordered `changes` advance the received watermark.

## Review findings

Adversarial pass over the implement diff (commit `882f646d`). Read the full diff
first, then traced every correctness link end-to-end.

**Checked — dispatch split (correctness core).** `handleMessage` routes the two
types correctly (`sync-client.ts:296-310`); `advanceWatermark` gate sits inside
the existing `changeSets.length > 0 && serverSiteId` guard, so an empty ordered
reply still does not advance (behavior preserved). **No issue.**

**Checked — coordinator sends distinct message types.** Confirmed the two types
are not conflated on the wire: `changes` is emitted only as the get_changes
reply (`websocket.ts:221`, single message, whole ChangeSets after the boundary →
contiguous/gap-free, so advancing to `maxHLC` skips nothing below it);
`push_changes` only in the broadcast path (`coordinator-service.ts:641`). The
client's assumption that `changes` is the only gap-free path holds. **No issue.**

**Checked — mock durable-state mirror is faithful.** The reviewer-flagged
concern in the handoff. Real `updatePeerSyncState` → `peerStates.setPeerState`
and `getPeerSyncState` → `peerStates.getPeerState().lastSyncHLC`
(`sync-manager-impl.ts:1284-1290`) — both awaited, so a confirmed advance is
immediately visible to the next catch-up. `MockSyncManager` now mirrors that by
setting `this.peerSyncState = hlc`. Faithful stand-in. **No issue.**

**Checked — idempotency of the NEW re-delivery path (the highest-risk item).**
This fix *newly* causes a broadcast to be re-fetched and re-applied (old code
advanced the watermark past it, so it never came back). Verified that
re-applying the *exact same* HLC is a no-op, not a double-apply: `lwwResolver`
is `compareHLC(remote, local) > 0 ? 'remote' : 'local'` and the fast-path is
`compareHLC(incoming, existing) > 0` (`conflict-resolvers.ts:9`,
`schema-version.ts:289`, `hlc.ts:76`). Equal HLC → `0`, not `> 0` → keep local →
skip. Idempotency holds; the re-delivery path is safe. **No issue.**

**Checked — no other changeset-carrying path advances the watermark wrongly.**
`handleChanges` has exactly the two callers above. Snapshot application is a
separate full-replace path, out of scope. **No issue.**

**Checked — docs.** `docs/sync.md` message table, delta-sync item 1, and feature
checklist all now reflect "only ordered `changes` advance the received
watermark." The `lastSyncHLC` name used in the new jsdoc matches
`PeerSyncState.lastSyncHLC` (`protocol.ts:423`). Accurate. **No issue.**

**Findings requiring a fix (minor): none.**

**Findings requiring a new ticket (major): none.**

**Tripwires (conditional; not tickets):**
- *Coordinator broadcast reliability* — a failed `push_changes` is only logged,
  never acked/retried. Parked as a `NOTE:` at `broadcastChanges` in
  `coordinator-service.ts`. Now a latency/efficiency concern only (how fast a
  missed change is recovered), not correctness — the watermark fix closes the
  data-loss hole. Revisit only if push-recovery latency becomes a problem.
- *No end-to-end drop-and-recover test against a real coordinator* — coverage is
  unit-level over client dispatch with a mock. The full loop (coordinator drops
  a broadcast → client recovers on next `get_changes`) is now argued *and* every
  link independently verified during this review (message routing, durable
  read-back, idempotency), but not exercised as one integration test. Speculative
  hardening — recorded here, not filed, because correctness is established and no
  client↔coordinator integration harness currently exists to hang it on. If such
  a harness is added, a drop-and-recover e2e test would harden this.

## Validation (this pass)

- `yarn workspace @quereus/sync-client test` → **65 passing**. Console noise
  ("Unknown sync message type", "socket write failed") is from intentional
  negative-path tests, not failures.
- `yarn workspace @quereus/sync-client build` and `yarn workspace
  @quereus/sync-coordinator build` → both clean (type-check passes).
- `yarn workspace @quereus/sync-client lint` / `@quereus/sync-coordinator lint`
  → `No lint configured` (intentional no-ops). The diff touches only the two
  sync packages + `docs/`; the real lint lives in `packages/quereus`, which this
  change does not touch, so it is unaffected.

Key tests in `test/sync-client.spec.ts`: `applies push_changes but does not
advance the received watermark`; `advances the watermark on an ordered changes
reply`; and the reproducing `does not lose a change when a later broadcast
arrives before the ordered reply` (broadcast HLC 6 applied without advancing;
ordered reply HLC 5 advances to 5; subsequent `requestChangesFromServer` sends
`get_changes sinceHLC=5`, proving dropped HLC 5 is still fetchable).
