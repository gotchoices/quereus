description: A device that already holds data when sync is turned on can silently lose it on first connect, because the server's copy replaces what the device has. There is now a client option for what happens to those rows, and by default sync stops with a clear error instead of deleting anything.
architecture: docs/sync.md#snapshots-replace-rows
files:
  - packages/quereus-sync/src/sync/unrecorded-rows.ts # new: the read-only check
  - packages/quereus-sync/src/sync/manager.ts # SyncManager interface
  - packages/quereus-sync/src/sync/sync-manager-impl.ts # delegation, trackApply, whenAppliesSettled
  - packages/quereus-sync/src/sync/sync-context.ts # whenAppliesSettled
  - packages/quereus-sync/src/sync/snapshot-stream.ts # checkpoint saved before the header's clear
  - packages/quereus-sync/src/sync/snapshot-coverage.ts # scanLiveKeys extracted from collectAbsentKeys
  - packages/quereus/src/schema/manager.ts # _getAllSchemas moved onto the published types
  - packages/quereus-sync-client/src/sync-client.ts # unrecordedRowsAllowSnapshot, stopWithError, failAndRetry
  - packages/quereus-sync-client/src/types.ts # option and error
  - packages/quereus-sync-client/src/index.ts
  - packages/quereus-sync/test/sync/unrecorded-rows.spec.ts # new
  - packages/quereus-sync-client/test/sync-client.spec.ts
  - packages/quereus-sync-client/README.md
  - docs/sync.md
  - docs/sync-protocol.md
----

## What was built

`SyncClientOptions.unrecordedRows` is `'refuse'` (default) or `'replace'`. It governs rows sync has never recorded, usually rows written before sync attached.

- **Under `'refuse'`**, an automatic snapshot (the `bootstrapOnEmpty` bootstrap, or `snapshot_required` recovery) stops before deleting anything. The client calls `onError` with an `UnrecordedRowsError` naming the tables and the option, moves to status `error`, closes the socket and does not reconnect until the next explicit `connect()`, which checks again.
- **Under `'replace'`**, the snapshot deletes them, with no scan.
- **Never checked**: an explicit `requestSnapshot()`, and any snapshot while a checkpoint is pending, because that transfer's header already cleared the metadata and every row would look unrecorded.
- **A scan that throws** is not a refusal: no snapshot follows, and the client retries through the normal reconnect.

The header of a snapshot apply now saves its checkpoint before clearing metadata, so a crash between the two leaves a checkpoint over intact metadata rather than rows that merely look unrecorded.

## To try it

Create and fill a table on a store-backed database, then attach sync and connect to a server with the default options. `connect()` resolves, then `onError` fires with an `UnrecordedRowsError` and no `get_snapshot` is sent. A new `SyncClient` over the same `SyncManager` with `unrecordedRows: 'replace'` takes the snapshot.

## Departures from the ticket, for the reviewer to weigh

- **Two scans replace the re-read in step 5.** A table is reported only when two scans, with in-flight writes settled between them, name the same row. Waiting inside a scan can deadlock: the store module declares `readCommittedSnapshot = false`, so its "committed" read falls back to the serialized path and holds the execution mutex until the scan closes, and an apply or a re-key on the commit chain needs that mutex. A plain re-read also misreports a row deleted during a committed-read scan, which the second scan does not.
- **Added `SyncContext.whenAppliesSettled`.** The ticket's edge case says a broadcast during the scan "adds records, and the re-read sees them". It does not always: `applyChanges` writes rows first and their records afterwards, so a read can land in that gap. `SyncManagerImpl` now tracks in-flight applies and drains, and the check waits on them.
- **`_getAllSchemas` lost its `@internal` tag.** `stripInternal` removes it from the published types, so `@quereus/sync` could not compile against it. Its doc comment follows the `_isExecuting` precedent. The alternative is a differently named public method.
- **The check also returns `[]` with no `applyToStore`**, not just with no `db`, matching the conditions under which `removeRowsAbsentFromSnapshot` deletes nothing.
- **`stopWithError` does more than the code it replaced.** It also cancels a pending reconnect timer, whose `connect()` would clear `stopReconnect`, and releases any parked transfer or ack waiters, since detaching `onclose` removes what would otherwise release them. The protocol mismatch path now gets this too.
- **A verdict for a replaced socket is dropped silently.** If a reconnect or `disconnect()` replaces the socket during the scan, the guard returns false and reports nothing. The new socket's handshake decides for itself.

