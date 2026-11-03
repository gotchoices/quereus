description: A device that already holds data when sync is turned on could silently lose it on first connect, because the server's copy replaced what the device had. There is now a client option for what happens to those rows, and by default sync stops with a clear error instead of deleting anything.
architecture: docs/sync.md#snapshots-replace-rows
files:
  - packages/quereus-sync/src/sync/unrecorded-rows.ts # the read-only check
  - packages/quereus-sync/src/sync/manager.ts # SyncManager interface
  - packages/quereus-sync/src/sync/sync-manager-impl.ts # delegation, trackApply, whenAppliesSettled
  - packages/quereus-sync/src/sync/sync-context.ts # whenAppliesSettled
  - packages/quereus-sync/src/sync/snapshot-stream.ts # checkpoint saved before the header's clear
  - packages/quereus-sync/src/sync/snapshot-coverage.ts # scanLiveKeys extracted from collectAbsentKeys
  - packages/quereus/src/schema/manager.ts # _getAllSchemas moved onto the published types
  - packages/quereus-sync-client/src/sync-client.ts # unrecordedRowsAllowSnapshot, stopWithError, failAndRetry
  - packages/quereus-sync-client/src/types.ts # option and error
  - packages/quereus-sync-client/src/index.ts
  - packages/quereus-sync/test/sync/unrecorded-rows.spec.ts
  - packages/quereus-sync-client/test/sync-client.spec.ts
  - packages/quereus-sync-client/README.md
  - docs/sync.md
  - docs/sync-protocol.md
----

## What was built

`SyncClientOptions.unrecordedRows` is `'refuse'` (default) or `'replace'`. It governs rows sync has never recorded, usually rows written before sync attached.

- **Under `'refuse'`**, an automatic snapshot (the `bootstrapOnEmpty` bootstrap, or `snapshot_required` recovery) stops before deleting anything. The client calls `onError` with an `UnrecordedRowsError` naming the tables and the option, moves to status `error`, closes the socket and does not reconnect until the next explicit `connect()`, which checks again.
- **Under `'replace'`**, the snapshot deletes them, with no scan.
- **Never checked**: an explicit `requestSnapshot()`, including one started while a check is scanning, and any snapshot while a checkpoint is pending, because that transfer's header already cleared the metadata and every row would look unrecorded.
- **A scan that throws** is not a refusal: no snapshot follows, and the client retries through the normal reconnect.

The header of a snapshot apply now saves its checkpoint before clearing metadata, so a crash between the two leaves a checkpoint over intact metadata rather than rows that merely look unrecorded.

Decisions the implementer made beyond the plan, all kept after review:

- A table is reported only when two scans, with in-flight writes settled between them, name the same row. Waiting inside a scan can deadlock, because the store module's scan holds the execution mutex until it closes.
- `SyncContext.whenAppliesSettled` exists because `applyChanges` writes rows before their records.
- `_getAllSchemas` lost its `@internal` tag so `@quereus/sync` can compile against it, following the `_isExecuting` precedent.
- The check also returns `[]` with no `applyToStore`, matching when `removeRowsAbsentFromSnapshot` deletes nothing.
- A verdict for a socket that was replaced during the scan is dropped silently; the new socket's handshake decides for itself.

## Review findings

Reviewed from `ticket(implement): sync-unrecorded-rows-refuse`: all source, tests and docs in the diff, plus the client code around it.

**Validation.** `yarn build`, `yarn lint`, and `typecheck` for `@quereus/sync` and `@quereus/sync-client` pass. Tests: `@quereus/sync` 793, `@quereus/sync-client` 98, `@quereus/sync-coordinator` 135, all passing.

**Fixed in this pass (defects, each reproduced by a failing test first):**

- **The check could stop an explicit snapshot.** `await connect(); await requestSnapshot()` starts a transfer while the bootstrap's check is scanning. The verdict then stopped that transfer with `UnrecordedRowsError`, breaking the rule that an explicit snapshot is never checked. It would also have read metadata the transfer's header had cleared. The guard now treats a running transfer as settling the question, before and after the scan. Test added.
- **A stopped client could report `synced`.** An apply still finishing when the refusal landed ran `setStatus('synced')` afterwards, leaving a closed socket showing as synced for good. `handleChanges` no longer overrides a lasting stop. This also covers the existing fatal-error stop. Test added.

