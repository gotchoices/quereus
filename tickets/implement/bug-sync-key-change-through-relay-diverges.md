description: When a device changes a table's primary key and syncs through a server that has no database engine, devices end up with different data: the writer can lose its own edit, or lose whole rows. The server should move its records to the new key, and the device should finish uploading before it downloads.
architecture: docs/sync.md#tombstones-and-deletions
files:
  - packages/quereus-sync/src/sync/rekey-on-pk-change.ts # the re-filing pass; needs a variant that works from stored records with no table to read
  - packages/quereus-sync/src/sync/change-applicator.ts # rekeyAfterReplicatedKeyChange (reaches the "not captured" warning on a relay); tablesWithRecordsElsewhere, keyWasEverRedefined (exemption to narrow)
  - packages/quereus-sync/src/sync/sync-manager-impl.ts # recordSchemaMigration: record the column list on a key-change migration
  - packages/quereus-sync/src/sync/protocol.ts # SchemaMigration: new optional field
  - packages/quereus-sync/src/sync/wire.ts # serializeSchemaMigration / deserializeSchemaMigration
  - packages/quereus-sync/src/metadata/schema-migration.ts # stored form of a migration (byte layout)
  - packages/quereus/src/vtab/alter-event-shape.ts # the engine event that names the retired key; can also name the columns
  - packages/quereus-sync-client/src/sync-client.ts # handleHandshakeAck: pull is requested before the push; pushUntilDrained already exists
  - packages/quereus-sync-client/test/sync-client.spec.ts # the mock test near line 1873 expects get_changes with no ack
  - packages/sync-coordinator/test/sync-coordinator-roundtrip.e2e.spec.ts # home of the reproduction
  - packages/quereus-sync/test/sync/edit-of-forgotten-row.spec.ts # tests pinning the exemption being narrowed
  - docs/sync.md # "What a key redefinition does not cover", and the exemption bullet
  - docs/sync-protocol.md # client state machine, SYNCING step
difficulty: hard
repro: verified
----

## What happens

A relay is a server with sync records but no database engine: it has no table to read and no catalog. The standard coordinator runs this way. Reproduced with real clients and a real coordinator:

1. Devices A and B both hold rows 1 and 2 of `orders (id integer primary key, note text, qty integer)`.
2. B disconnects, runs `alter table orders alter primary key (id, qty)`, then `update orders set note = 'edited after key change' where id = 1`.
3. B reconnects.

| Server state | A | B |
|---|---|---|
| Has not pruned | Rows 1 and 2, row 1 edited | Rows 1 and 2, row 1 back to `note = 'one'` |
| Has pruned, so B takes a snapshot | Rows 1 and 2, row 1 edited | Row 1 only, edited |

The server ends with cells for `[1]`, `[2]` and a separate `[1,1]` holding only the edited `note`.

## Causes

There are two independent causes. Each was confirmed by prototyping its fix; neither fix alone was enough in the no-prune case. The prototypes were removed, so nothing described here is in the tree.

**1. The relay does not re-file its records.** In `rekeyAfterReplicatedKeyChange`, a relay has no catalog, so `captureRetiredKeyColumns` finds no retired key and the code logs "the key it retired was not captured" and moves on. That warning's reason (created or renamed by the same batch) is wrong on a relay. Old-key records then reach devices that have already moved to the new key, which cannot address them. The snapshot case loses row 2 because the receiver keeps only rows whose identity appears in the snapshot, and `[2]` is not the identity of `[2,2]`.

**2. The device downloads before it uploads.** `handleHandshakeAck` sends `get_changes` and only then pushes. The coordinator handles socket messages concurrently (`socket.on('message', async …)` in `packages/sync-coordinator/src/server/websocket.ts`), and in 3 of 3 runs with only cause 1 fixed, B's reply was still built from the old-key records. The server's final state was correct, yet B still lost its edit. B receives history it already has because a broadcast deliberately does not advance the received watermark, so a reconnect routinely re-downloads old records. This is not specific to relays: nothing in the path is relay-specific once the reply holds old-key records.

