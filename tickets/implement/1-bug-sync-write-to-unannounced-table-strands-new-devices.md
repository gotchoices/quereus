description: If a table was created before sync was attached and only that device has it, one write to the table sends its data to the server without its definition, and from then on no new device can finish its first sync. Writes should send the definition too, in a form that can never break a device that already has the table.
architecture: docs/sync.md#rows-sync-has-never-recorded
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts # recordCommitBatch (~847), filterCapturableDataEvents (~998), recordSchemaMigration (~1049)
  - packages/quereus-sync/src/sync/unrecorded-rows.ts # missingCreateEvents (~273), hasLiveCreate (~304), receiversCanWrite (~189), adoptTable flush (~219)
  - packages/quereus-sync/src/sync/protocol.ts # sortMigrationsByHLC (~144), SchemaChangeToApply (~505), toSchemaChange (~534), SchemaMigration.schemaVersion (~126)
  - packages/quereus-sync/src/sync/store-adapter.ts # decideSchemaChange create_table and add_index arms (~486, ~544), decideAbsentIndexCreate (~595), applySchemaChange (~1059)
  - packages/quereus-sync/src/sync/change-applicator.ts # Phase 1a same-version check (~308-338)
  - packages/quereus-sync/src/sync/snapshot-stream.ts # sorts PendingSchemaChange pairs (~522), which carry `.change` and `.record.stored`
  - packages/quereus-sync/src/sync/snapshot-identity.ts # createSnapshotKeyingResolver: home for the tripwire below
  - packages/quereus-sync/test/sync/_peer-harness.ts # makePeer's beforeSync creates a table sync never saw
  - docs/sync.md
  - docs/sync-schema.md
difficulty: hard
repro: verified
severity: wrong-result
----

## The bug

Every result below comes from `_peer-harness.ts` peers with a real engine and store, run against the current code. The original report saw the same `No table schema` failure with real clients and a real coordinator. Retries were not observed there (`autoReconnect: false`). Nothing changes on the server between attempts, so a retry is expected to fail the same way, but that is inferred.

```ts
const EXTRA = 'create table extra (id integer primary key, v text not null) using store';
const d = await makePeer('d', { beforeSync: EXTRA });
await localWrite(d, `insert into extra values (1,'y')`);
const c = await makePeer('c');
await c.manager.applySnapshotStream(d.manager.getSnapshotStream());
// throws: No table schema for main.extra — sync pk identity is unresolvable
```

| Scenario, current code | Result |
|---|---|
| Insert, update or delete on a pre-sync table, then a new device takes a snapshot | Fails: `No table schema for main.extra` |
| The same with a non-streaming snapshot | Fails: `Table not found for external write` |
| A connected device lacking the table receives the cells as a delta | Applies nothing, 2 changes quarantined |
| That connected device then takes a recovery snapshot | Fails: `No table schema` |
| Pre-sync table renamed under sync, then written | New device fails: `No table schema for main.e2` |
| `using memory` table written, **even one created after sync attached** | New device fails: `No table schema` |
| Two devices both declare the same memory table, one writes | The other's whole delta batch fails, as does a new device's snapshot: `Table not found for external write` |

The memory rows correct the original report, which said apps creating tables after attaching never hit this. Those apps do hit it if the table uses `memory`. Announcing cannot help there, because receivers have no way to write to such a table (`receiversCanWrite`).

## Decision: announce on write, using a baseline record

Local capture sends a table's definition with the first cells it records for a table that has none. Having a snapshot skip tables it has no definition for was weighed and rejected:

- **It does not deliver the table.** The new device would bootstrap, but it still never receives the table or its rows. They would sit in quarantine until the retention horizon removes them, which is the failure the docs already call a defect: "The schema goes too" under *Adopting rows*.
- **It has real work of its own.** It needs per-chunk branching through the streaming and non-streaming apply paths, and a hold rather than a drop, or the rows would be gone once the table did arrive.
- **What it would still catch is rare.** After this fix, cells with no definition remain only on servers that already hold them while the writing device never writes to that table again, and in the two cases named by the second `NOTE` on `hasLiveCreate`. Record that as a tripwire (see the TODO list). `AGENTS.md` says not to worry about backwards compatibility yet.

### Why a plain `create_table` is not enough

A prototype that reused `missingCreateEvents` as it stands fixed the table above, but it broke three things that work today. Each breakage was seen by running it:

