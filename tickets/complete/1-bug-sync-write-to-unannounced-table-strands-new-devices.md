description: If a table was created before sync was attached and only that device has it, one write to the table sends its data to the server without its definition, and from then on no new device can finish its first sync. Writes now send the definition too, as a "baseline" record that can never break a device that already has the table.
architecture: docs/sync.md#rows-sync-has-never-recorded
files:
  - packages/quereus-sync/src/sync/protocol.ts # BASELINE_SCHEMA_VERSION, isBaselineVersion, MigrationOrderKey, orderMigrations (replaces sortMigrationsByHLC), SchemaChangeToApply.baseline, toSchemaChange
  - packages/quereus-sync/src/sync/sync-manager-impl.ts # recordCommitBatch, announceUnrecordedTables, recordBaselineMigration, filterCapturableDataEvents / captureSkip / logSkippedTables, recordsAFact, cellChanged, originOfName
  - packages/quereus-sync/src/sync/unrecorded-rows.ts # announcementFor, migrationStreamState, receiversCanWrite, adoptTable
  - packages/quereus-sync/src/sync/store-adapter.ts # decideSchemaChange baseline arms, keepLocalOverBaseline, SchemaApplyState, indexesBaselineCreatedTable
  - packages/quereus-sync/src/sync/change-applicator.ts # Phase 1a baseline skip (localStreamEndsOnDrop), orderBatchMigrations
  - packages/quereus-sync/src/sync/snapshot.ts
  - packages/quereus-sync/src/sync/snapshot-stream.ts
  - packages/quereus-sync/src/metadata/schema-migration.ts
  - packages/quereus-sync/src/sync/snapshot-identity.ts # tripwire NOTE on createSnapshotKeyingResolver
  - packages/quereus-sync/test/sync/unannounced-table.spec.ts # 18 tests
  - packages/quereus-sync/test/sync/changes-to-push.spec.ts
  - docs/sync.md
  - docs/sync-schema.md # § Baselines
  - docs/sync-protocol.md
difficulty: hard
repro: verified
severity: wrong-result
----

## What landed (`ticket(implement): bug-sync-write-to-unannounced-table-strands-new-devices`)

A **baseline** is a `create_table` or `add_index` migration recorded at schema version 0 (`BASELINE_SCHEMA_VERSION`). It means "this object existed before sync on some device; here is its definition, for anyone who has none". Ordinary migrations are versioned from 1, so a baseline never collides with a real migration, and no wire or stored encoding changed.

- **Capture.** On the first fact recorded for a table whose migrations never brought it into existence, local capture records a baseline create for the table and a baseline `add_index` per index, after the transaction's own schema events. A table whose own stream ends on a drop gets an ordinary next-version create instead. A table the transaction creates needs nothing; one it renames is judged by the old name's stream. A no-op update announces nothing. The verdict is remembered per catalog schema object, added only after the batch commits. Adoption goes through the same capture, so two devices adopting different shapes of one table no longer conflict.
- **Memory tables.** Their data events are dropped at capture (gated on an apply path being wired), with one warning per schema object, since no receiver can write them.
- **Apply.** A baseline create creates an absent table and keeps a present one over any shape (warning on a difference). A baseline index runs only on a table the same store-apply invocation created from a baseline. In Phase 1a of a delta apply, a baseline is skipped on a receiver whose own stream for the object ends on a drop.
- **Ordering.** `orderMigrations` replaces `sortMigrationsByHLC` on all three apply paths and in `listAllMigrations`: after the stable HLC sort, each baseline moves ahead of the first alteration or drop of its own object, staying behind a `rename_table` and behind a real create.

Docs: `docs/sync.md` (first recorded fact announces the table; adoption rewritten in those terms), `docs/sync-schema.md § Baselines`, `docs/sync-protocol.md` (version 0 meaning).

## Review findings