A receiver cannot defend itself. A same-length key change such as `(a)` to `(b)` looks valid under both definitions, and looking up an already-seen timestamp fails in exactly this scenario, because B's newer edit already replaced the old `note` record.

## The fix

**Re-file from stored records on a relay.** Every cell record holds its column name and value, so a row's new key can be read from its own cells, using the column list in the statement's `alter primary key (…)`. The old identity comes from the record's key, so the relay does not need to know the old key. Identities on a relay are always raw (`RAW_PK_KEYING`). `scanLiveRows` produces two maps, `newPkByOld` and `oldByNew`, that `rekeyCellVersions` and `rekeyTombstones` consume. The relay variant builds the same maps from a scan of the `cv:` records, so those two functions can be shared. `RekeyPlan.db` then belongs to the table scan rather than the plan.

Rules for the relay variant, each from something observed or reasoned through:

- **Match column names case-insensitively**, because a statement can spell a column differently from the cells.
- **Scan once.** The prototype scanned twice, once for the maps and once to move records. Two pushes of the same key change ran at once, the second pass's scans straddled the first pass's write, and it deleted every re-filed row, leaving only `[1,1].note`. The maps must come from the same records the move acts on.
- **A row group missing a new-key cell stays where it is, counted and warned about.** Do not reuse the "row no longer exists, drop it" branch: on a relay a missing cell does not mean a deleted row, and deleting is irreversible while the relay may hold the only copy. This also protects a group already under the new key that holds only some cells. Add a count to `RekeyCounts` / `PrimaryKeyRekeyedEvent` and extend `reportRekeyOutcome`, which currently warns only on dropped tombstones.
- **A re-filed cell must not overwrite a newer record at its target,** so compare timestamps and remove the loser's change-log entry. Two old groups can land on one new identity, because the relay's rows are not checked for uniqueness, and a duplicate apply can run alongside the first. Keep the deferred puts, which make key swaps safe.
- **Keep the `applyChanges` concurrency as it is, with a `NOTE:` at the pass:** nothing serializes applies on a manager, so a different device's push can interleave with the pass. If that ever shows up beyond duplicate pushes, serialize applies per manager. Writes around a key change are already documented as needing to be quiesced.

**Carry the column layout on the key-change migration, for tombstones.** A delete's before-image, `Tombstone.priorRow`, does reach the relay (seen as `[3,"three",3]`), but it is positional and the relay does not know the column order. Without the order it cannot compute the new key. The existing rule for an unusable before-image then drops the tombstone. Add an optional field to `SchemaMigration` listing the table's columns in order, set only on an `alter primary key` migration, and carry it through `wire.ts` and `schema-migration.ts` as `fromTable` is. Take the list from the engine's event (`alter-event-shape.ts` has the pre-change schema) rather than the catalog, which can have moved on by the time the capture runs. Keep the existing length check in `projectKeyFromImage`, which rejects an image from another layout. An additive optional field needs no `PROTOCOL_VERSION` bump; no compatibility with older clients is needed.

This arm matters because of this case, which also fails on the current code: C goes offline holding row 3, A deletes row 3, B changes the key, C reconnects. C keeps row 3 while A and B do not. Today's relay still ships the delete as `[3]`, and C has no row at that address once it has re-keyed. **This arm was not prototyped**: the prototype only dropped the tombstone, and C still kept row 3. Confirm with the test below that a delete addressed `[3,3]` removes the row on C.

**Push before pulling.** In `handleHandshakeAck`, when not `readOnly`: subscribe, `await this.pushUntilDrained()`, then `requestChangesFromServer()`. The prototype confirmed that both prune cases then converge on A, B, the server and a brand-new device, and that the duplicate push in the snapshot path disappears.

