description: When a synced table's primary key definition changes, re-file its conflict-tracking records under each row's new key so earlier deletions and edits still count against later writes from other devices.
prereq: sync-table-generation-identity
architecture: docs/sync.md#row-identity-vs-address
files:
  - packages/quereus-sync/src/sync/rekey-on-pk-change.ts            # NEW — the pass, shared by both call sites; `reportRekeyOutcome`
  - packages/quereus-sync/src/sync/migration-ddl.ts                 # NEW — `parseMigrationDDL` (moved out of store-adapter.ts) + `isAlterPrimaryKeyDDL`
  - packages/quereus-sync/src/sync/sync-manager-impl.ts             # local call site `rekeyOnLocalKeyChange`; `db`, `getTableKeyColumns`, `getRetiredPkKeying`, `databaseOf`
  - packages/quereus-sync/src/sync/change-applicator.ts             # `captureRetiredKeyColumns` (pre-Phase 2), `rekeyAfterReplicatedKeyChange` (Phase 3)
  - packages/quereus-sync/src/sync/sync-context.ts                  # `db?`, `getTableKeyColumns`, `getRetiredPkKeying`
  - packages/quereus-sync/src/sync/events.ts                        # `PrimaryKeyRekeyedEvent`, `onPrimaryKeyRekeyed`
  - packages/quereus-sync/src/sync/store-adapter.ts                 # imports the shared parse; retired NOTE in the decide arm; NOTE at the pk-projection site
  - packages/quereus-sync/src/metadata/tombstones.ts                # `setTombstoneBatch(..., createdAt?)`
  - packages/quereus-sync/test/sync/table-identity-strands-metadata.spec.ts   # the ticket's delete-arm `it` + a live-row (edit) arm `it`
  - packages/quereus/src/vtab/events.ts                             # `VTableSchemaChangeEvent.oldKeyColumns`
  - packages/quereus/src/core/database-events.ts                    # `DatabaseSchemaChangeEvent.oldKeyColumns` + projection
  - packages/quereus/src/vtab/alter-event-shape.ts                  # `alterEventShape(change, before?)`
  - packages/quereus/src/runtime/emit/alter-table.ts                # `runAlterPrimaryKey`: both emits carry `oldKeyColumns`
  - packages/quereus/src/runtime/emit/alter-schema-event.ts
  - packages/quereus/src/vtab/memory/module.ts                      # passes the pre-ALTER schema to `alterEventShape`
  - packages/quereus-store/src/common/store-module-alter.ts         # same
  - packages/quereus/test/alter-table-schema-events.spec.ts         # `shape()` pins the retired key
  - packages/quereus-store/test/alter-events.spec.ts                # same, both backends
  - docs/sync.md                                                    # § Tombstones (two new paragraphs), § Row identity vs. address
  - docs/sync-schema.md                                             # § Apply order `alter primary key`; the "Re-keying" paragraph under § What replicates
  - docs/usage.md, docs/module-events.md                            # the new event field; `alterEventShape(change, before)`
difficulty: hard
----

# Review: re-key sync bookkeeping when the primary key definition changes

## What was built

One pass, `rekeyTableBookkeeping` in `sync/rekey-on-pk-change.ts`, run with the post-change schema in force at the two places a key change becomes known, exactly as the ticket laid out:

- **Local**: `handleTransactionCommit` → `rekeyOnLocalKeyChange`, for a local `alter`/`table` event whose DDL parses to `alterPrimaryKey`. Staged into the transaction's own `kvBatch` in the schema loop, before any `recordDataEvent`, and every re-filed record is noted into the `StagedTransactionMetadata` overlay so a same-transaction DML event (`begin; alter primary key; update; commit`) reads the re-filed version rather than committed storage. The telemetry event fires after the batch commits.
- **Replicated**: `applyChanges` captures each table's current key columns before Phase 2 for every `alter_column` migration that parses to a key change (`captureRetiredKeyColumns`), and in `commitMetadata`, after the identity transitions and before `commitChangeMetadata`, runs the pass for the ones that actually executed (`rekeyAfterReplicatedKeyChange`), each in its own written batch.

The pass itself: one scan of the table (`select <old ∪ new key columns> as k0… from s.t` through the engine) builds old-identity → new-pk and new-identity → old-identity maps; the `cv:` scan under the generation is grouped by old identity and each live group is re-filed through the name-keyed writers (so the new identity is derived like any other write), its `cl:` entries rebuilt from each record's own `hlc`; a group whose row is gone is dropped with its entries. Tombstones project their new key from `priorRow` when present and of the current column count, else are dropped; a tombstone whose new identity a *different* live row now owns is dropped (the catalog says that key exists), and two tombstones that collide keep the newer. All puts are deferred past all deletes so a key swap cannot delete what the previous group re-filed. Re-filed tombstones keep their `createdAt` (new optional parameter on `setTombstoneBatch`).

**Design call the ticket left open — where the retired key's column names come from.** The capture runs after the engine has swapped the catalog, so nothing in sync knows the old key by then, and a sync-side "last known key" cache is unsafe (an earlier transaction's capture can lag behind a later ALTER and resolve the new schema first). So the engine's ALTER PRIMARY KEY event now names the key it retires: `oldKeyColumns` on `VTableSchemaChangeEvent` / `DatabaseSchemaChangeEvent`, set by `runAlterPrimaryKey` (both emit paths) and by `alterEventShape(change, before)` for the two emitter-backed modules (store and memory), which now take the pre-ALTER schema as an optional second argument. A module that emits without it still announces the change; sync logs that it cannot re-file. The replicated path reads the retired key from the schema oracle before Phase 2 instead (`getTableKeyColumns`). The retired key's *keying* (collation normalizers and type transforms) is re-derived from the current columns via `getRetiredPkKeying`, which is sound because ALTER PRIMARY KEY adds and drops no column.

