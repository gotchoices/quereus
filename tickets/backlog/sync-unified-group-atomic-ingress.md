description: Collapse the three sync ingress paths (wire applyChanges, snapshot/snapshot-stream bootstrap, and the planned schema-seed-as-peer) onto one group-atomic admission core — "apply a transaction group atomically, advance the watermark idempotently" — mirroring Lamina's single `acceptLocalFacts` admission seam that synthesizes one transaction group per `(hlc, siteId)` run. Shrinks the surface where the data-first/metadata-second + idempotent-replay invariant must be re-proven.
prereq: sync-hlc-transaction-grouping
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts     # applyChanges / applySnapshot / applySnapshotStream
  - packages/quereus-sync/src/sync/change-applicator.ts      # per-group apply + throwIfApplyErrors
  - packages/quereus-sync/src/sync/store-adapter.ts          # applyToStore seam (data-first, then metadata)
  - docs/sync.md                                            # § Transactional Integrity During Sync, § Schema Seed (App Provider as Sync Peer)
----

# Unify sync ingress behind one group-atomic admission core

## Motivation

Lamina exposes one admission seam for every ingress modality — wire sync,
archive ingest, and library-merge all route through a single group-atomic path
(`acceptLocalFacts` synthesizes one `TransactionGroup` per `(hlc, siteId)` run
and admits the whole group or none; ../lamina/docs/architecture.md §9).

Quereus has three ingress shapes that each independently re-implement the
write-order + idempotence invariant from `docs/sync.md`
§ Transactional Integrity During Sync (data first → metadata second; abort with
no metadata on any throw or per-change error; idempotent re-apply on retry):

- `applyChanges` — the wire path.
- `applySnapshot` / `applySnapshotStream` — bootstrap / recovery.
- The **schema-seed-as-sync-peer** pattern (`docs/sync.md` § Schema Seed) —
  app-provider seed applied via `applyChanges` today, but conceptually a fourth
  caller of the same admission.

## Expected shape

A single internal admission function that takes a **transaction group** (the
unit defined by `sync-hlc-transaction-grouping`) and:

1. applies the group's data via the store adapter (data write lands first),
2. commits CRDT metadata only after the data write succeeds,
3. advances `lastSyncHLC` only on full-group success, idempotently,
4. on any whole-group throw or per-change `ApplyToStoreResult.errors`, commits no
   metadata and does not advance the watermark (the whole group re-resolves next
   sync — the existing `throwIfApplyErrors` discipline).

Wire `applyChanges`, the snapshot finalizer, and the seed path all become thin
adapters that feed groups into this one core.

## Notes

- Depends on `sync-hlc-transaction-grouping` for the transaction-group unit; do
  not invent a second grouping primitive here.
- Must preserve the all-or-nothing-per-group semantics already documented (no
  selective/partial commit — the single-watermark constraint in
  `docs/sync.md` makes "all but the failed change" inexpressible).
- Bootstrap has a fast path (`ApplyToStoreOptions.bootstrap` /
  `bootstrapFinalize` in `protocol.ts`) that skips the engine seam; the unified
  core must keep that escape hatch rather than forcing every snapshot chunk
  through full per-row maintenance.
