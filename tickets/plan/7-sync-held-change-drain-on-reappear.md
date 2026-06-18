description: When a table that was deleted comes back, the edits that were being held on its behalf should be replayed into it automatically, instead of only sitting in the hold store or being passed to other peers.
prereq:
files:
  - packages/quereus-sync/src/metadata/quarantine.ts        # held entries (quarantine + forwardable)
  - packages/quereus-sync/src/sync/change-applicator.ts     # create_table detection in a batch
----

# Drain held out-of-basis changes when their table reappears locally

When a peer holds straggler changes for a table it no longer has — either
`quarantine`d or `store-and-forward` (forwardable) entries (see the completed
`sync-unknown-table-disposition` work and the `sync-store-and-forward-*` tickets)
— and that table later **reappears** in the local basis (the peer re-adds the
basis table, e.g. via an inbound `create_table` migration or an app-side
re-create), the held changes for it should be **drainable into the now-present
table** rather than remaining held indefinitely (until horizon GC) or only being
relayed to other peers.

This is a future concern, not active work, because:

- It is **orthogonal** to both shipped dispositions: it applies to plain
  `quarantine` entries as much as to `store-and-forward` forwardable ones — a held
  change is a held change, regardless of why it was held.
- The current behaviors already bound the risk: held changes are operator-
  inspectable (`QuarantineStore.list`) and reclaimed at the retention horizon; a
  forwardable entry additionally reaches peers that still hold the table. Nothing
  is silently lost.
- It introduces a new trigger (basis reappearance) and a replay path (re-feeding
  held `Change`s through resolution against the now-present table, respecting LWW
  and tombstone blocking on re-entry), which is a self-contained feature worth its
  own design pass.

## Use case / expected behavior

- A table T retires on peer P; P holds straggler changes for T (quarantine or
  forwardable). Later T reappears in P's basis (re-created locally, or a
  `create_table` for T arrives in an inbound batch).
- On (or shortly after) reappearance, P's held changes for T should be replayed
  into T through the normal apply path — resolved against any current state,
  subject to the usual LWW / tombstone-blocking / resurrection rules — so the
  straggler's writes land in the revived table instead of waiting for manual
  replay or aging out at the horizon.
- Drained entries are removed from the hold store once successfully applied
  (idempotent: a crash mid-drain re-drains the survivors; HLC-keyed entries make
  re-drain safe).

## Open questions to resolve when promoted

- **Trigger granularity.** Drain inline when a `create_table` for T is detected in
  an apply batch (P1 detection already computes the batch table delta), vs. a
  separate operator-/host-driven `drainHeldChanges(schema, table)` sweep (parity
  with the caller-driven `pruneQuarantine` / `pruneTombstones` pattern), vs. both.
- **Ordering vs. the reappearing data.** If the same batch both re-creates T and
  carries fresh changes for T, the held (older) changes and the batch's (newer)
  changes must converge by HLC — drained changes are resolved like any other
  inbound change, so LWW handles it, but the interaction with the batch's own
  admission unit needs care (drain inside vs. after the admission).
- **Forwardable entries that were also relayed.** A forwardable entry already
  forwarded to other peers and now drained locally is fine (idempotent at every
  receiver by original HLC), but confirm no double-count in telemetry.
- **Scope of the scan.** Draining is a per-table scoped scan
  (`buildQuarantineScanBounds(schema, table)`), cheap and bounded.

This belongs in `backlog/` until a human promotes it; the shipped dispositions
already prevent write loss, so this is an ergonomics/timeliness improvement on the
revival path.
