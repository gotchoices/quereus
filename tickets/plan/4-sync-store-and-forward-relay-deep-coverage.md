description: Add deeper end-to-end and multi-hop tests for store-and-forward relay — confirm a retired-table peer really passes a straggler's edits through to a holder using actual SQL tables, and across a chain of three or more peers.
prereq:
files:
  - packages/quereus-sync/test/sync/store-and-forward-relay.spec.ts          # current lightweight harness (metadata-layer)
  - packages/quereus-sync/test/sync/echo-loop-quiescence.spec.ts             # existing real-engine (Database + StoreModule) pattern to mirror
  - packages/quereus-sync/src/sync/sync-manager-impl.ts                      # collectForwardableChanges + getChangesSince merge
difficulty: medium
----

# Deeper coverage for store-and-forward outbound relay

The `store-and-forward` relay (shipped across `sync-store-and-forward-hold` +
`sync-store-and-forward-relay`) is correctness-proven and covered at the
SyncManager / CRDT-metadata layer by `store-and-forward-relay.spec.ts` (now 10
specs, including a forced-truncation bound test added in review). Two coverage
gaps remain deliberately deferred — neither is a known defect; both would harden
confidence against future regressions.

## Real-engine end-to-end relay

The relay specs assert at the metadata layer (mirroring
`unknown-table-disposition.spec.ts`): a `SyncManagerImpl` over an in-memory KV, a
recording `applyToStore` stub, and a `known`-set basis oracle. They do **not**
drive a real `Database` + `StoreModule` the way `echo-loop-quiescence.spec.ts`
does. The materialization claim (a relayed change with the straggler's original
HLC lands as a live row on the holder) is currently asserted via the holder's
`columnVersions`, not via `select * from <table>`.

Add a real-engine straggler → relay → holder test: a holder peer with an actual
SQL table for the retired table, a relay peer that has retired it
(`store-and-forward`), and a straggler write that flows straggler → relay (held
forwardable) → holder (pulled, applied, **queried back via SQL**). This closes
the gap between "CRDT metadata records it" and "the row is really there."

## Multi-hop relay chain (depth ≥ 3)

Current loop-freedom / convergence coverage tops out at depth 2 (the ping-pong
spec exercises S → R1 → R2 → R1). The convergence argument (original-HLC identity
+ scalar per-peer watermark, no peer-membership oracle) holds for any depth, but a
3-or-more-hop chain to a distant holder (S → R1 → R2 → R3 → H) is not explicitly
tested. Add a chain test that confirms the forwarded change reaches a holder
several relay hops away, exactly once, with its original `hlc` + `siteId` intact,
and that the chain quiesces (no unbounded re-send, one forwardable entry per
non-holder).

## Note (not in scope here)

The `relayed` telemetry counter intentionally over-counts under batch truncation
(it is bumped by candidate count at collection time, before
`buildTransactionChangeSets` may defer some past the batch bound). This was
reviewed and judged acceptable: it is documented as "relay activity, not distinct
deliveries" and is observe-only. Do **not** change the counter semantics under
this ticket unless a concrete consumer is shown to be misled by it.
