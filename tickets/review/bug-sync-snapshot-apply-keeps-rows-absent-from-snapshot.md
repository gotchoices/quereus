description: Loading a full copy of the database from the server now really replaces what a device has, so rows the server deleted long ago finally disappear from a device that fell behind. This needs review because it also deletes local rows the server's copy does not have.
architecture: docs/sync.md#snapshots-replace-rows
files:
  - packages/quereus-sync/src/sync/snapshot-coverage.ts # new: tablesToAnnounce (producers), removeRowsAbsentFromSnapshot (receivers), DATA_FLUSH_SIZE moved here
  - packages/quereus-sync/src/sync/snapshot-stream.ts   # producer announces tables; table-start ensures; footer runs the removal pass
  - packages/quereus-sync/src/sync/snapshot.ts          # producer announces tables; reconcileSections; removal inside commitMetadata
  - packages/quereus-sync/src/metadata/table-identity.ts # liveTables accessor
  - packages/quereus-sync/src/sync/manager.ts           # interface docs
  - packages/quereus-sync-client/src/sync-client.ts     # comments only
  - docs/sync.md                                        # new section: Snapshots replace rows
  - docs/sync-protocol.md
  - packages/quereus-sync/test/sync/snapshot-replaces-rows.spec.ts # new
  - packages/quereus-sync/test/sync/snapshot-resume.spec.ts # probe's table list gains main.ghost
repro: verified
----

## What changed

A snapshot apply now makes each table it covers hold exactly the snapshot's rows. Before, both apply paths cleared sync metadata and upserted, so a row absent from the snapshot stayed in the store with no metadata, invisible to every sync path.

- **Covered tables.** The sender emits a section for every table it has a cell for, plus every table with a live `tg:` (name to generation) record that is in its local basis. An emptied table therefore gets a section with no cells. No chunk shape changed, so there is no wire-format bump.
- **Streaming.** A pass in the footer, after the last flush and before `bootstrapFinalize`, takes each table's keep set from its `cv:` records. It holds no extra state, survives resume, and re-runs on retry because the checkpoint is still in place.
- **Non-streaming.** Inside `commitMetadata`, ahead of the clear, using the keys of the reconciled rows. A failure leaves the prior metadata intact.
- **Removal.** Read keys through `ctx.db`, collect the absent ones, then delete in `DATA_FLUSH_SIZE` chunks through `applyDataToStore` with `{ remote: true, bootstrap: true }`.

## Behaviour change to judge

Rows with no sync metadata in a covered table are now **deleted**; before they were orphaned. This affects:

- Unpushed local inserts under an explicit `requestSnapshot()`. `snapshot_required` recovery pushes first, so it is unaffected.
- Rows written before sync attached, on a device that passes `isReplicaEmpty` (no peer state, no change facts). `bootstrapOnEmpty` now removes them if the server covers that table.

**Please decide whether the `isReplicaEmpty` gate should be tightened**, for example by also checking that covered tables hold no rows. I documented the behaviour in that comment and in both docs but did not change the gate.

## Departures from the implement ticket

- New module `snapshot-coverage.ts` rather than `snapshot-identity.ts`, because this is replacement logic, not identity. `DATA_FLUSH_SIZE` moved there to avoid an import cycle and is re-exported from `snapshot-stream.ts`, so the specs that import it are unchanged.
- The non-streaming path also calls `ensure` for each section. The ticket's list named only streaming, but the same onward-announce gap exists there.
- `await ctx.whenCommitsSettled()` runs before each table's `cv:` scan. Without it, a committed local write whose capture is still on the commit chain has no cell record yet and would be deleted, contradicting the ticket's claim that such writes survive.
- The ticket's `nocase` case as written ('APPLE' local, 'apple' in the snapshot) passes with or without the collation: the apply also writes the key cell, so the row is already lower-case when scanned. The test also covers the reverse spelling, which is the direction that catches it.

## Tests

`snapshot-replaces-rows.spec.ts`, 14 cases. The first five failed before the fix (for example `expected [ 1, 2 ] to deeply equal [ 1 ]`); the sixth passed before and after.