**Fixed in this pass (minor, no test):**

- `stopWithError` now drops the local-change listener. Apps are told to replace a refused client with a new one, which would otherwise leave the old client listening on the shared `syncEvents` emitter. Shared with `disconnect()` as `stopWatchingLocalChanges`.
- `holdsUnrecordedRow` resolved the key's normalizers before scanning, so a table with no rows could fail the check over a key it never needed. Now resolved only when a suspect row exists.
- `docs/sync.md` and a client comment said a refused device "has sent nothing". The handshake's ordinary first push has already gone by the time `snapshot_required` arrives. Reworded, and the new transfer rule was added to the same bullet.
- Test helper `refuseSnapshot` was misnamed, since it only sends `snapshot_required`, and one user of it expects no refusal. Renamed `sendSnapshotRequired`.
- Added the new default to the git-ignored `.release-notes.pending.md`, as the handoff suggested, because it changes behaviour for existing apps.
- Updated the stale line count in the size `NOTE` in `sync-client.ts`, measured at 1445 with `wc -l`.
- Copied the adoption constraints into `sync-unrecorded-rows-adopt`, since its implementer would not otherwise see them, and added the running-transfer rule.

**Handoff gap closed by a throwaway spec (not kept).** Against a real coordinator and real engine, the default refused, kept the row and did not reconnect. A new client with `'replace'` then took the snapshot, and `connect()` followed by `requestSnapshot()` under the default did a full replace. The refusal path's parts already have kept tests, so an end-to-end spec would add run time without pinning anything new.

**Checked for false refusals, none found (throwaway spec, not kept).** No table was reported after: primary-key-only, composite, singleton, `nocase`, blob and real keys, each sent through both relay and snapshot; add, rename and drop column; rename table; alter primary key; key update; delete and reinsert; `insert or replace`; and a drop column that leaves only the key.

**Checked by reading, no defect:**

- The checkpoint reorder: `clearExistingMetadata` touches no `sc:` keys, and a resume re-clears. A crash before the clear only causes a redundant resume.
- `trackApply` does not grow a chain, and adds a rejection handler to the `void` drain call.
- `holdsUnrecordedRow` ends: each extra loop needs a new writer. A generator returning early closes the scan and releases the mutex.
- Logical tables are never registered in `getAllTables`, so they are not scanned.
- `stopWithError` is safe on an already closed socket, and a second scan's verdict finds the socket gone and returns silently.
- Other `SyncManager` and `SyncContext` implementers: only the client spec's mock, which was updated. `typecheck` confirms.

**Tests.** None cut. The implementer's extras each pin a named rule on real branching. Two added, for the two defects above.

**Tripwires (parked as `NOTE:` at the site, none filed):**

- A fully recorded table blocks writers during its scan. `unrecorded-rows.ts`, from implement. Cost not measured.
- An open explicit transaction can cause a false refusal. `unrecorded-rows.ts`, from implement. Inferred from routing code, not run.
- Custom modules refuse, now noted to include engine-managed tables such as Lamina's lens basis tables. `unrecorded-rows.ts`. Lamina is not in this repo, so this is untested.
- `sync-client.ts` is approaching the size where its `NOTE` says to extract the snapshot section. No ticket: the note already names the seam.

**Remaining gaps, no ticket:**

- **Quoomb Web was not run.** Until `sync-unrecorded-rows-adopt` lands, its store-to-sync path gets the refusal when the database already has rows. By reading, its worker forwards `onError` and status to the event history. That ticket sets the option and already asks for a browser check.
- **The deleted-during-scan case is untested.** It needs a module with committed reads that is not `memory`, and none exists in the repo.
- **A scan that throws while a transfer has just started** still closes the socket, which ends that transfer and resumes it on reconnect. It needs a scan failure in the same moment as an explicit request, and recovery is the normal resume path, so it was left.

**Empty categories.** Security: no new input surface; table names in the error come from the local schema. Resource cleanup: covered above, with nothing further found.

## For `sync-unrecorded-rows-adopt`

The constraints are now in that ticket under "Constraints from the prereq's review". `tablesToCheck` is private to `unrecorded-rows.ts`, where the ticket says adoption goes.
