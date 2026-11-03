description: Add a client option that keeps data a device held before sync was turned on, by recording those rows as ordinary local changes so they reach the server and every other device. Quoomb Web turns it on, since someone switching from "store" to "sync" almost certainly wants to keep their data.
prereq: sync-unrecorded-rows-refuse, sync-push-drains-all-local-changes
architecture: docs/sync.md#snapshots-replace-rows
files:
  - packages/quereus-sync/src/sync/unrecorded-rows.ts # the scan from the prereq; adoption is added here
  - packages/quereus-sync/src/sync/manager.ts
  - packages/quereus-sync/src/sync/sync-manager-impl.ts # handleTransactionCommit, commitChain
  - packages/quereus-sync-client/src/sync-client.ts # maybeBootstrap, handleSnapshotRequired, isReplicaEmpty NOTE
  - packages/quereus-sync-client/src/types.ts
  - packages/quereus-sync-client/test/sync-client.spec.ts
  - packages/quoomb-web/src/worker/quereus.worker.ts # connectSync sets the option
  - packages/sync-coordinator/test/sync-coordinator-roundtrip.e2e.spec.ts # reference for two real peers and a real coordinator
  - packages/quereus-sync-client/README.md
  - docs/sync.md
  - docs/sync-protocol.md
----

## Background

`sync-unrecorded-rows-refuse` adds the `unrecordedRows` option with `'refuse'` and `'replace'`. This ticket adds the third value:

| Value | What happens to rows sync has never recorded |
|---|---|
| `'adopt'` | The rows are recorded as local changes on first attach, then pushed and merged by last-writer-wins. Scans each table once. |

## Adoption must carry the schema as well as the rows

A table created before sync attached has no `create_table` migration either. The coordinator is relay-only: it stores whatever cells it is sent, with no table definition to check them against. If adoption pushed cells alone:

- another device would quarantine them as changes for an unknown table, and
- a brand-new device taking a snapshot would fail outright, because a section with cells for a table it does not have aborts the apply (docs/sync.md § Unknown-Table Disposition). One device's adoption would stop all new devices from bootstrapping.

So adoption also records migrations:

- A `create_table` migration, for an adopted table with no migration of its own (`ctx.schemaMigrations.getCurrentVersion(schema, 'table', name) === 0`), with DDL from `generateTableDDL(table)`, the call `StoreModule` uses for its own create event (`store-module.ts`, the `ddl:` near line 426).
- A `create_index` migration for each of that table's indexes with none, using `generateIndexDDL`.

Only tables that actually have unrecorded rows get migrations. A device with an empty pre-attach table sends nothing, which keeps a device with no unrecorded rows exactly as it is today. A foreign key may name a table that was not sent: `create table` accepts a parent that does not exist yet (`schema/manager.ts` resolves parents at enforcement time), so this does not fail on the receiver. Views and assertions created before sync attached are not adopted. Say so in the docs.

## Manager API

```ts
// SyncManager
/**
 * Record every unrecorded row as a local change, along with any schema migration
 * its table lacks. Idempotent: a row that has a record is skipped, so an interrupted
 * run is finished by calling this again. Returns what was recorded. On a peer with
 * no engine it does nothing and logs a warning.
 */
adoptUnrecordedRows(): Promise<{ tables: Array<{ schema: string; table: string }>; rows: number }>;
```

## Recording

Reuse local capture rather than writing a second recorder. Split `handleTransactionCommit` into the body that does the work and throws (for example `recordCommitBatch`) and a wrapper that keeps today's catch, telemetry and identity reload. Adoption calls the throwing body with synthetic batches, and a failure rejects `adoptUnrecordedRows`. This keeps HLC assignment, migrations before data, identity minting, the change log, `emitLocalChange` and the `opSeq` rules in one place.

- Run the whole adoption as one entry on `commitChain`, so it is ordered with local capture and cannot race a queued commit's records. Chain the rejection back to the caller without breaking the chain: the chain itself must stay usable, as `enqueueTransactionCommit`'s guard ensures today.
- Reuse the prereq's table filter. For each table, scan all columns under positional aliases in `columns` order, because `recordColumnVersions` maps by index. A row with any record is skipped.
- Each batch of up to `DATA_FLUSH_SIZE` unrecorded rows is one synthetic `TransactionCommitBatch` of `insert` events with no `remote` flag and no `oldRow`. The table's schema events go in its first batch. Buffer rows and flush as the scan goes, rather than holding a whole table in memory. Writes go to the sync KV store and not to the table, so writing under the open scan is safe, and `scanLiveRows` already reads the table from inside the chain.

## Client flow

`'adopt'` joins the option. In the constructor, throw if `readOnly` and `unrecordedRows === 'adopt'`: a read-only client can never push, so adopted rows would never leave the device and the next snapshot would delete them. That is a contradiction in the app's own configuration, so fail early.

