description: When a device changes a table's primary key and syncs through a server that has no database engine, devices end up with different data: the writer can lose its own edit, or lose whole rows. The server now moves its records to the new key, and the device finishes uploading before it downloads.
architecture: docs/sync.md#tombstones-and-deletions
files:
  - packages/quereus-sync/src/sync/rekey-on-pk-change.ts # two variants of the pass: from the table (engine peer) and from the records themselves (relay); CellContest; rowsStranded
  - packages/quereus-sync/src/sync/change-applicator.ts # rekeyOneTable picks the variant; keyWasEverRedefined removed; concurrency NOTE
  - packages/quereus-sync/src/sync/sync-context.ts # hasSchemaOracle
  - packages/quereus-sync/src/sync/sync-manager-impl.ts # hasSchemaOracle getter; recordSchemaMigration carries the column list
  - packages/quereus-sync/src/sync/protocol.ts # SchemaMigration.columns, SchemaChangeToApply.columns
  - packages/quereus-sync/src/sync/wire.ts # columns on the wire, present-only
  - packages/quereus-sync/src/metadata/schema-migration.ts # stored layout: a 4-byte length-prefixed JSON slot before the DDL
  - packages/quereus-sync/src/metadata/keys.ts # SYNC_METADATA_FORMAT_VERSION 6 → 7
  - packages/quereus-sync/src/sync/events.ts # PrimaryKeyRekeyedEvent.rowsStranded
  - packages/quereus-sync/src/sync/snapshot.ts # carries columns when recording a snapshot's migrations
  - packages/quereus-sync/src/sync/snapshot-stream.ts # same, streaming path
  - packages/quereus/src/vtab/events.ts # VTableSchemaChangeEvent.columns
  - packages/quereus/src/core/database-events.ts # DatabaseSchemaChangeEvent.columns
  - packages/quereus/src/vtab/alter-event-shape.ts # the emitter-backed producers set it
  - packages/quereus/src/runtime/emit/alter-table.ts # the engine's fallback producer sets it at both emit sites
  - packages/quereus/src/runtime/emit/alter-schema-event.ts # the emit-site shape
  - packages/quereus-sync-client/src/sync-client.ts # handleHandshakeAck pushes before pulling; pushBeforePull
  - packages/quereus-sync/test/sync/relay-rekey-on-pk-change.spec.ts # new: the relay pass, one test per branch
  - packages/quereus-sync/test/sync/edit-of-forgotten-row.spec.ts # the narrowed exemption
  - packages/quereus-sync-client/test/sync-client.spec.ts # handshake order
  - packages/sync-coordinator/test/sync-coordinator-roundtrip.e2e.spec.ts # the three reproductions
  - packages/quereus-store/test/alter-events.spec.ts # cross-backend parity now covers the column list
  - packages/quereus/test/alter-table-schema-events.spec.ts # same, for the engine's own producers
  - docs/sync.md
  - docs/sync-protocol.md
  - docs/sync-schema.md
  - docs/usage.md
difficulty: hard
repro: verified
----

## What was wrong

A relay is a server with sync records but no database engine, the shape of the standard coordinator. When a device changed a table's primary key offline and reconnected, two independent things went wrong: the relay could not re-file its records under the new key (it has no table to read a row's new key from, so it logged "the key it retired was not captured" and left every record under the old key), and the device asked the server for changes before its own upload had landed, so the server's reply was built from the old-key records and overwrote the device's edit. Both reproduced with a real coordinator and real clients; the three new e2e tests fail on the previous code and pass now.

## What changed

**The relay re-files from its own records.** `rekey-on-pk-change.ts` now has two variants of one pass. The engine variant is as before: a row's new key is read from the table. The relay variant reads each row's new key from the row's own cell records (every cell record carries its column name and value) using the column list in the statement, matched case-insensitively. The old identity is the record's key, so the relay never needs to know the old key. Rules, each with a test:

- One scan, held in memory, so the row maps and the move act on the same records (the prototype's two scans straddled a concurrent pass's write and deleted every re-filed row).
- A row group with no cell for a key column stays where it is, counted as `rowsStranded` on the event and warned about. It is not deleted: the relay may hold the only copy. This is what keeps the open case `bug-sync-key-on-column-without-cells-through-relay` from destroying data.
- A record moving in never overwrites a newer record at its target. `CellContest` decides each `(new identity, column)` slot: the record already there that does not move, or the newest of those moving in; between equal timestamps the one that stays wins, so a duplicate apply costs no write. The loser's change-log entry is deleted with it, so the log keeps one entry per surviving record. Two old rows can land on one new key on a relay, because its rows are not checked for uniqueness.
- Deferred puts kept, so a key swap stays safe.

