description: Loading a full copy of the database from the server is supposed to replace what a device has, but rows the device holds that are not in the copy are left in place, so a device can never get rid of rows the server deleted long ago.
architecture: docs/sync-protocol.md
files:
  - packages/quereus-sync/src/sync/snapshot-stream.ts   # applySnapshotStream: clearExistingMetadata (~381), flushDataToStore (~446), table-start/table-end handling (~640-760)
  - packages/quereus-sync/src/sync/snapshot.ts          # non-streaming applySnapshot (~225-310), same shape
  - packages/quereus-sync/src/sync/store-adapter.ts     # applyDataToStore bootstrap flush (~45-80, ~179)
  - packages/quereus-sync/src/sync/manager.ts           # applySnapshot doc says "replaces all local data" (~75)
  - packages/quereus-sync/test/sync/snapshot-bootstrap.spec.ts
repro: static
severity: wrong-result
likelihood: unusual
----

## What is wrong

Both snapshot apply paths (`applySnapshotStream` and the non-streaming `applySnapshot`) do two things: clear this replica's sync metadata (`cv:` / `tb:` / `cl:` records) and then upsert every row the snapshot carries, re-filing metadata for those rows. Neither path ever deletes a **store row that is absent from the snapshot**. The interface doc promises that `applySnapshot` "replaces all local data"; the row data is not replaced, only overlaid.

Consequence for a populated replica that takes a snapshot: any row it holds that the server no longer has survives, now with no sync metadata at all. It is never pushed (no change-log entry), never deleted by a later delta (the server has no tombstone for it, or pruned it), and is invisible to every sync path from then on. A "ghost row".

Today's automatic bootstrap sidesteps this by only running on an empty replica (`SyncClient.isReplicaEmpty`). The explicit `requestSnapshot()` on a populated replica has the problem now. The too-old-client recovery designed in `implement/bug-sync-delta-served-past-retention-horizon` hits it squarely: the rows that client needs to lose are exactly the rows the server deleted and pruned, which is exactly what the snapshot omits.

Inferred from reading the apply code (`flushDataToStore` only feeds `pendingDataChanges` built from received chunks into `applyDataToStore`; `clearExistingMetadata` touches only metadata prefixes). Nothing scans the local table.

## What would confirm it

Two real-engine peers from `test/sync/_peer-harness.ts` (`makePeer` with `createOrders`): A inserts rows 1 and 2, `relay(A, B)`; A deletes row 2 and runs `pruneTombstones()` with `retentionHorizonMs: -1`; B applies `A.getSnapshotStream()` through `applySnapshotStream`. Expected: `select id from orders` on B yields only row 1. Predicted today: rows 1 and 2.

## Expected behaviour

After a snapshot apply, every table the snapshot covers holds exactly the snapshot's rows. Tables the snapshot does not mention are a separate question (a sender may legitimately not host a table the receiver has; see `unknownTableDisposition` in `docs/sync.md`) and should be left alone.

Shape to evaluate: at each table's end (`table-end` chunk, or after the table loop in the non-streaming path) delete local rows whose primary key was not received for that table. The received key set per table must survive the mid-table `BATCH_FLUSH_SIZE` flushes, and a resumed transfer (`resume_snapshot`) must reconcile the tables it re-streams but not the ones it skips as completed. Memory is one key per received row of the current table, bounded by table size. Removals go through `applyToStore` as `delete` changes so engine-side watchers and materialized views see them in the same bootstrap-finalize pass as the upserts.
