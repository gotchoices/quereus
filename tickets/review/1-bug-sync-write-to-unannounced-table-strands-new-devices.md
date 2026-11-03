description: If a table was created before sync was attached and only that device has it, one write to the table sends its data to the server without its definition, and from then on no new device can finish its first sync. Writes now send the definition too, as a "baseline" record that can never break a device that already has the table.
architecture: docs/sync.md#rows-sync-has-never-recorded
files:
  - packages/quereus-sync/src/sync/protocol.ts # BASELINE_SCHEMA_VERSION, isBaselineVersion, MigrationOrderKey, orderMigrations (replaces sortMigrationsByHLC), SchemaChangeToApply.baseline, toSchemaChange
  - packages/quereus-sync/src/sync/sync-manager-impl.ts # recordCommitBatch, announceUnrecordedTables, recordBaselineMigration, filterCapturableDataEvents / captureSkip / logSkippedTables, recordsAFact, originOfName
  - packages/quereus-sync/src/sync/unrecorded-rows.ts # announcementFor, migrationStreamState (replaces missingCreateEvents / hasLiveCreate), receiversCanWrite (now exported), adoptTable
  - packages/quereus-sync/src/sync/store-adapter.ts # decideSchemaChange baseline arms, keepLocalOverBaseline, SchemaApplyState, indexesBaselineCreatedTable, applySchemaChange
  - packages/quereus-sync/src/sync/change-applicator.ts # Phase 1a baseline skip (localStreamEndsOnDrop), orderBatchMigrations
  - packages/quereus-sync/src/sync/snapshot.ts # orderMigrations
  - packages/quereus-sync/src/sync/snapshot-stream.ts # PendingSchemaChange carries the migration; orderMigrations
  - packages/quereus-sync/src/metadata/schema-migration.ts # listAllMigrations uses orderMigrations
  - packages/quereus-sync/src/sync/snapshot-identity.ts # tripwire NOTE on createSnapshotKeyingResolver
  - packages/quereus-sync/test/sync/unannounced-table.spec.ts # new, 15 tests
  - packages/quereus-sync/test/sync/changes-to-push.spec.ts # expected tables now include the announced orders
  - docs/sync.md
  - docs/sync-schema.md # new § Baselines
  - docs/sync-protocol.md
difficulty: hard
repro: verified
severity: wrong-result
----

## What changed

A **baseline** is a `create_table` or `add_index` migration recorded at schema version 0 (`BASELINE_SCHEMA_VERSION` in `protocol.ts`). It means "this object existed before sync on some device; here is its definition, for anyone who has none". Ordinary migrations are versioned from 1, so a baseline never collides with a real migration. No wire or stored encoding changed: the version number carries the meaning, and `toSchemaChange` sets `SchemaChangeToApply.baseline` from it so every ingress path shares one rule.

