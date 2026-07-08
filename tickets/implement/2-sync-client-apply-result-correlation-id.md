description: When the sync client sends changes to the server, the server's acknowledgement isn't tied to the specific batch that was sent, so a late or duplicate acknowledgement can be credited to the wrong batch and advance the client's "already sent" marker incorrectly.
prereq: sync-client-reconnect-on-transient-error
files:
  - packages/quereus-sync-client/src/sync-client.ts        # pushLocalChanges (~432), handleApplyResult (~341), pendingSentHLC
  - packages/quereus-sync-client/src/types.ts              # ApplyChangesMessage (~139), ApplyResultMessage (~181)
  - packages/sync-coordinator/src/server/websocket.ts       # handleApplyChanges (~223)
  - docs/sync.md
difficulty: medium
----

## Problem

The client pushes changes via `apply_changes` and, on the next `apply_result`, promotes
`pendingSentHLC → lastSentHLC` (`handleApplyResult`, ~line 341). Nothing correlates an
`apply_result` back to the `apply_changes` that produced it. `apply_result` carries only
counts (`applied`, `skipped`, `conflicts`, `transactions`, `rejected[]`) — no request id.

So any `apply_result` promotes whatever `pendingSentHLC` currently holds. If two pushes are
in flight, or a stale/duplicate ack arrives (e.g. across a reconnect), the wrong batch's
watermark is committed — either over-advancing `lastSentHLC` (silently dropping unsent
changes from future delta sync) or crediting the wrong batch.

## Design

Add a request/correlation id to the push→ack round-trip:

- `types.ts`: add `requestId: string` to `ApplyChangesMessage`, and echo it back as
  `requestId: string` on `ApplyResultMessage`.
- `sync-client.ts`: `pushLocalChanges` generates a request id and records the mapping
  `requestId → the HLC it is trying to promote` (replace the single `pendingSentHLC` field
  with a small map/queue keyed by request id). On `apply_result`, only promote
  `lastSentHLC` for the **matching** request id; ignore acks whose id we don't recognize
  (stale/duplicate) and log them.
- `websocket.ts`: `handleApplyChanges` echoes `msg.requestId` into the `apply_result`
  it sends. Server keeps no state — it just reflects the id.

Generating ids: avoid `Math.random`/`Date.now` reliance in a way that breaks determinism in
tests — a monotonic per-client counter (e.g. `apply-${++this.applyRequestSeq}`) is enough
and is test-friendly.

Interaction with ticket #1: the folded `send()` fix means a push whose `send()` fails must
**not** register a pending request id / watermark. Build this on top of that change.

## TODO

- [ ] `types.ts`: add `requestId` to `ApplyChangesMessage` + `ApplyResultMessage`.
- [ ] `sync-client.ts`: replace scalar `pendingSentHLC` with a per-request-id map; generate
      a monotonic request id in `pushLocalChanges`.
- [ ] `sync-client.ts`: `handleApplyResult` promotes `lastSentHLC` only for the matching
      request id; log + drop unrecognized acks.
- [ ] `websocket.ts`: echo `requestId` back in `apply_result`.
- [ ] Tests: out-of-order / duplicate `apply_result` does not mis-advance `lastSentHLC`;
      matching ack advances it exactly once.
- [ ] Update `docs/sync.md` protocol section with the correlation id.
- [ ] Tests green; lint.