- **Handshake.** In `maybeBootstrap`, after the checkpoint branch and before the empty check: under `'adopt'`, when there is no peer sync state and no peer sent state for this server, call `adoptUnrecordedRows`. Peer sent state is written on the first ack, so this is the "once": later reconnects skip it. A device whose first connect found nothing to send has nothing to push and rescans cheaply, because it holds no unrecorded rows.
- **Adoption runs even with `bootstrapOnEmpty: false`**, and on a device with both recorded and unrecorded rows. It is about these rows, not about bootstrapping.
- **After adopting rows, skip `isReplicaEmpty`.** The device is plainly not empty, and that probe materializes every local change set (see its NOTE, whose condition this ticket trips, so update the NOTE). When adoption found nothing, the flow continues as it does now.
- **`snapshot_required`.** Under `'adopt'`, the guard from the prereq adopts instead of checking, whatever the peer state, then the prereq's drain pushes everything and waits for the acks, and only then does the snapshot run. The adopted rows are on the server by then, so they come back in the snapshot.
- **Adoption fails.** Same as a check failure in the prereq: never continue to the snapshot, emit the error, call `onError`, and close with handlers attached so the reconnect retries. Rows adopted so far are recorded, and the retry skips them.
- **Pending checkpoint.** Never adopt while one exists. The data is partial and its metadata is cleared, so every row would look unrecorded and be stamped as new. The prereq's guard already handles this; make sure adoption sits behind it.

Emit one `state-change` sync event with the row and table counts when any were adopted.

## Constraints from the prereq's review

- Adoption runs on the commit chain, so it must not call `findTablesWithUnrecordedRows`, `whenCommitsSettled` or `whenAppliesSettled` from inside its chain entry. It would wait on itself, and an apply in flight waits on the chain too.
- `unrecordedRowsAllowSnapshot` in the client returns true while a snapshot transfer is running, so `await connect(); await requestSnapshot()` is not stopped by a scan already under way. Adoption must make the same exception: a transfer that has started clears the metadata, so every row would look unrecorded and be stamped as new.

## Quoomb Web

`connectSync` in `quereus.worker.ts` passes `unrecordedRows: 'adopt'`.

## Tradeoffs decided here

- **Adopted rows win against older server edits.** They have no real timestamp, so they get the time of adoption. A row with the same key on the server, edited before that moment, loses. This is what the maintainer's decision describes ("merged by last-writer-wins"), and it can't be undone once pushed. Say so plainly in the docs and the option's doc comment.
- **Two devices adopting the same seeded data** both push every row. They converge, at the cost of the duplicate traffic.
- **A row the server deleted and pruned comes back** if a device still holds it unrecorded. Nothing on the device can tell it was ever deleted.
- **Rows a server hook rejects** stay recorded locally and are reported through the `rejected` event, like any local write. A later `snapshot_required` deletes them, as it does any local write the server refused.

## Edge cases & interactions

- **A local commit during adoption.** It queues behind the adoption's chain entry and overwrites with a newer HLC. Check by inspection.
- **A broadcast (`push_changes`) during adoption.** `applyChanges` waits on `whenCommitsSettled` at its start, so one that arrives while adoption runs waits behind it. Check by inspection that it does not deadlock: adoption must not wait on anything that needs that apply.
- **A live row with a tombstone** (deleted under sync, recreated while detached): adoption's newer HLC beats the tombstone, as a local reinsert does. Check by inspection.
- **Crash mid-adoption.** Finished batches committed, and peer states are still unset, so the next connect rescans and skips them. Check by inspection.
- **Socket drop between adoption and the first ack.** Same as above. The rows are ordinary unsent local changes now. Check by inspection.
- **Connecting to a second server for the first time.** No peer state for that server, so it rescans and finds nothing new, unless rows were written while detached. Check by inspection.
- **Large tables.** The prereq's drain sends them across multiple batches. The first push still goes through `collectAllChanges`, which reads every local change into memory. Leave a `NOTE:` at the adoption call site: this is now reachable on a populated device, and if it shows up, make the unbounded scan bounded.
- **The `opSeq` range.** Each synthetic batch has its own tick, so `DATA_FLUSH_SIZE` rows cannot approach the limit. Check by inspection.

## Tests

- End to end, in the shape of `sync-coordinator-roundtrip.e2e.spec.ts` (real engine, real coordinator): peer A holds a table and rows from before sync attached and connects with `'adopt'`; a brand-new peer B with no schema bootstraps and ends up with the table and the rows. This pins the schema half, which would otherwise fail on B only. Also assert A's rows survive.
- `packages/quereus-sync/test/sync/`: calling `adoptUnrecordedRows` twice records rows the first time and returns zero the second, leaving the change log unchanged.
- `packages/quereus-sync-client/test/sync-client.spec.ts`, using `MockSyncManager`: on `snapshot_required` under `'adopt'`, adoption happens before the first `apply_changes`, and `get_snapshot` comes after the ack.

## TODO

- Split `handleTransactionCommit` and add `adoptUnrecordedRows` with its migrations.
- Add `'adopt'` to the type, the constructor check, and the client flow above.
- Set the option in Quoomb Web, and try the "store" then "sync" path in a browser if one is available. Say in the handoff whether this was done.
- Add the tests above.
- Docs: add `'adopt'` to the table in `docs/sync.md` § Snapshots replace rows, with the schema rule and the tradeoffs above. Add it to `docs/sync-protocol.md`, the `SyncManager` interface listing there, the client README's options block, and the option's doc comment.
- Run `yarn workspace @quereus/sync test`, `yarn workspace @quereus/sync-client test`, `yarn workspace @quereus/sync-coordinator test`, and `yarn build`.