**Capture side** (`recordCommitBatch`). For each table a transaction records a fact for, `announceUnrecordedTables` asks `announcementFor` whether the table's migrations bring it into existence (`migrationStreamState`, which follows `rename_table` back through `fromTable`). Three outcomes: `live` means nothing to do; `unrecorded` means a baseline create for the table and a baseline `add_index` per index, recorded at version 0 after the transaction's own schema events; `dropped` (the table's own stream ends on a drop) means an ordinary next-version create with today's conflict rule, since a baseline would sort ahead of the drop it follows. A table the transaction itself creates (under any name along a rename chain) needs nothing; one it renames is judged by the old name's stream, because storage has not seen the rename yet. A no-op update records nothing and announces nothing (`recordsAFact` applies the same by-value test as `recordColumnVersions`). The verdict is remembered per catalog `TableSchema` object in a `WeakSet`, added only after the batch commits, so a failed batch never remembers anything and no clearing is needed.

**Memory tables.** `filterCapturableDataEvents` now also drops the events of a table `receiversCanWrite` rejects (a `memory` table, say), gated on `applyToStore` being wired, and warns once per schema object. A definition with no `vtabModule` at all (a test oracle's stub) is left alone.

**Adoption** goes through the same capture, so `adoptTable` no longer builds its own schema events. Two devices adopting different shapes of one table no longer conflict; each keeps its own, as under plain writes.

**Apply side** (`decideSchemaChange`). A baseline `create_table` creates an absent table and keeps a present one over any shape, warning if the DDL differs (`keepLocalOverBaseline`). A baseline `add_index` runs only on a table this same `applyToStore` invocation created from a baseline (`SchemaApplyState.baselineCreated`); a device with its own table keeps its own indexes. In Phase 1a of `applyChanges`, a baseline is skipped when the receiver's own stream for the object ends on a drop, so a dropped table does not come back on one device, and its cells take the unknown-table route.

**Ordering.** `orderMigrations(items, keyOf)` replaces `sortMigrationsByHLC` on all three apply paths and in `listAllMigrations`: after the stable HLC sort, each baseline is moved ahead of the first `alter_column` / `add_column` / `drop_column` / `drop_table` / `drop_index` of its own object, and stays behind a `rename_table` and behind a real `create_table` / `add_index`.

## Deviations from the ticket, with reasons

- **Baselines stay behind a real create, not only behind renames.** The ticket said "move each baseline ahead of the first same-name migration in its stream that is not a `rename_table`". Moving a baseline ahead of a real `create_table` would make a fresh device judge that create against the baseline's shape through the current-shape fallback, turning a difference into a permanent conflict, where keeping the baseline behind the create simply keeps the table. It also broke `unrecorded-rows.spec.ts` ("announces an index again after a table it announces late"): the baseline index moved ahead of the older real `add_index`, ran before its table existed, and was skipped. So the move targets only alterations and drops.
- **Memo is added after commit rather than cleared on failure.** Same effect as the ticket's "clear it where `handleTransactionCommit` re-reads table identity", but it also covers adoption, which calls `recordCommitBatch` without that handler.
- **A rename chain that returns to a visited name reads as `unrecorded`.** A version-ordered stream walk cannot tell whether that name's create came before or after the rename back. The cost is a baseline every receiver keeps its own table over; a NOTE on `migrationStreamState` says so.

## Tests added (`unannounced-table.spec.ts`), each with what it verifies

- `after a first insert / update / delete, a new device bootstraps by either snapshot path` (3 tests): the first recorded fact of each kind records exactly one baseline, and a fresh device via streaming and whole snapshot has the table and the recorded row (or an empty table after a delete).
- `once, so a repeat write ... announces nothing again`: the memo; the second write adds no migration.
- `a connected device lacking the table receives the table and the row, with nothing quarantined`: the delta path, `unknownTable` is 0.
- `a pre-sync table renamed under sync reaches a new device under its new name, and a device still holding the old name renames rather than conflicts`: `migrationStreamState` following `fromTable`; wire order `[rename_table e2@1, create_table e2@0]`; the old-name holder executes the rename and keeps its table.
- `in the same transaction as the first write is announced under the new name, after the rename`: `originOfName` and the append-after-own-events rule.
- `two devices with different pre-sync shapes exchange rows, each keeping its own shape`: `keepLocalOverBaseline`, no conflict either direction.
- `an alteration crossing a baseline applies on both sides: no conflict, and the alteration is not lost`: the alter at version 1 is not dominated by the baseline.
- `a fresh device receiving an alteration and an older-shape baseline ends with the altered shape` (3 tests, one per apply path): the baseline-ahead-of-alter move on delta, streaming and whole snapshot.
- `a table one device dropped is not revived by a crossing baseline, on that device or on a fresh one`: the Phase 1a skip on the dropping device (cells held), and the baseline-ahead-of-drop move on a fresh device receiving both in one batch, in either arrival order.
- `a baseline index runs on a table the baseline created, never on a device with its own table`: a unique baseline index is created on a fresh device and skipped on a device whose rows would violate it.
- `a memory table's writes record nothing, so they neither strand a new device nor fail a peer's batch`: the capture filter, a peer declaring the same memory table, and a snapshot bootstrap.

Existing tests: `changes-to-push.spec.ts` now expects `['our_table', 'orders']` (the pre-sync `orders` is announced on its first write). The three failures the ticket predicted from the prototype (`unrecorded-rows.spec.ts` no-op update, `schema-alter-replication.spec.ts` rename with writes, `transaction-commit.spec.ts` memory table with no apply path) pass unchanged. The adoption tests in `unrecorded-rows.spec.ts` pass unchanged, including "announces a table its migrations leave dropped" (ordinary create) and "announces an index again after a table it announces late" (baseline index executed on the fresh receivers).

## Validation run

- `yarn workspace @quereus/sync test`: 836 passing (821 before this change, 15 added).
- `yarn workspace @quereus/sync-client test`: 106 passing. `yarn workspace @quereus/sync-coordinator test`: 138 passing.
- `yarn workspace @quereus/sync typecheck`, `yarn build`, `yarn lint`: clean.

## Known gaps and tripwires for the reviewer

- **Separate delta batches for a fresh device.** A fresh device that receives an alteration and the older baseline in *separate* `applyChanges` calls applies the alteration to an absent table (converging with a warning) and then creates the old shape, so it lacks the column. The ordering fix only works within one batch or one snapshot. Bootstrap is by snapshot under `SyncClient`, and the test's relay peer shows the same effect (it holds the old shape without `note`). Documented under "What it does not do" in `docs/sync-schema.md § Baselines`. Before this change the same device had no table at all.
- **Snapshot section for a table the snapshot's own DDL drops.** With a baseline moved ahead of a drop, a snapshot that also carries cells for that table (a relay recorded the cells after the drop) still throws `No table schema` at `createSnapshotKeyingResolver`. Recorded as the tripwire NOTE there, together with the pre-fix case (cells with no definition from before this change). The delta path holds such cells instead.
- **Phase 1a's drop skip runs on relays too.** A relay-only coordinator has no catalog, but its migration records say the object's stream ends on a drop, so it skips the baseline as a device that dropped the table would. Cells then stay recorded on the relay with no definition (the tripwire above). Either choice strands the snapshot path for this scenario; skipping uniformly keeps one rule.
- **Baseline index after an alteration in the same apply.** If a fresh device creates the table from a baseline and the same apply then runs a crossing `alter_column` that drops a column the baseline index covers, the index create throws and the batch re-fails. Not covered by a test; it needs two devices whose pre-sync shapes diverged by a dropped indexed column.
- **Cost not measured.** `announceUnrecordedTables` reads one table's migration stream per first write per schema object; `orderMigrations` is quadratic in the number of baselines in one list. Both are small today.
- `localStreamEndsOnDrop` in `change-applicator.ts` and `migrationStreamState` in `unrecorded-rows.ts` both walk a stream; they answer different questions (last record vs. liveness following renames) and were left separate.