- The prototype's error handling was a placeholder and must not be copied: it stopped on any failure. `pushUntilDrained` throws for a closed socket, a replaced connection, a server-rejected push and a held send. If the socket is gone, stop. If the server rejected the push, log it and still pull, as happens today, so a device with a rejected batch does not stop receiving.
- Cost: a device with a large offline backlog reports `synced` later, because the first pull waits for the last push acknowledgement. Not measured.
- One mock test needs changing, not the behaviour: `does not bootstrap a device holding local data it never synced` in `sync-client.spec.ts` expects `get_changes` with no acknowledgement. The other 113 tests in that package passed with the prototype.

**Narrow the forgotten-row exemption.** `docs/sync.md` exempts a table permanently because "a relay cannot re-file its records", which stops being true. Remove `keyWasEverRedefined`, so a fragment can no longer return on such a table. Keep the same-batch part of `tablesWithRecordsElsewhere`, because Phase 1 reads by the new key before the pass runs in Phase 3. The two earlier-batch tests in `edit-of-forgotten-row.spec.ts` (lines 193 and 203) hand-build an edit of a row the server never held, so that edit should now be refused; change them to pin that. Add the case that matters: an edit of a re-filed row under its new key on a pruned relay is accepted.

## Not fixed here

- A key built on a column the relay has no cells for: `bug-sync-key-on-column-without-cells-through-relay`. The "stays where it is" rule above is what keeps that case from destroying the relay's data.
- A change written under the old key by a device that has not yet learned of the key change. This is the documented concurrent-write race and remains documented.

## TODO

Phase 1: reproduction

- Add to `sync-coordinator-roundtrip.e2e.spec.ts` the ticket's sequence in both prune states, asserting A, B, the server and a new device hold rows 1 and 2 with row 1 edited (`notesOn`, `notesOnServer`, `pruneEveryTombstone` exist). To force the pruned case, delete an unrelated row on A while B is offline, then prune. Confirm both fail first.
- The coordinator specs resolve `@quereus/sync` from `dist`, so run `npx tsc -b packages/quereus-sync-client/tsconfig.json` after each source change. Pass `--exit` to mocha while these fail: a failed e2e test leaves its server open and the run then never ends.

Phase 2: relay re-file

- Implement the relay variant under the rules above, reached from `rekeyAfterReplicatedKeyChange` when the peer has no schema oracle. Keep the existing warning for a peer that has an oracle but no engine.
- Add the relay's tables to `rekeyedTables` so the prior-version re-read still runs.
- Add the column list to `SchemaMigration` and carry it through capture, wire and storage. Use it for the tombstone projection.
- Add a spec in `packages/quereus-sync/test/sync/` driving a relay-only manager with hand-built changes (as `edit-of-forgotten-row.spec.ts` does), one test per branch: new key read from cells; tombstone moved using the column list; a group missing a key cell stays and is counted; two groups collapsing keep the newer cell; two concurrent applies of one key change leave every row.

Phase 3: client order

- Change `handleHandshakeAck` as above, with the failure handling described. Add one mock test that `get_changes` is not sent until the push is acknowledged, and one that a rejected push still pulls. Fix the mock test noted above.
- Add the offline-device delete case (C keeps row 3 today) to the e2e spec.

Phase 4: exemption and docs

- Remove `keyWasEverRedefined` and update the tests as above. Rewrite the comment on `tablesWithRecordsElsewhere`.
- `docs/sync.md`: update the exemption bullet (line 145), the re-filing paragraph (line 163) to cover the relay pass, and "What a key redefinition does not cover" (line 165), removing the relay sentences and this slug and naming the backlog ticket for missing key cells. Those line numbers may have moved.
- `docs/sync-protocol.md`: the SYNCING step (line 469) now pushes before `get_changes`.
- Update the header comment of `rekey-on-pk-change.ts` and the `planRekey` / `rekeyTableBookkeeping` comments that say a relay cannot run the pass.

Validation: `yarn workspace @quereus/sync test`, `yarn workspace @quereus/sync-client test`, `yarn workspace @quereus/sync-coordinator test`, and the `@quereus/sync` typecheck. Add `yarn test` if the engine's event shape changes, since that touches `packages/quereus`.