| Scenario | Today | Plain `create_table` announcement |
|---|---|---|
| Device A altered its pre-sync table under sync; device B's first write announces the old shape | Rows apply | A throws `Schema conflict`. The throw aborts the batch, so A re-fails on every retry until an operator steps in (see the NOTE on `assertDefinitionMatches`) |
| Two devices with different pre-sync shapes (an app version rollout), one writes | Rows apply, unknown columns dropped | The same permanent `Schema conflict` |
| Same crossing, in the other direction: A's `alter` reaches B after B announced | Alter applies | Alter **silently lost**. Both records take schema version 1, B's has the later HLC, and Phase 1a skips A's as dominated |

These hit the apps that ship one schema to every device and create tables before attaching, which never had this bug. Those apps would trade a rare failure for a permanent stop on their next rollout.

### The baseline record

A **baseline** is a `create_table` or `add_index` migration recorded at **`schemaVersion` 0**. It means: "this object existed before sync on some device; here is its definition, for anyone who has none." Versions from ordinary migrations start at 1, so nothing else can occupy 0. That gives everything needed with no new wire field and no change to the stored encoding (the prototype round-tripped it unchanged):

- **It cannot collide with a real migration.** An `alter` at version 1 is never dominated by a baseline. Baselines compete only with each other, by HLC, which is the correct idempotent outcome.
- **A receiver that already has the object keeps what it has.** Never a conflict. It logs a warning when the shapes differ, and row handling is then exactly today's drift behaviour.
- **A receiver lacking the object creates it.** Any quarantined cells for the table drain through the existing inbound-`create_table` path.

### Rules

A prototype was run and then removed. It was a hack (a `WeakSet` of events), so treat the rules below as the specification and not its code.

- **Run and passing in the prototype:** version 0 records, keeping an existing table, following renames, moving a baseline ahead of an `alter_column` or `drop_table` (the drop only on a delta), skipping a baseline after a local drop, an ordinary create for a stream ending on a drop, and the memory-table filter without its gate.
- **Reasoned from a prototype failure or from the code, not yet run:** the no-op rule, appending announcements, the rename ordering for a device holding the old name, the `applyToStore` gate, the baseline index rule and the `WeakSet` memo. The tests below must cover the ones with behaviour.

- **When to announce.** A local data event that will record a fact, for a table whose module `receiversCanWrite`, whose migrations do not leave it live, and that this transaction does not itself create.
- **No-op updates announce nothing.** An update that changes no value records no fact, and `edit-of-forgotten-row.spec.ts` ("leaves an unrecorded row unrecorded when an update changes nothing") requires an empty result. Decide using the same changed-column test `recordDataEvent` uses.
- **A stream ending on a drop gets an ordinary create.** If the table's migrations end on `drop_table` (dropped under sync, re-created while detached), that is a real new table: record a normal next-version `create_table` with today's conflict rule, not a baseline. Otherwise the record would sort ahead of the drop it is meant to follow.
- **`hasLiveCreate` follows renames.** A `rename_table` counts as live only if its `fromTable` stream is live, recursively. This resolves the first `NOTE` on that function and the rename row in the table above. Inside one transaction, ask about an own `rename` event's old name, because the batch has not reached storage yet.
- **Announcements come after the transaction's own schema events.** The prototype prepended them, and `applyLocalTableTransitions` then ran `ensure(new name)` before `move(old, new)`, which collided (`schema-alter-replication.spec.ts`, "a rename in the same transaction as writes…"). Version 0 sorts first in the stream regardless.
- **Apply order.** After sorting by HLC, move each baseline ahead of the first same-name migration in its stream that is not a `rename_table`.
  - Ahead of `alter_column`: otherwise a fresh device that gets `[alter, older-shape baseline]` ends up without the column.
  - Ahead of `drop_table`: otherwise a fresh device ends up with a table everyone else dropped.
  - Behind `rename_table`: a device holding the old name must run the rename first, or the baseline creates an empty table under the new name and the rename throws because both names exist.
  - The sort has to cover all three callers: `applyChanges`, the non-streaming snapshot and the streaming snapshot's `PendingSchemaChange` pairs. A key-extractor argument is cleaner than the prototype's shape-sniffing. The function name should stop claiming it is HLC-only.
