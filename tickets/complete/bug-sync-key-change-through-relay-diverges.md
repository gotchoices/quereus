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
  - packages/quereus-sync-client/src/sync-client.ts # handleHandshakeAck pushes before pulling; pushBeforePull
  - packages/quereus/src/vtab/events.ts # VTableSchemaChangeEvent.columns
  - packages/quereus/src/runtime/emit/alter-table.ts # the engine's fallback producer sets it at both emit sites
  - packages/quereus-sync/test/sync/relay-rekey-on-pk-change.spec.ts # the relay pass, one test per branch
  - packages/sync-coordinator/test/sync-coordinator-roundtrip.e2e.spec.ts # the three reproductions
  - docs/sync.md
  - docs/sync-protocol.md
  - docs/sync-schema.md
  - docs/usage.md
difficulty: hard
repro: verified
----

## Summary

A relay is a server with sync records but no database engine, the shape of the standard coordinator. When a device changed a table's primary key offline and reconnected, the relay could not re-file its records under the new key, and the device asked the server for changes before its own upload had landed, so the server's reply overwrote the device's edit. Implemented in `ticket(implement): bug-sync-key-change-through-relay-diverges`:

- **The relay re-files from its own records.** `rekey-on-pk-change.ts` has two variants of one pass. The engine variant reads a row's new key from the table. The relay variant reads it from the row's own cell records, matched case-insensitively against the statement's column list, in one in-memory scan. A row group missing a key cell stays where it is and is counted as `rowsStranded` (the open case `bug-sync-key-on-column-without-cells-through-relay`). `CellContest` decides each `(new identity, column)` slot so a mover never overwrites a newer record and the change log keeps one entry per surviving record.
- **A key-change migration carries the table's column layout** (`columns`), from the engine's `alter primary key` event through the wire and the stored `sm:` value, so a relay can project a tombstone's new key from its positional before-image. The stored layout gained a length-prefixed slot, so the metadata format version is 7; a version-6 replica must re-bootstrap (release note in `docs/sync.md`).
- **The client pushes before it pulls.** The handshake drains every unsent batch, each acknowledged before the next, then sends `get_changes`. A rejected batch still pulls; a dropped socket stops and the reconnect retries.
- **The forgotten-row exemption is narrowed** to a key change or rename in the same batch, since an earlier batch's pass already re-filed the records.

## Review findings

Read the implement diff in full before the handoff, then every touched source file and the docs it cites. Ran: `@quereus/sync` (852 passing), `@quereus/sync-client` (117), `@quereus/sync-coordinator` (141, including the three e2e reproductions), `@quereus/store` (1986), `@quereus/quereus` (10947 passing, 25 pending), `yarn workspace @quereus/quereus lint` (clean), and `tsc --noEmit` on source and test configs of the three sync packages (clean).

**Checked and found sound (no change):**

- Correctness of the relay pass: the single scan, the `CellContest` tie rule, the stranded-row branch, the tombstone projection and collision rules, and the deferred puts under a key swap. The duplicate-apply case is idempotent whichever way the two scans interleave, because a moved group projects to its own identity and is kept, and an unmoved one is moved to the same records both times.
- Every site that copies a migration field by field (applicator, both snapshot appliers, `toSchemaChange`, the wire serializer, the migration store) carries `columns` beside `fromTable`. Snapshot producers go through the shared wire serializer, so the column list survives a snapshot.
- The `hasSchemaOracle` split is clean: a peer with an oracle quarantines out-of-basis tables rather than keying them raw, so no engine peer ever needs the records variant for a table it does not know.
- Client ordering: `recoveryOwnsPush` keeps the ack-driven chain out of the handshake drain, and a debounced local push during the drain is at worst one re-sent batch, as the existing comment on `pushUntilDrained` already states. The three failure paths of `pushBeforePull` match the ticket's rules.
- Tests: none cut. Each relay-spec test pins one branch; the client tests are the lowest-layer reproduction of the push-before-pull bug; the e2e tests are the ticket's scenarios. None restates the implementation or verifies a mock.
- Source hygiene: `rekey-on-pk-change.ts` is 598 lines (`wc -l`), coherent as one pass with two scan variants; comments say why, not what.

**Minor, fixed inline:**

- `docs/sync-protocol.md` wire interface for `SchemaMigration` listed `fromTable` but not the new `columns` field. Added.
- The `recoveryOwnsPush` comment in `sync-client.ts` still said the flag was set only by snapshot_required recovery; the handshake drain sets it too. Reworded.

**Major:** none. The implementation matches the fix ticket's design and the three reproductions pass end to end.

**Tripwires (recorded at the site, not filed):**

- `change-applicator.ts` `rekeyOneTable`: a peer with a schema oracle but no engine falls through to the table variant and declines; the records variant would work there too. `NOTE:` added.
- Already present from the implementer and confirmed appropriate: the in-memory cell-record hold in `rekeyRelayBookkeeping` (memory spike on very large relay tables), and the unserialized applies on one manager (`rekeyAfterReplicatedKeyChange`).

**Known gaps carried forward, unchanged:** a key built on a column with no cells on the relay, and on a renamed column, are the open backlog ticket `bug-sync-key-on-column-without-cells-through-relay`. The cost of the later `synced` report after a large offline backlog is not measured.