## Tests

In `packages/quereus-sync/test/sync/unrecorded-rows.spec.ts`:

- Names only a table filled before attach, not one written after, a pre-attach `memory` table, or a store-backed materialized view, and leaves the KV store byte-identical. Also covers a table with no `tg:` record.
- A row whose local commit is still being recorded is not reported.
- A row a remote apply has written but not yet recorded is not reported.
- A row committed after the check began, while an earlier table was being scanned, is not reported. This pins the second scan.
- A crash during the header's clear leaves a checkpoint, and the resume finishes. This reproduces the crash window.

In `packages/quereus-sync-client/test/sync-client.spec.ts`:

- Bootstrap refuses: no `get_snapshot`, the error names the tables and option, status `error`, no reconnect.
- `snapshot_required` refuses before any `apply_changes` or `get_snapshot`.
- `snapshot_required` skips the scan while a checkpoint is pending.
- A failed scan takes no snapshot and retries through the reconnect.
- `'replace'` takes the snapshot without scanning.
- An explicit `requestSnapshot()` takes the snapshot without scanning.

Beyond the ticket's list are the three "only look unrecorded" tests' extra cases, the crash test, the checkpoint skip and the failed scan. Each pins a named rule on real branching, so cut any you disagree with.

## Validation

- `yarn build` passes. `@quereus/sync` 793, `@quereus/sync-client` 96 and `@quereus/sync-coordinator` 135 all pass. The coordinator round-trip spec passed unchanged, on the default option, so its peers hold no unrecorded rows.
- Each safeguard was temporarily broken to confirm a test fails: both waits, the second scan, the wait between scans, both table filters, the checkpoint order, both client guards, the checkpoint skip, the failed-scan path and `'replace'`. This caught a local-commit test that passed with no wait at all and a memory-table case that exercised nothing; both were rewritten.
- Singleton and `nocase` keys were run once, recorded and unrecorded, in a throwaway spec that was not kept.
- Checked by reading only: `bootstrapOnEmpty: false`, `readOnly`, a device with both recorded and unrecorded rows on first connect, and a refusal during auto-reconnect.

## Known gaps

- **Nothing runs a refusal against a real coordinator.** The refusal tests use `MockSyncManager` and the check tests use real engines with no client. The round-trip spec shows only that a normal path does not falsely refuse.
- **Quoomb Web is not checked.** Until `sync-unrecorded-rows-adopt` lands, its store-to-sync path gets the refusal when the database already has rows. Its worker forwards status and sync events, but this was not run in a browser.
- **An open explicit transaction can cause a false refusal.** Its uncommitted rows have no records yet, so they would look unrecorded. Inferred from the routing code, not run. Parked as a `NOTE:` in `unrecorded-rows.ts`.
- **A fully recorded table blocks writers during its scan.** On the store module it takes one `cv:` range read per row under the execution mutex. Cost not measured. Parked as a `NOTE:` with the alternative.
- **The deleted-during-scan case is untested.** It needs a module with committed reads that is not `memory`, and none exists in the repo.
- **No release note was added.** The new default changes behaviour for existing apps, so it is a candidate for the untracked `.release-notes.pending.md`.

## For `sync-unrecorded-rows-adopt`

Adoption runs on the commit chain, so it must not call `findTablesWithUnrecordedRows` or either settle wait from inside its chain entry. It would wait on itself, and an apply in flight waits on the chain too. `tablesToCheck` is private to `unrecorded-rows.ts`, where the ticket says adoption goes.