**Phase 3 prior re-read.** Phase 1 resolves an inbound batch under the pre-change keying while the batch's own pks (recorded by the sender after its key change) are under the new one, so for a re-keyed table it never finds a local prior. After the pass, `rekeyAfterReplicatedKeyChange` re-reads `oldColumnVersion` / `oldTombstone` for every applied change on those tables so `commitChangeMetadata` deletes the prior's moved `cl:` entry (otherwise the `collectChangesSince` invariant breaks: an entry whose HLC no longer matches its record). The LWW decision is deliberately not revisited (data already written) — that is the documented race.

**Telemetry.** The ticket said "the sync-state events channel"; `SyncState` is a connection-state union with no room for counts, so this is a new typed event beside the others: `PrimaryKeyRekeyedEvent` / `onPrimaryKeyRekeyed` with `cellsRekeyed`, `rowsRekeyed`, `rowsDropped`, `tombstonesRekeyed`, `tombstonesDropped`, plus one `console.warn` per table when anything was dropped.

## Tests

- `a primary-key change between the delete and the exchange still lets the delete win on both peers` — the ticket's reproduction, verbatim. Failed before the change exactly as the ticket traced (b kept `(1, 'stale', 'x')`); passes now. Exercises the local tombstone re-key from `priorRow` on `a`, and on `b` the replicated path dropping the cell versions of a row the same batch deleted.
- `a primary-key change between a newer edit and the exchange still lets the newer edit win on both peers` — the live-row arm the first test does not reach: both hold rows 1 and 2, `b` edits row 2 (stale, in flight), `a` edits it later, `a` re-keys. Asserts `a`'s `onPrimaryKeyRekeyed` counts (6 cells, 2 rows, nothing dropped), then that both peers end on the newer value with nothing stale left on `b` to ship. Without the pass `b` ships a one-column pk to a re-keyed `a`.
- The two ALTER-event shape specs (engine fallback path, memory emitter path, store path) now pin `key(a)` / `key(id)` on the ALTER PRIMARY KEY event, so a producer that stops naming the retired key fails the cross-backend parity test.

## Known gaps and judgment calls for the reviewer

- **Not covered by a test**: a tombstone with no usable `priorRow` (dropped), the live-row collision rule, two tombstones colliding on the new key, a key *swap* (the deferred-puts ordering), `alter primary key` plus DML in one explicit transaction (the overlay notes), the relay-only skip, and the "event does not name the retired key" warning. Each is a few lines; I judged the two end-to-end arms as the tests that pay for themselves and left the rest to the reviewer's call.
- **The live-row collision rule drops the tombstone.** A tombstone whose new identity is now a live row that was a *different* row under the old key is dropped rather than re-filed, on the reasoning that under default delete-wins any tombstone at that identity would block every future inbound write to a row the catalog says exists. The pre-existing coexistence case (same old identity, delete-then-reinsert) is preserved. Worth a second opinion.
- **The warning fires in the ticket's own flow.** On the replicated path a row the same batch deletes has its cell versions dropped by the pass (the delete's cleanup would have removed them a step later), and the per-table warning says so. The message calls that expected; the reviewer may prefer it not to warn at all for `rowsDropped` alone.
- **Relay-only peers** (no engine, no schema) cannot run the pass: their records for the table stay under the old key and they log it once per key change. Documented in `docs/sync.md` § Tombstones; not filed, since it is an instance of the wire-race class the ticket scoped out, but a reviewer may see a `debt-` ticket here (a relay could re-key cell versions from their own column values when every new key column has a cell; tombstones need the column order it lacks).
- **Memory**: the pass holds one entry per live row (pk values + two identity strings) for its duration. `NOTE:` at `scanLiveRows`.
- **The table scan goes through `db.eval`** from the commit chain (local) and from Phase 3 (host-driven). Both are outside statement execution, but the reviewer should confirm there is no exec-mutex or implicit-transaction interplay I missed (the store adapter's constraints concern `applyToStore`, not reads).
- `alterEventShape` gained an optional second parameter; `docs/module-events.md` tells third-party modules to pass the pre-ALTER schema. Additive, so existing callers compile.
- `getTableKeyColumns` uses `?.` on a non-optional field because test oracles stub `{ columns }`-only schemas (same shape `getTableColumnNames` already tolerates).

## Tripwires parked

- `store-adapter.ts` `mergeColumnUpdates`, the `row[pkDef[i].index] = pk[i]` loop: `NOTE:` on the concurrent-DDL-versus-data race (a change under the old key definition reaching a re-keyed receiver), as the ticket asked. Also written up under `docs/sync.md` § Tombstones, "What a key redefinition does not cover".
- `rekey-on-pk-change.ts` `scanLiveRows`: `NOTE:` on the per-row memory of the pass.

## Validation

```
yarn tsc -b packages/quereus-sync                 # engine, store, sync — clean
yarn workspace @quereus/sync typecheck            # source + test tsconfig — clean
yarn workspace @quereus/sync test                 # 767 passing (765 before + 2)
yarn workspace @quereus/quereus lint              # eslint + test tsc — clean
yarn workspace @quereus/quereus test              # 10870 passing, 25 pending
yarn workspace @quereus/store typecheck && test   # clean; 1958 passing
yarn workspace @quereus/sync-coordinator typecheck
yarn workspace @quereus/sync-client typecheck
```

No pre-existing failures surfaced. `yarn test:store` (engine logic tests against the LevelDB store) was not run.
