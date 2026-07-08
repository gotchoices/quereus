description: A syncing client can permanently lose changes, because it marks data as "already received" based on best-effort broadcasts that may never have arrived, so the next catch-up request skips right over the missing data.
files:
  - packages/sync-coordinator/src/service/coordinator-service.ts  # lines ~631-672 — broadcast failures only logged
  - packages/quereus-sync-client/src/sync-client.ts               # lines ~319-324 — lastSyncHLC = max(hlc) for pushed batches
  - docs/sync.md
difficulty: medium
----

## Problem

Sync tracks progress with a per-client **watermark** — a Hybrid Logical Clock (HLC)
timestamp called `lastSyncHLC`. When the client asks the coordinator for more data it
sends `get_changes sinceHLC=<lastSyncHLC>`, and the coordinator returns only changes
newer than that. The watermark is therefore a promise: *"I have durably received
everything at or below this HLC."*

That promise is currently broken. The coordinator pushes changes to clients via
**fire-and-forget broadcasts**, and when a broadcast fails to deliver it is only
**logged** (`coordinator-service.ts:631-672`) — the coordinator does not know the client
missed it. Meanwhile the client **advances its watermark from those pushed batches too**:
it sets `lastSyncHLC = max(hlc)` over any batch it receives, including pushed broadcasts
(`sync-client.ts:319-324`).

The result is permanent data loss:

1. Coordinator broadcasts batch **X** (HLC 5). Delivery fails; only logged.
2. Coordinator broadcasts batch **Y** (HLC 6). Delivery succeeds.
3. Client advances `lastSyncHLC = 6`.
4. Next catch-up request is `get_changes sinceHLC=6` — it **skips X forever**. X (HLC 5)
   is at or below the watermark, so the coordinator never resends it.

The replica is now missing X with no mechanism to ever recover it.

## Expected behavior

The watermark may only advance to reflect data the client has **provably** received in
order. Advance `lastSyncHLC` **only from server-ordered `changes` responses** (the
replies to explicit `get_changes` requests, which are gap-free and ordered), **never**
from fire-and-forget pushed broadcasts. Pushed broadcasts may still be *applied*
eagerly as an optimization, but they must not move the watermark — the authoritative
catch-up request remains the sole source of watermark advancement, so any broadcast the
client missed is still delivered on the next `get_changes`.

Consider also whether the coordinator should treat a failed broadcast as anything more
than a log line (at minimum the client-side watermark fix closes the loss; note the
coordinator-side broadcast reliability as a related concern).

## Investigation / tests

- Confirm the two watermark-advance sites in `sync-client.ts` and split "apply" from
  "advance watermark" so only `changes`-response application advances it.
- Reproducing test: deliver a pushed broadcast at HLC 6, drop the broadcast at HLC 5,
  then issue a catch-up and assert HLC 5 is still delivered (watermark did not jump to 6
  off the pushed batch).
