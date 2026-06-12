description: Snapshot bootstrap re-runs full-rebuild MV maintenance once per 100-change flush — O(flushes × body); want a bootstrap mode that defers MV maintenance to one rebuild at snapshot end
files:
  - packages/quereus-sync/src/sync/snapshot-stream.ts      # DATA_FLUSH_SIZE = 100; each flush is one applyToStore call
  - packages/quereus-sync/src/sync/snapshot.ts             # non-streamed bulk apply (one batch per call — already amortized)
  - packages/quereus-sync/src/sync/store-adapter.ts        # the seam call per applyToStore invocation
  - packages/quereus/src/core/database-external-changes.ts # batch-amortized maintenance; full-rebuild once per batch
----

# Snapshot bootstrap: defer MV maintenance to a single end-of-snapshot rebuild

## Context

Once the sync store adapter reports applied changes through
`Database.ingestExternalRowChanges` (ticket `sync-adapter-ingest-via-seam`),
every `applyToStore` invocation is one seam batch. The streamed snapshot path
flushes every 100 changes (`DATA_FLUSH_SIZE`), so a bootstrap of a large
database over a table with a full-rebuild materialized view rebuilds that MV
once **per flush** — O(flushes × body) — and bounded-delta MVs pay per-change
maintenance for rows that are all brand new anyway.

## Expected behavior

During a snapshot bootstrap (a known-complete wholesale apply, not an
incremental delta), MV maintenance should be deferrable: apply all storage
rows with maintenance off (`maintainMaterializedViews: false` per flush, or a
dedicated bootstrap signal on the adapter), then converge every affected MV
once at snapshot end (refresh / single full rebuild). Watch capture during
bootstrap is a related question — a coarse `notifyExternalChange` per table at
the end may be preferable to row-granular capture of every bootstrapped row.

## Notes

- The adapter's `applyToStore` callback currently receives no signal
  distinguishing bootstrap flushes from incremental applies;
  `ApplyToStoreOptions` would need to carry it (the snapshot paths know).
- Raising `DATA_FLUSH_SIZE` is a blunt partial mitigation (memory vs rebuild
  count); the deferral is the real fix.
- Out of scope for the seam-migration ticket; behavior there is correct,
  just bootstrap-slow.