**The key-change migration carries the table's column layout.** A delete's before-image reaches the relay but is positional, and the relay has no catalog to read it with. The engine's `alter primary key` event now names the table's columns (`columns`, next to `oldKeyColumns`), set by all three producers (memory module, store module, the engine's fallback path) and checked by both parity specs. Sync records it on the migration (`SchemaMigration.columns`, optional, set only on a key change), carries it on the wire present-only, and stores it in the `sm:` value. The relay projects a tombstone's new key from its before-image with it; without it the tombstone is dropped under the existing rule.

**The stored migration layout changed, so the metadata format version is now 7.** The `sm:` value gained a 4-byte length-prefixed JSON slot between `fromTable` and the DDL. The DDL is "rest of buffer", so there was nowhere to append it. A version-6 replica refuses to open and must re-bootstrap, as the format gate already requires for 5 → 6. The release note is in `docs/sync.md` § Metadata format version. If this cost is unwelcome, the alternative is to length-prefix the DDL instead, which is the same kind of layout change.

**The client pushes before it pulls.** `handleHandshakeAck` now subscribes to local changes, drains every unsent batch (`pushUntilDrained`, each batch acknowledged before the next), and only then sends `get_changes`. Failure handling, as the ticket asked: if the socket is gone or was replaced, stop and let the reconnect run the handshake again; if the server rejected a batch or one could not be sent on a socket that is still open, log it and still pull, so a device with a rejected batch keeps receiving. Cost: a device with a large offline backlog reports `synced` only once its last batch is acknowledged. Not measured.

**The forgotten-row exemption is narrowed.** `keyWasEverRedefined` is gone, with the migration walk it did on every flagged edit. Only a key change or rename in the same batch exempts a table now, because Phase 1 reads by the new key before Phase 3's pass re-files the records. `tablesWithRecordsElsewhere` is synchronous and takes only the batch's schema changes.

## How to see it working

The three e2e tests in `sync-coordinator-roundtrip.e2e.spec.ts` are the ticket's scenarios end to end (two real-engine clients, a real coordinator on an ephemeral port, a third device where the case needs one):

- A key change made offline converges on A, B, the server and a new device when the server has not pruned (B catches up by delta).
- The same when the server has pruned, so B is refused a delta and takes a snapshot after pushing. The unrelated delete of row 9 while B is offline is what raises the delta floor above B's watermark.
- A delete made while device C was offline still removes the row on C after B changed the key. The relay ships the delete addressed by the new key, which C applies in the same batch as the key change. This was the arm the ticket said was not prototyped; it works, with one condition the test now states: B must hold the delete before it changes the key. My first version of this test raced B's key change against the broadcast of A's delete, which is the documented concurrent-write race, and failed once for that reason.

Run them with `yarn workspace @quereus/sync-coordinator test`, or just the spec with `--exit` (a failed e2e test otherwise leaves its server open). The coordinator specs resolve `@quereus/sync` from `dist`, so rebuild with `npx tsc -b packages/quereus-sync-client/tsconfig.json` after any source change.

## Tests added or changed

- `relay-rekey-on-pk-change.spec.ts` (new, relay-only manager with hand-built changes): new key read from cells with a differently spelled column name; a tombstone moved using the migration's column list; a tombstone dropped when the migration carries none; a row group missing a key cell stays, is counted and warned about; two rows landing on one new key keep the newer cell and one change-log entry; two concurrent applies of one key change leave every row under the new key.
- `edit-of-forgotten-row.spec.ts`: the two earlier-batch tests now pin that such an edit is refused; a new test pins that an edit of a row the relay re-filed under the new key is accepted.
- `sync-client.spec.ts`: `get_changes` is sent only once every batch of offline work is acknowledged (two batches, no batch sent twice); a rejected push still pulls and logs; a socket that closes before the acknowledgement stops the sequence. The divergence-guard test now acknowledges the push before expecting `get_changes`.
- `sync-coordinator-roundtrip.e2e.spec.ts`: the three reproductions above.
- `alter-events.spec.ts` (store) and `alter-table-schema-events.spec.ts` (engine): the rendered event shape includes `cols(…)`, so a producer that forgets the column list fails the parity check.
- `table-identity-strands-metadata.spec.ts`: the event now carries `rowsStranded: 0`. `metadata-format-version.spec.ts`: the pin moved to 7 and the refused version to 6.

## Validation run

| Command | Result |
|---|---|
| `yarn workspace @quereus/sync test` | 852 passing |
| `yarn workspace @quereus/sync-client test` | 117 passing |
| `yarn workspace @quereus/sync-coordinator test` | 141 passing (the roundtrip spec alone also passed twice in a row and the offline-delete case four times in isolation) |
| `yarn workspace @quereus/quereus test` | 10947 passing, 25 pending |
| `@quereus/store` mocha suite | 1986 passing |
| typecheck: sync, sync-client, sync-coordinator (source and tests), store tests; `yarn workspace @quereus/quereus lint` | clean |

## Known gaps and things worth a second look

- The relay variant holds every cell record of the table in memory for the length of the pass, where the engine variant holds one entry per row. A `NOTE:` at the site says what to do if it ever shows as a spike.
- The concurrency of applies on one manager is unchanged, per the ticket, with a `NOTE:` at the pass in `change-applicator.ts`. The concurrent-apply test exercises two applies of the same key change on the in-memory store, whose iteration is a snapshot of the map at call time; a LevelDB iterator is also snapshot-consistent, but that was not run.
- `CellContest`'s tie rule (equal timestamps: the record that stays wins over a mover) is reasoned, not observed in a real duplicate push, since the push-before-pull change removes the duplicate push the ticket saw. The two-concurrent-applies test covers the mechanism.
- The tombstone rule "a new key a different live row now owns drops the tombstone" is unchanged and, on a relay, is decided from the cell groups rather than the table. Not separately tested on a relay.
- `SchemaChangeToApply.columns` is carried for the applicator's pass; the store adapter never reads it.
- A key built on a renamed column through a relay (cells keep the old column name) is not covered here; the backlog ticket for missing key cells lists it as a case to confirm.
- The cost of the later `synced` report was not measured.
