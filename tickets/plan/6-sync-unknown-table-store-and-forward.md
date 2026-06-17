description: Optionally let a peer that no longer has a table pass along incoming changes for it to other peers that still do, instead of just holding them locally.
prereq: sync-unknown-table-disposition
files:
  - packages/quereus-sync/src/metadata/quarantine.ts      # held-change durable store to extend
  - packages/quereus-sync/src/sync/protocol.ts            # disposition enum + getChangesSince
  - packages/quereus-sync/src/sync/change-applicator.ts   # disposition handling
  - packages/quereus-sync/src/sync/sync-manager-impl.ts   # outbound change collection
----

# Unknown-table disposition: the store-and-forward (relay) half

This is the third disposition named in `docs/migration.md` § 4 Contract
(Unknown-table disposition), deferred from the `sync-unknown-table-disposition`
implement ticket. That ticket delivers `ignore` and `quarantine` — enough to
prevent silent write loss. `store-and-forward` is the **relay** option: a receiver
that no longer holds a table not only *holds* a straggler's changes for it
(quarantine) but also *forwards* them to peers that still do, keeping the
straggler's writes alive across an **uneven retirement** window (the table has
retired here but persists on some peers).

It is parked as a future concern, not active work, because:

- The write-loss-protection goal is already met by `quarantine`.
- It requires new **outbound relay integration** (`getChangesSince` /
  `collectChangesSince`), which the hold-only dispositions do not touch.
- It is an optimization for the transitional uneven-retirement case, not the
  steady post-retirement state the parent ticket targets (in the fully-retired
  state no peer holds the table, so there is nothing to forward to).

## What it should do

- Extend the disposition type to `'ignore' | 'quarantine' | 'store-and-forward'`.
- Under `store-and-forward`, hold the straggler's changes durably (the same
  `QuarantineStore` substrate, entries marked **forwardable**) **and** include
  those held changes in this peer's outbound sync so they reach peers that still
  hold the table.

## Requirements / specification

- **Reuse the hold substrate.** Forwardable entries live in the same durable store
  as quarantined ones (a flag on the entry), so the durability/idempotency/GC
  guarantees already built carry over. GC still bounds them at the retention
  horizon — a held change older than the horizon was already outside the delivery
  guarantee.
- **Relay verbatim with original identity.** A forwarded change keeps its
  **original `HLC` and `siteId`** (it is the straggler's change, not a new local
  fact). This original-HLC identity is the loop breaker: a peer that already has
  the change (by HLC) suppresses it, and per-peer `lastSyncHLC` watermarks stop the
  same held change from being re-sent to the same peer twice.
- **Outbound integration.** `getChangesSince(peer, sinceHLC)` must additionally
  yield forwardable held changes whose HLC > `sinceHLC`, excluding those whose
  `siteId` is the requesting peer (echo prevention). A peer that holds the table
  applies the change normally; a peer that does not re-disposes it (recursively
  holding/forwarding), converging because every hop preserves the original HLC.
- **No membership oracle required.** The receiver need not know which peers hold
  the table: forwarding to all peers is correct because non-holders re-dispose
  harmlessly. Convergence and loop-freedom rest on original-HLC dedup + per-peer
  watermarks, not on per-table peer membership.
- **Telemetry parity.** The `onUnknownTable` event and counter report
  `store-and-forward` like the other dispositions; consider distinguishing
  "forwarded" volume in the stats.

## Edge cases & interactions to design when promoted

- Cross-peer ping-pong between two non-holders (both `store-and-forward`): bounded
  by original-HLC identity (each peer already has the entry after the first hop) and
  per-peer watermarks — verify convergence with a 3-peer test (straggler → relay →
  holder).
- A forwarded change whose table later **reappears** locally (peer re-adds the
  basis table): held forwardable entries should be drainable into the now-present
  table rather than only relayed.
- Interaction with snapshot/bootstrap outbound paths (do forwardable entries belong
  in a snapshot, or only in delta sync?).
- GC vs in-flight relay: pruning a forwardable entry at the horizon while a slow
  peer still needs it — acceptable (that peer was already past the guarantee), but
  document it.
- Ordering of forwarded changes relative to locally-originated changes in the same
  `getChangesSince` response (HLC order must remain globally consistent).
