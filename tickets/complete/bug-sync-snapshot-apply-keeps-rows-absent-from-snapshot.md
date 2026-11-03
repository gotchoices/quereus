description: Loading a full copy of the database from the server now really replaces what a device has, so rows the server deleted long ago finally disappear from a device that fell behind. It also deletes local rows the server's copy lacks, which raises an open question about data written before sync was turned on.
architecture: docs/sync.md#snapshots-replace-rows
files:
  - packages/quereus-sync/src/sync/snapshot-coverage.ts # tablesToAnnounce (producers), removeRowsAbsentFromSnapshot (receivers), DATA_FLUSH_SIZE
  - packages/quereus-sync/src/sync/snapshot-stream.ts   # producer announces tables; table-start ensures; footer runs the removal pass
  - packages/quereus-sync/src/sync/snapshot.ts          # producer announces tables; reconcileSections; removal inside commitMetadata
  - packages/quereus-sync/src/sync/snapshot-checkpoint.ts # new in review: checkpoint records, moved out of snapshot-stream.ts
  - packages/quereus-sync/src/sync/sync-context.ts      # isMaterializedView, added in review
  - packages/quereus-sync/src/sync/sync-manager-impl.ts
  - packages/quereus-sync/src/metadata/table-identity.ts # liveTables accessor
  - packages/quereus-sync/src/sync/manager.ts           # interface docs
  - packages/quereus-sync-client/src/sync-client.ts     # comments only
  - packages/quereus-sync-client/src/types.ts           # bootstrapOnEmpty doc
  - packages/quereus-sync-client/README.md
  - docs/sync.md                                        # section: Snapshots replace rows
  - docs/sync-protocol.md
  - packages/quereus-sync/test/sync/snapshot-replaces-rows.spec.ts
  - packages/quereus-sync/test/sync/snapshot-resume.spec.ts
repro: verified
----

## What landed

A snapshot apply now makes each table it covers hold exactly the snapshot's rows. Before, both apply paths cleared sync metadata and upserted, so a row absent from the snapshot stayed in the store with no metadata, invisible to every sync path.

- **Covered tables.** The sender emits a section for every table it has a cell for, plus every table with a live `tg:` (name to generation) record in its local basis. An emptied table therefore gets a section with no cells. No chunk shape changed, so there is no wire-format bump.
- **Streaming.** A pass in the footer, after the last flush and before `bootstrapFinalize`, takes each table's keep set from its `cv:` records. It holds no extra state, survives resume, and re-runs on retry.
- **Non-streaming.** Inside `commitMetadata`, ahead of the clear, using the keys of the reconciled rows.
- **Removal.** Reads keys through `ctx.db`, collects the absent ones, then deletes in `DATA_FLUSH_SIZE` chunks through `applyDataToStore` with `{ remote: true, bootstrap: true }`. Materialized views are skipped and rebuilt by `bootstrapFinalize`.

Rows with no sync metadata in a covered table are now deleted. See the first finding below.

## Review findings

Read the diff of `ticket(implement): bug-sync-snapshot-apply-keeps-rows-absent-from-snapshot` before the handoff, then probed the code with a throwaway spec (since deleted).

### Major

- **Fixed: a materialized view aborted every snapshot.** A view's `create_table` migration mints a `tg:` record, but its rows never carry cells, so it now always gets an empty section. The receiver read that as "this table is empty" and tried to delete all the view's rows. With a memory-backed view, including one created without `using` on a database whose default module is memory, the apply failed with `Table not found for external write` and kept failing on retry. A store-backed view passed, but only because its rows were deleted and then rebuilt. Reproduced on both paths. `removeRowsAbsentFromSnapshot` now skips these tables through a new `SyncContext.isMaterializedView`. The guard is on the receiver because a relay has no catalog and cannot filter its announcements. Pinned by a new spec case, seen failing before the fix. The handoff's memory-table analysis did not cover views.
- **Answered the handoff's question: `isReplicaEmpty` is not tightened here; filed `blocked/sync-rows-written-before-sync-attached`.** A device holding rows from before sync attached can lose them silently on first connect under default settings, and Quoomb Web's "store" to "sync" switch is that path (read in code, not run in a browser). Tightening the check alone only moves the loss, because `snapshot_required` recovery still deletes those rows once the server has pruned, and they have nothing to push. What should happen to them is a product decision the specification does not settle, so the ticket proposes a rule and alternatives. **This remains an open data-loss path until that is decided.** I made the behaviour visible in the `bootstrapOnEmpty` option doc and the client README, which had not mentioned it.

