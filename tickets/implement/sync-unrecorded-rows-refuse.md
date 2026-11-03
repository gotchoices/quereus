description: A device that already holds data when sync is turned on can silently lose it on first connect, because the server's copy replaces what the device has. Add a client option for what happens to those rows, and by default stop with a clear error instead of deleting anything.
architecture: docs/sync.md#snapshots-replace-rows
files:
  - packages/quereus-sync/src/sync/unrecorded-rows.ts # new: the read-only check
  - packages/quereus-sync/src/sync/manager.ts # SyncManager interface
  - packages/quereus-sync/src/sync/sync-manager-impl.ts
  - packages/quereus-sync/src/sync/snapshot-stream.ts # checkpoint save order in the header case
  - packages/quereus-sync/src/sync/snapshot-coverage.ts # reference: collectAbsentKeys is the scan pattern
  - packages/quereus-sync-client/src/sync-client.ts # maybeBootstrap, handleSnapshotRequired, isReplicaEmpty comment
  - packages/quereus-sync-client/src/types.ts # option beside bootstrapOnEmpty
  - packages/quereus-sync-client/src/index.ts # export the error and the option type
  - packages/quereus-sync-client/test/sync-client.spec.ts # MockSyncManager gains the new method
  - packages/quereus-sync-client/README.md
  - docs/sync.md
  - docs/sync-protocol.md
----

## Background

Sync keeps a record (a `cv:` cell record) of each cell it knows about. Rows written before sync attached have none, so no sync path can see them. A snapshot makes each table it covers hold exactly the server's rows, so it deletes those rows without any error. `bootstrapOnEmpty` is on by default and treats a device holding only such rows as new, so the default settings can destroy user data.

The maintainer decided (2026-11-02) that what happens to these rows is a client option, and that the default never deletes them. This ticket adds the option with `'refuse'` and `'replace'`. `sync-unrecorded-rows-adopt` adds `'adopt'` and sets it in Quoomb Web.

## Behaviour

New `SyncClientOptions.unrecordedRows`, type `UnrecordedRowsPolicy`:

| Value | What happens to rows sync has never recorded |
|---|---|
| `'refuse'` (**default**) | An automatic snapshot stops before deleting anything. The error names the affected tables and this option. |
| `'replace'` | The snapshot deletes them, which is today's behaviour, now only when the app asks. |

- **Automatic snapshots are the ones the check guards**: the `bootstrapOnEmpty` bootstrap in `maybeBootstrap`, and `handleSnapshotRequired`.
- **An explicit `requestSnapshot()` stays a full replace** with no check, because the caller asked for it.
- **Resuming an interrupted transfer is not checked.** The header's clear already wiped the metadata, so every row would look unrecorded. The decision was made when the transfer started. The resume branch in `maybeBootstrap` runs first, so this holds by construction. `handleSnapshotRequired` must also skip the check when `listSnapshotCheckpoints` is non-empty, since a false refusal there would strand a partial database.
- **A device with no unrecorded rows behaves exactly as it does now**, and the check writes nothing.

## Interfaces

```ts
// @quereus/sync, SyncManager
/** Tables holding at least one live row with no sync record. Read-only. Empty on a peer with no engine. */
findTablesWithUnrecordedRows(): Promise<Array<{ schema: string; table: string }>>;

// @quereus/sync-client
export type UnrecordedRowsPolicy = 'refuse' | 'replace';
export class UnrecordedRowsError extends Error {
  readonly tables: ReadonlyArray<{ schema: string; table: string }>;
}
```

## The check (`unrecorded-rows.ts`)

1. `await ctx.whenCommitsSettled()`. A row committed a moment ago may not be recorded yet.
2. Walk every table in `db.schemaManager._getAllSchemas()`, keeping those that:
   - are in the basis (`ctx.isTableInBasis`),
   - are not materialized views (`ctx.isMaterializedView`; their rows are derived and never carry cells),
   - are not `vtabModuleName === 'memory'` (case-insensitive). A memory table has no external write path, so a snapshot can never delete from it (see the NOTE on `removeRowsAbsentFromSnapshot`). Exclude by this name rather than including only store modules, so that a wrapped or renamed store module is still checked. A wrong guess then costs a refusal, not lost data.
3. For each table, scan its keys the way `collectAbsentKeys` does (positional aliases, `readConcurrency: 'committed'`, a constant stand-in for a singleton table). A row is unrecorded when `ctx.columnVersions.getRowVersions(schema, table, pk)` is empty. Local capture records every column of an inserted row, so any recorded row has at least one cell.
4. Stop scanning a table at its first unrecorded row. Only the table name is needed.
5. Before reporting a table, `await ctx.whenCommitsSettled()` and re-read that row's versions. A row committed during the scan has its recording queued behind the scan, and a false refusal stops sync. Move on through the table if the row turned out to be recorded.

With no `ctx.db`, return `[]`: `removeRowsAbsentFromSnapshot` cannot delete on such a peer either, so nothing is at risk.

`getRowVersions` resolves the generation with `generationOf` and does not mint one, so a table with no `tg:` record reads as "no records" and nothing is written. Keep it that way.

## What refusing does

A guard in the client, for example `private async unrecordedRowsAllowSnapshot(): Promise<boolean>`, runs ahead of both automatic paths. Under `'replace'` it returns true without scanning. In `maybeBootstrap` it runs after `isReplicaEmpty()` is true, so a device that is not bootstrapping never scans. In `handleSnapshotRequired` it runs before the push, so a refused device has not sent anything on the way to a stop.