**Checked by reading the diff fresh, then the code around it.** Version 0 sorts first under the zero-padded migration key, so `getCurrentVersion` (reverse scan, limit 1) is unaffected and the `?? getCurrentVersion() + 1` fallbacks leave a real 0 alone. The snapshot stream emits every migration before the first `table-start` and flushes them in one store call, so a baseline table and its baseline indexes always share one `SchemaApplyState`; the delta path applies a batch's migrations in one call too, and a transaction's baselines travel in one changeset. Two baselines of one table with different DDL resolve in Phase 1a by HLC (the newer overwrites the older record on every device), so every fresh device gets the same shape whichever device it bootstraps from. `orderMigrations` is safe against moving past an item it has yet to visit: the displaced element is one already seen. `captureSkip` with no oracle keeps every event, matching the old `isTableInBasis` relay behaviour. The rename-chain walks in `originOfName` and `migrationStreamState` terminate on cycles. The `add_column` / `drop_column` kinds `displacesBaseline` names are legacy wire types no current origin emits; harmless and correct to include.

**Defect looked for and not found: a device that alters its pre-sync table under sync, then writes.** The baseline then carries the altered shape and is ordered *ahead* of the alteration it was recorded after, so a fresh device replays an `add column` it already has. This passes on all three apply paths because `decideAlterTable` has an idempotency arm per alteration. The ordering change makes that arm load-bearing for bootstrap, and no test pinned it, so one was added (`a table altered under sync before its first write replays on a fresh device without re-adding the column`, one per apply path). 15 tests became 18.

**Minor, fixed inline.**

- `recordsAFact` duplicated the by-value cell comparison in `recordColumnVersions`; both now call `cellChanged`, which carries the "by value, because blobs read back as new objects" rationale once.
- `docs/sync-schema.md` claimed a memory table's DDL replicates. The memory module attaches DDL only when its event emitter is wired; otherwise the engine's own create event has none and the migration crosses as an empty statement (the test run logs exactly that for a memory table created under sync). Reworded. The same section's displacer list now matches `displacesBaseline`.
- `docs/sync.md` said the announcement happens once per table with no later migration read; the memo is in memory, so the first write after a restart reads the stream once and finds the baseline. Reworded.

**Tripwires recorded.**

- `orderMigrations` scans the list once per baseline (quadratic worst case); `NOTE:` at the site in `protocol.ts` says what to index if a snapshot's migration list ever grows large.
- A snapshot section with cells for a table the receiver ends up without still throws at `createSnapshotKeyingResolver` (cells from before this fix, or cells written after another device's drop that the snapshot's own DDL then runs the baseline ahead of). Already a `NOTE:` there from the implement pass; confirmed the wording covers both cases.
- A fresh device receiving an alteration and the older baseline in *separate* delta batches ends with the old shape. Documented under "What it does not do" in `docs/sync-schema.md § Baselines`; bootstrap is by snapshot under `SyncClient`, where the order is right. Left as documentation, not a ticket: it needs a device bootstrapping by delta from a relay that received the two in that order, and before this change the same device had no table at all.
- A baseline index after a same-apply alteration that drops its column throws and fails the batch. Not reachable without two devices whose pre-sync shapes diverged by a dropped indexed column; the implement handoff names it and nothing in this pass changed that assessment. The baseline-index comment in `decideSchemaChange` already states the index runs only on a baseline-created table.

**Tests cut: none.** Each of the implementer's tests exercises a distinct branch (fact kind, apply path, rename, shape drift, drop, index, memory table) through real peers; none restates the implementation or verifies a mock.

**Tickets filed: none.** No finding met the filing bar: no class-level invariant surfaced beyond what the baseline version already enforces, and the conditional concerns are recorded as tripwires above.

**Validation.** `yarn workspace @quereus/sync typecheck`: clean. `yarn workspace @quereus/sync test`: 839 passing. `yarn workspace @quereus/sync-client test`: 106 passing. `yarn workspace @quereus/sync-coordinator test`: 138 passing. `yarn lint`: clean.