- **A receiver that dropped the object skips the baseline.** In Phase 1a, skip a version 0 migration when the local stream for that object ends on `drop_table` or `drop_index`. The table's cells are then quarantined, as they are today, rather than the table coming back on one device only.
- **Baseline indexes.** Execute a baseline `add_index` only when this same apply created the table from a baseline; a device with its own table keeps its own indexes. The prototype executed it on any table with the index absent, which worked in its one test, but a baseline index over a column the receiver lacks, or a unique index over its duplicates, would throw and stop that device permanently. Tracking this is local to the `applySchemaChange` loop. Cover it with a test.
- **Memory tables stop being captured.** Have `filterCapturableDataEvents` drop events for a table `receiversCanWrite` rejects, reporting through `logSkippedTables`. Gate it on `applyToStore` being present, as `adoptUnrecordedRows` does: `transaction-commit.spec.ts` records a memory table on a manager with no apply path. The same module-shape test also covers wrapped stores through `underlying`.
- **Cost.** Remember the "announced" answer in a `WeakSet<TableSchema>` so repeat writes read no migrations. Replicated and local DDL both register a fresh schema object, so it invalidates itself, the same approach as `createPkKeyingResolver`. Clear it where `handleTransactionCommit` re-reads table identity after a failed capture, since a failed batch announced nothing. Cost not measured.

### Adoption becomes simpler

Adoption's synthetic batches go through `recordCommitBatch`, so that function can do all announcing. `adoptTable` then drops its `schemaEvents` line and `missingCreateEvents` has one caller. Adoption's announcements also become baselines, which changes one documented cost: two devices adopting different shapes no longer conflict. Each keeps its own shape, which is what happens with plain writes. No existing test asserts the old conflict.

### Accepted limits

- The rest of a device's unrecorded rows stay local after an announcement: only the written row travels. That is the documented behaviour and `'adopt'` remains the way to send them.
- Shape differences between devices are tolerated rather than resolved, the same as today. Sender-only columns are dropped and receiver-only columns stay null, even a `NOT NULL` column (seen in the alter scenario above). Announcing does not make this better or worse.

## Existing tests the change affects

The full run with the prototype was 817 passing, 4 failing in `quereus-sync`; `quereus-sync-client` (106) and `sync-coordinator` (138) were all green. The first three failures should be resolved by the rules above, which were written after seeing them and have not been rerun. The last is a correct expectation change:

- `edit-of-forgotten-row.spec.ts`, no-op update: fixed by the no-op rule.
- `schema-alter-replication.spec.ts`, rename in one transaction with writes: fixed by appending announcements.
- `transaction-commit.spec.ts:439`, memory table with no apply path: fixed by the `applyToStore` gate.
- `changes-to-push.spec.ts:92`: the peer writes to a pre-sync `orders`, so it now legitimately announces it. Update the expected tables to include `orders`.

## TODO

- Add `packages/quereus-sync/test/sync/unannounced-table.spec.ts`, using `makePeer`'s `beforeSync`, with one test per behaviour:
  - a new device bootstraps by streaming and non-streaming snapshot after an insert, update and delete, and holds the row
  - a connected device lacking the table receives the table and row with nothing quarantined
  - a renamed pre-sync table reaches a new device, and a device still holding the old name renames rather than conflicts
  - different pre-sync shapes, and a crossing alter, apply without `Schema conflict`, and the alter is not lost
  - a fresh device receiving `[alter, older baseline]` ends with the altered shape on all three apply paths
  - a dropped table is not revived by a crossing baseline, on the device that dropped it or on a fresh device
  - a baseline index is not executed on a table the receiver already had, including a unique index over duplicates
  - a memory table's writes record no cells, and neither strand a new device nor fail a peer's batch
- Implement the rules above in `sync-manager-impl.ts`, `unrecorded-rows.ts`, `protocol.ts`, `store-adapter.ts` and `change-applicator.ts`.
- Document version 0 on `SchemaMigration.schemaVersion`, and add `baseline` to `SchemaChangeToApply` set by `toSchemaChange`, so every ingress path shares one rule.
- Update `changes-to-push.spec.ts` as above, confirm the other three pass unchanged, and remove the resolved `NOTE`s in `hasLiveCreate` and any others this makes untrue, such as the fallback-arm NOTE in `decideSchemaChange`.
- Add the tripwire as a `NOTE:` on `createSnapshotKeyingResolver`: a section with cells and no definition still fails the snapshot. It now takes a server already holding such cells whose writer never writes to that table again. If that shows up, hold those cells as the delta path does rather than throwing.
- Update `docs/sync.md`: replace the "An edit announces no table" bullet (line ~205), and revise "The schema goes too" and "Two devices adopting tables with the same name and different shapes conflict" under *Adopting rows*. Describe baselines and the memory-table exclusion.
- Update `docs/sync-schema.md`: version 0, the apply order, and the "What replicates" memory sentence (~line 321).
- Run `yarn workspace @quereus/sync test`, then the client and coordinator suites, then `yarn build` and `yarn lint`.