### Minor, fixed in this pass

- **File size.** `snapshot-stream.ts` was 1041 lines and its `NOTE` had a stale 870 count and named checkpoint management as the place to split, so the condition had tripped. Moved that section to `snapshot-checkpoint.ts`: `snapshot-stream.ts` is now 927 lines and the new file 116 (`wc -l`). No behaviour change. Updated the file reference in `backlog/bug-sync-resume-snapshot-unvalidated-checkpoint`.
- **Docs.** Added materialized views to `docs/sync.md` § Snapshots replace rows. Corrected `requestSnapshot` in the client README, which described only overwriting and not deletion, and the "replacing all local data" comment on `applySnapshot`.
- **`NOTE` on non-store tables.** It said to filter these out of `tablesToAnnounce`, which a relay cannot do. It now says to skip them at the removal site.

### Checked, no defect

- **Identity agreement, the risk of silently deleting live rows.** On both paths, each kept its sender row and removed an extra local one: reversed and descending composite keys, no declared key, `nocase`, `rtrim`, blob, date, datetime, timespan, json, boolean, real, big integer. The existing spec covers keeping rows of most of these types but not removing them, so this removal check was new. I did not keep these as tests: the keep-side spec already pins the identity contract, and the delete path is the same for every type.
- **Handoff's "worth trying" items.** A stale snapshot on a replica with a secondary index and a store-backed view, removing more than `DATA_FLUSH_SIZE` rows, converged. A chunk array with no empty sections applied and left the emptied table's rows in place, as `docs/sync.md` claims.
- **Failure recovery.** A `tg:` record staged by `ensure` at `table-start` is covered by `withIdentityRecovery`, and a checkpoint is only saved after the batch holding it is written, so a checkpoint naming an empty table cannot outrun its record.
- **Non-store base tables.** Confirmed that rows in a `using memory` table are captured and pushed, so these tables do not sync today, and I agree with the handoff's `NOTE`. One thing the handoff understated: `tg:` is minted at `create table`, so such a table is announced even if it was never written. A receiver holding rows in its own copy that it has not pushed, such as a read-only client, would still fail on retry. Left as the tripwire, since fixing it means the sync layer learning which tables have a write path.

### Tripwires already parked by the implementer, still accurate

- Removal pass cost is unmeasured, and the narrow write race between a table's `cv:` scan and its table scan: `NOTE:`s at `removeRowsAbsentFromCoveredTables`.
- Non-store base tables: `NOTE:` at `removeRowsAbsentFromSnapshot`.

### Considered and left alone

- **A failed key scan rejects without `status: 'error'`.** It matches a `bootstrapFinalize` failure in the same footer, and the checkpoint stays for a retry.
- **`batchSize++` at `table-start` counts even when nothing was minted.** At worst this flushes slightly early.
- **Tombstones for a table the receiver lacks still throw.** Unchanged by this work, and documented under Unknown-Table Disposition.
- **Dotted schema names** are skipped by the footer pass, inheriting the accepted `parseBootstrapTables` limitation.

### Tests

Kept all 14 implementer cases. Streaming and non-streaming pairs exercise different code, and each case pins a separate behaviour. Added one for the materialized view. One shared helper holds the guard, so one case is enough.

### Validation

- `yarn workspace @quereus/sync test`: 788 passing. `yarn workspace @quereus/sync-client test`: 87 passing. `yarn workspace @quereus/sync-coordinator test`: 135 passing.
- `yarn build` is clean. `typecheck` is clean for `@quereus/sync` and `@quereus/sync-client`. `yarn lint` ran after the last edit; only `packages/quereus` has a real lint, and this change does not touch it.
- After those runs, the only source edit was a blank line in a file header comment.
- Not run: the full `yarn test` across all workspaces, and `yarn test:store`. Nothing was run in a browser.
