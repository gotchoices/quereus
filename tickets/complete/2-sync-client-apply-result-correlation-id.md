description: The sync client now tags each batch of changes it pushes to the server with an id, and the server echoes that id back on its acknowledgement, so a late or duplicate acknowledgement can no longer be credited to the wrong batch.
files:
  - packages/quereus-sync-client/src/sync-client.ts        # pendingSentHLCs map, promoteWatermark, nextApplyRequestId, pushLocalChanges
  - packages/quereus-sync-client/src/types.ts              # ApplyChangesMessage.requestId, ApplyResultMessage.requestId
  - packages/sync-coordinator/src/server/websocket.ts       # handleApplyChanges echoes requestId
  - packages/quereus-sync-client/test/sync-client.spec.ts   # "apply_result correlation" describe block
  - docs/sync.md                                            # protocol tables + local-change flow
----

## What shipped

Correlation id on the push→ack round-trip so an `apply_result` ties to the exact
`apply_changes` batch that produced it. Client mints a monotonic `requestId`
(`apply-1`, `apply-2`, …) per delta push and records `requestId → max HLC of
batch` in a `Map` (`pendingSentHLCs`). The server echoes the id back verbatim
(keeps no state). `promoteWatermark(requestId)` advances `lastSentHLC` only for a
recorded id, only forward, then prunes any pending batch the new watermark
subsumes. Result: a stale / duplicate / out-of-order ack (e.g. redelivered across
a reconnect) is inert instead of over-advancing the watermark and silently
dropping unsent local changes from future delta sync.

Full mechanism, invariants, and the implementer's own known-gap list are in the
implement commit body (`git show 257fa450`).

## Review findings

Adversarial pass over the implement diff (`257fa450`), read before the handoff.

**Correctness — verified sound, no changes.**
- **Forward-only + prune (`promoteWatermark`).** Confirmed `compareHLC`
  (`packages/quereus-sync/src/clock/hlc.ts`) is a total order, so the
  `> 0` forward guard and `<= 0` prune are well-defined. Prune correctness rests
  on "a later in-flight push re-sends a superset of an earlier one" — verified:
  `pushLocalChanges` reads `getChangesSince(lastSentHLC)` and `lastSentHLC` does
  not move until an ack lands, so push N+1's range ⊇ push N's. Walked the
  lost-ack case (middle batch never acked) — a later push + ack self-heals the
  watermark and prunes the orphan. Sound.
- **Map mutation during iteration.** The prune loop `delete`s from
  `pendingSentHLCs` while iterating it. Safe per JS Map semantics (deleted
  entries are simply skipped; unvisited entries still visited).
- **Reconnect safety.** `disconnect()` clears the map but does not reset
  `applyRequestSeq` — a redelivered stale ack carries an id no longer held →
  dropped, never colliding with a reused id. Correct.
- **Server echo.** `{ type: 'apply_result', requestId: msg.requestId, ...result }`
  — `requestId` before the spread, `result` (applied/skipped/conflicts/
  transactions) has no `requestId`, so no clobber; `undefined` dropped by
  `JSON.stringify`. Relay/broadcast paths to other peers do not carry the id. Clean.

**Type safety / wire format — verified.** `requestId?: string` optional on both
message types; peer-relay push omits it, legacy server echoes none. No `any`
introduced.

**Docs — verified current.** `docs/sync.md` protocol tables + local-change flow
diagram updated to show `requestId` on `apply_changes` / `apply_result` and the
forward-only promotion; matches code.

**Test coverage — one gap closed inline (minor).** The implementer flagged the
peer-relay path (`handleRequestChanges` → `apply_changes` with no requestId →
`promoteWatermark(undefined)`) as covered-by-construction but untested. Added
`relays a peer request as an apply_changes with no requestId, whose ack never
promotes` to the `apply_result correlation` block: drives a `request_changes`
message, asserts the relay push carries no `requestId` and records nothing, then
asserts a no-id `apply_result` leaves `lastSentHLC` null. sync-client now **58
passing**.

**Tripwires (no ticket — parked in place, per workflow rules).**
- *Map growth* — already a `NOTE:` at the `pendingSentHLCs` declaration
  (bounded by in-flight pushes; each ack self-prunes; disconnect clears). Cap
  (evict-oldest) only if a server accepts `apply_changes` but never acks. No
  action.
- *Legacy-server delta-sync loss* — a coordinator predating this change echoes no
  id → client never advances `lastSentHLC` → re-pushes all local changes each
  push. Correctness preserved (server dedups by HLC); optimization lost. Not a
  concern in-repo (client + server land together). Documented in the implement
  commit; no action.
- *Prune assumes superset* — if `pushLocalChanges` is ever changed to send
  disjoint ranges without waiting for acks, the prune could drop an uncovered
  batch. Sound today; watch on any future change to push batching.

**Pre-existing flaky test (not this diff).**
`packages/sync-coordinator/test/store-manager.spec.ts:305` ("should not track
eviction candidates when diskEvictionIdleMs is 0") failed on the first
coordinator test run (`isOpen` still true after a 200ms idle-close wait) and
**passed on immediate re-run (125 passing)**. It is a timing race in the store
eviction lifecycle — a subsystem this ticket never touches (diff in
sync-coordinator was confined to `websocket.ts`). Non-reproducible, so not routed
to triage; recorded here as a known flake for whoever next hardens store-manager
timing tests.

## Validation

- `yarn workspace @quereus/sync-client run build` — clean
- `yarn workspace @quereus/sync-coordinator run build` — clean
- `yarn workspace @quereus/sync-client run test` — **58 passing** (added relay test)
- `yarn workspace @quereus/sync-coordinator run test` — **125 passing** (flake above
  cleared on re-run)
- Both packages ship no-op lint by design; the only real lint (`packages/quereus`)
  is untouched by this ticket.
