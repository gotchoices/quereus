description: Migrate quereus-sync's store adapter (applyRowChanges) onto Database.ingestExternalRowChanges so remote changes applied directly to the KV store drive covering MVs, Database.watch, and (policy-gated) FK actions; also the tracking home for the adapter's dark secondary-index gap flagged by store-pk-collate-sync-adapter-rekey.
difficulty: hard
prereq: external-row-change-ingestion
files:
  - packages/quereus-sync/src/sync/store-adapter.ts               # applyRowChanges / applyDelete / applyColumnUpdates write committed KV directly
  - packages/quereus/src/core/database-internal.ts                # ingestExternalRowChanges (the seam, once landed)
  - packages/quereus-store/                                       # secondary-index maintenance lives module-side, not in the seam
----

# Sync store-adapter: report applied changes through the ingestion seam

## Background

`createStoreAdapter`'s `applyRowChanges` applies remote sync changes directly
to the table's KV store (`kv.put` / `kv.delete`), outside any Quereus
transaction, then emits `remote: true` data events. Consequences today:

- covering MVs over the synced table go stale (no row-time maintenance fires);
- `Database.watch` subscribers never see the inbound rows (no change capture;
  only the coarse `notifyExternalChange` path could even approximate it);
- FK actions never run for inbound parent deletes/updates;
- the **store module's own secondary indexes are not maintained** on applied
  changes — flagged as out-of-scope by the fix ticket
  `store-pk-collate-sync-adapter-rekey`; this ticket is the tracking home for
  that deferred concern.

## Expected behavior / use case

After applying an inbound batch to the KV store, the adapter reports the
batch through `Database.ingestExternalRowChanges` so covering MVs converge and
watch subscribers fire with row-granular hits. The adapter keeps emitting its
own `remote: true` module events (the seam deliberately does not emit events).

## Specification notes

- The adapter must supply accurate **before-images** (`oldRow`) for
  update/delete changes — it already reads the existing row in
  `applyColumnUpdates`; `applyDelete` currently deletes blind and would need a
  pre-read.
- The adapter writes committed KV outside a Quereus transaction, so the seam
  call runs in its own implicit transaction *after* the storage writes. Under
  that ordering FK RESTRICT can only detect-and-report, not protect (the
  storage row is already committed); FK actions should stay off (default)
  unless a deployment opts in deliberately.
- **The seam does not close the secondary-index gap**: index upkeep on direct
  KV writes is store-module storage, not post-write pipeline. Resolving it
  means either (a) a store-module-side index-maintenance entry point for
  externally-applied rows, or (b) switching the adapter to DML replay
  (`insert or replace` / `delete` through the engine), which closes *all* gaps
  — indexes, MVs, watch, FK, constraint validation — at per-row planning cost.
  Evaluate (b) first against the seam's decision matrix
  (docs/materialized-views.md § External row-change ingestion): sync batches
  are typically small per flush, so DML replay may be the simpler total answer
  for this adapter, with the seam reserved for bulk hosts like Lamina.
