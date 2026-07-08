description: The sync client now tags each batch of changes it pushes to the server with an id, and the server echoes that id back on its acknowledgement, so a late or duplicate acknowledgement can no longer be credited to the wrong batch.
files:
  - packages/quereus-sync-client/src/sync-client.ts        # pendingSentHLCs map, promoteWatermark, nextApplyRequestId, pushLocalChanges
  - packages/quereus-sync-client/src/types.ts              # ApplyChangesMessage.requestId, ApplyResultMessage.requestId
  - packages/sync-coordinator/src/server/websocket.ts       # handleApplyChanges echoes requestId
  - packages/quereus-sync-client/test/sync-client.spec.ts   # "apply_result correlation" describe block
  - docs/sync.md                                            # protocol tables + local-change flow
----

## What changed

Correlation id on the push→ack round-trip so an `apply_result` can be tied to
the exact `apply_changes` batch that produced it. Before this, **any**
`apply_result` promoted whatever single `pendingSentHLC` scalar happened to hold,
so an out-of-order / duplicate / stale ack (e.g. redelivered across a reconnect)
could over-advance `lastSentHLC` and silently drop unsent local changes from
future delta sync.

Mechanism:

- **`types.ts`** — `ApplyChangesMessage.requestId?: string` (client→server) and
  `ApplyResultMessage.requestId?: string` (server→client, echoed). Optional: a
  peer-relay push omits it (see below), and `undefined` is dropped by
  `JSON.stringify` so the wire form is clean.
- **`sync-client.ts`** — replaced the scalar `pendingSentHLC` with a
  `Map<requestId, HLC>` (`pendingSentHLCs`). `pushLocalChanges` mints a
  monotonic id via `nextApplyRequestId()` (`apply-1`, `apply-2`, …), sends it,
  and — only if the send succeeded — records `requestId → max HLC of the batch`.
  `handleApplyResult` delegates to `promoteWatermark(requestId)`, which promotes
  `lastSentHLC` **only** for a recorded id, **only forward** (never regressing
  past a newer batch a prior ack already promoted), and prunes any pending
  batches the new watermark now subsumes.
- **`websocket.ts`** — `handleApplyChanges` echoes `msg.requestId` back on the
  `apply_result`. Server keeps no state.

Built on top of ticket #1 (`sync-client-reconnect-on-transient-error`): the
folded `send()` return-value check means a push whose `send()` fails registers
**no** pending id / watermark.

## Key invariants a reviewer should check

- **Forward-only + prune.** `promoteWatermark` sets `lastSentHLC` only when the
  acked HLC is greater, then deletes every pending entry `≤` the new watermark.
  This relies on the fact that a second push fired before the first was acked
  re-sends a **superset** (delta sync reads `getChangesSince(lastSentHLC)`, and
  `lastSentHLC` hasn't moved yet). If `pushLocalChanges` is ever changed to send
  disjoint ranges without waiting for acks, the prune could drop a batch that
  wasn't actually covered — currently sound.
- **Reconnect safety.** `disconnect()` clears `pendingSentHLCs` but deliberately
  does **not** reset `applyRequestSeq`. So a stale ack redelivered after a
  reconnect carries an id we no longer hold → dropped, never colliding with a
  reused id. Resetting the counter would reintroduce the mis-credit bug.
- **Untracked pushes.** `handleRequestChanges` (peer-to-peer relay) sends
  `apply_changes` with **no** requestId; its ack therefore has none →
  `promoteWatermark` returns early, no watermark move, no log. An ack that *does*
  carry an id we don't hold is the genuine stale/duplicate case and emits an
  `info` sync event.

## Tests / validation

Run: `yarn workspace @quereus/sync-client run test` (57 passing) and
`yarn workspace @quereus/sync-coordinator run test` (125 passing). Both build
clean (`run build`); the two packages ship no-op lint by design.

New `apply_result correlation` describe block in `sync-client.spec.ts`:

- **stamps each push with a monotonic requestId** — asserts `apply-1`, `apply-2`.
- **advances only for the matching requestId** — a `apply-999` ack does nothing;
  the matching ack promotes `lastSentHLC` exactly once and clears the pending map.
- **no regression on out-of-order / duplicate** — two in-flight pushes (hlc1,
  hlc2); ack the newer first, then the older's late ack and a duplicate of the
  newer both leave `lastSentHLC` at hlc2.

Updated the existing `send failure` test to assert on `pendingSentHLCs.size`
instead of the removed scalar.

## Known gaps (reviewer: your tests are a floor, not a ceiling)

- **No coverage of the peer-relay path** (`handleRequestChanges` →
  `apply_changes` without requestId). The tests exercise only the
  `pushLocalChanges` path. The relay ack is handled by the same
  `promoteWatermark(undefined)` early-return, so it's covered by construction,
  but there is no explicit test driving a `request_changes` message. Worth a
  targeted test if the relay path matters.
- **Legacy-server behavior (tripwire, not a bug here).** Against a coordinator
  that predates this change and does not echo `requestId`, the client's ack
  carries no id → `lastSentHLC` never advances → the client re-pushes all local
  changes on every push. Correctness is preserved (server dedups by HLC), but
  the delta-sync optimization is lost. Not a concern in-repo (client + server
  land together); flagged only in case a mixed-version deployment appears.
- **Map growth tripwire** parked as a `NOTE:` at the `pendingSentHLCs`
  declaration: bounded by in-flight pushes today (each ack self-prunes,
  disconnect clears); would grow one entry per push only if a server accepts
  `apply_changes` but never acks. Cap (evict-oldest) only if that ever shows up.
- **Pre-existing unused import.** `ServerMessage` in `sync-client.ts` was already
  imported-but-unused before this ticket (build passes; LSP flags it as a hint).
  Left untouched — not introduced here.