| Test | Verifies |
| --- | --- |
| streaming / non-streaming: a row deleted and pruned leaves the replica (2) | the reported bug on both paths |
| streaming / non-streaming: a table the sender emptied and pruned is emptied here too (2) | empty sections are announced and honoured |
| streaming: a tombstoned (not yet pruned) row leaves the replica | a tombstoned row has no live cell, so it goes too |
| leaves a table the snapshot does not mention alone | unmentioned tables are untouched |
| a transfer resumed after a table completed still removes that table's absent row | the footer covers tables an earlier session finished; asserts the checkpoint really names the table |
| keeps a row whose key is spelled differently here, under a key collation | collated comparison, in both spelling directions |
| keeps a row of every key type | scanned keys encode to the identity cells were filed under (big integer, real, blob, boolean, date, datetime, timespan, json). A mismatch here would silently delete live rows |
| keeps or removes the one row of a singleton table | the `primary key ()` branch |
| streaming / non-streaming: a section for a table this replica does not have (2) | a section with no cells and no migration applies without error |
| streaming / non-streaming: a relay that bootstrapped an emptied table announces it (2) | `ensure` keeps the table announced to the next peer |

I also ran eight one-line mutations of the new code against this spec, and each made at least one test fail. That is how the weak `nocase` case surfaced.

**Existing spec changed:** in `snapshot-resume.spec.ts` the checkpoint probe's expected-rows map gains `['main.ghost', 0]`, because its fully deleted table now has a section. Its invariant is unchanged, and it was not pinning the bug. No other spec needed changing.

## Validation

- `yarn workspace @quereus/sync test`: 787 passing on the final code.
- `yarn workspace @quereus/sync-client test`: 87 passing. `yarn workspace @quereus/sync-coordinator test`: 135 passing. Both ran before the last edits, which touched only a code comment and `snapshot-replaces-rows.spec.ts`.
- `yarn build` is clean (also before those edits). `typecheck` exits 0 for `@quereus/sync` on the final code, and for `@quereus/sync-client`, whose code did not change after it ran.
- Not run: the full `yarn test` across all workspaces, and `yarn test:store`.

## Known gaps

- **Cost is not measured.** The streaming pass adds one `cv:` scan and one table scan per covered table, and holds one key per row of the table in progress, even on a brand-new replica where it removes nothing. Parked as a `NOTE:` at `removeRowsAbsentFromCoveredTables`.
- **A narrow write race remains.** A local write committing between a table's `cv:` scan and its table scan is deleted. Parked as a `NOTE:` at the same site; this is the gap `feat-sync-bootstrap-write-gate` tracks, and `docs/sync-protocol.md` now mentions it.
- **Non-store tables have a new failure case.** A sender's empty `using memory` table now gets a section, so a receiver holding rows in its own copy aborts the apply with `Table not found for external write`, and it keeps failing on retry. I verified this by running it. I also verified that a memory table with rows on the sender already aborts a snapshot today, and read in the code that such rows are captured and pushed, so these tables do not sync today. I treated this as an extension of that limit and parked it as a `NOTE:` in `snapshot-coverage.ts`. Please check that you agree.
- **Tombstones for a table the receiver lacks still throw.** The tolerance covers empty sections only: a tombstone chunk for such a table still fails at `resolveKeying`, as it did before. This is unchanged and has no test.
- **A failed key scan rejects without `status: 'error'`.** That matches a `bootstrapFinalize` failure in the same footer, but differs from a failed data flush.
- **The scan takes the serialized path (from reading the code, not tested).** `StoreModule` declines committed reads, so the scan falls back and takes the exec mutex, as the re-key pass does. A host applying a snapshot from inside a running statement would wait on it.
- **Dotted schema names** are skipped by the footer pass, which inherits the accepted `parseBootstrapTables` limitation.
- **File size.** `snapshot-stream.ts` is now 1041 lines (`wc -l`). Its own `NOTE:` still says 870 and names checkpoint management as the place to split.
- **Log noise.** Specs that wire no `db` now log the "cannot be removed" warning per table, as the ticket expected.

## Worth trying in review

- Apply a snapshot from a stale sender to a populated replica with secondary indexes and a materialized view, and check that all of them converge after removal. No test covers this combination; I relied on the existing seam and `bootstrapFinalize`.
- Replay a chunk array stored by an older build, with no empty sections, and confirm it applies and leaves emptied tables' rows in place, as `docs/sync.md` claims. No test covers this either.