When tables are found, stop the same way the protocol version mismatch in `handleHandshakeAck` does: set `stopReconnect`, set status `error`, emit an `error` sync event, call `onError` with an `UnrecordedRowsError`, detach the socket's handlers and close it. Factor that shutdown out of `handleHandshakeAck` rather than copying it. The handshake has already resolved `connect()` by this point, so apps learn of this through `onError` and the status, on both paths.

The message names each table and the option, for example: `Sync stopped to protect local data: main.notes, main.tags hold rows sync has never recorded, and a snapshot from the server would delete them. Set the unrecordedRows client option to choose what happens to them.`

The app chooses by creating a new `SyncClient` with a different option and connecting. The `SyncManager` and its data carry over. Say this in the option's doc comment.

If the check itself throws (for example an unknown collation while computing a key), never continue to the snapshot. Emit the error, call `onError`, and close the socket with handlers attached so the reconnect retries, the same way `executeSnapshotTransfer`'s failure path does.

## Crash window to close

In the `'header'` case of `snapshot-stream.ts`, `clearExistingMetadata` commits before `saveSnapshotCheckpoint`. A crash between them leaves all rows without records and no checkpoint, so the next `snapshot_required` would falsely report every table as unrecorded. Under `'adopt'` it would be worse: every row would be stamped as a new local change and beat newer server edits. Move `saveSnapshotCheckpoint` ahead of `clearExistingMetadata`, keeping `completedTables` seeded first. A crash between them then leaves a checkpoint over intact metadata, and the resume re-clears. Update the comment there, which currently explains the order the other way round.

## Tradeoffs decided here

- **The check is broader than what the snapshot will really delete.** A table the server does not have is left alone by a snapshot, but the client cannot know the server's tables until the stream starts, and by then the header has cleared the metadata the check needs. So a table only this device has, with unrecorded rows, also refuses. The error names it and the app can choose. Asking the server first would need a protocol change for a rare case.
- **Only never-recorded rows count.** An update made while sync was detached to a row that has records is still a silent divergence, and is not detected. A row with any cell record counts as recorded.
- **A custom virtual table module with rows also refuses**, by the same exclude-by-name rule. Leave a `NOTE:` at the filter: if a local-only module becomes common, let tables opt out rather than widening the name check.

## Edge cases & interactions

- **`bootstrapOnEmpty: false`.** No bootstrap, so the check only runs on `snapshot_required`. Check by inspection.
- **`readOnly` client.** The same check applies. Check by inspection.
- **Device with both recorded and unrecorded rows on first connect.** `isReplicaEmpty` is false, so there is no snapshot and no check. The rows stay invisible but safe until a `snapshot_required`. Check by inspection.
- **A table with no `tg:` record** (created before sync attached): all its rows are unrecorded, and nothing gets minted. Covered by the first test below.
- **Singleton table (`primary key ()`).** Key is `[]`, as in `collectAbsentKeys`. Check by inspection.
- **Collated keys.** `getRowVersions` derives identity through the same keying as local capture, so a `nocase` key matches its records. Check by inspection.
- **Refusal during auto-reconnect.** `stopReconnect` holds until the next explicit `connect()`, which clears it and re-runs the check. A device that is still refused gets the error again, with no retry loop. Check by inspection.
- **A broadcast (`push_changes`) arriving during the scan.** It adds records, and the re-read in step 5 sees them. Check by inspection.
- **A coordinator's `applySnapshotStream` call** is untouched. The guard lives in the client because "automatic" is a client idea.

## Tests

- `packages/quereus-sync/test/sync/`, with a real engine and store module: create and fill a table before `createSyncModule`, write another table after it, and add a `using memory` table with rows and a materialized view. `findTablesWithUnrecordedRows` names only the first table, and the KV store's contents are unchanged afterwards.
- `packages/quereus-sync-client/test/sync-client.spec.ts`, using `MockSyncManager` (which gains the method, returning a settable list):
  - bootstrap with unrecorded tables under the default: no `get_snapshot` is sent, `onError` receives an `UnrecordedRowsError` naming them, and no reconnect is scheduled;
  - `snapshot_required` under the default with unrecorded tables: no `apply_changes` or `get_snapshot` is sent;
  - `'replace'` sends `get_snapshot` without calling the check;
  - explicit `requestSnapshot()` sends `get_snapshot` without calling the check.

Existing specs should pass unchanged, since an empty list means today's flow. If the `sync-coordinator` round-trip spec fails, its peers have rows with no records. Look at why rather than switching it to `'replace'`.

## TODO

- Add `findTablesWithUnrecordedRows` to the interface, `unrecorded-rows.ts`, and the implementation.
- Reorder the checkpoint save in the snapshot header case.
- Add the option, the error, the guard and the shared shutdown helper to the client, and export the new types.
- Add the tests above, updating `MockSyncManager`.
- Docs: `docs/sync.md` § Snapshots replace rows (replace the "Rows with no sync metadata are deleted too" bullet, add the option table and the rule above), `docs/sync-protocol.md` (the sync client contract, wherever it describes bootstrap or recovery), the client README (the options block, and the `bootstrapOnEmpty` line that warns of this loss), the `bootstrapOnEmpty` doc comment in `types.ts`, and the `isReplicaEmpty` and `requestSnapshot` comments in `sync-client.ts`.
- Run `yarn workspace @quereus/sync test`, `yarn workspace @quereus/sync-client test`, `yarn workspace @quereus/sync-coordinator test`, and `yarn build`.
