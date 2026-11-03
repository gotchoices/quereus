description: When a synced table's primary key definition changes, re-file its conflict-tracking records under each row's new key so earlier deletions and edits still count against later writes from other devices.
prereq: sync-table-generation-identity
architecture: docs/sync.md#row-identity-vs-address
files:
  - packages/quereus-sync/src/sync/rekey-on-pk-change.ts            # the pass; takes old AND new key columns; committed read; `reportRekeyOutcome`
  - packages/quereus-sync/src/sync/migration-ddl.ts                 # `parseMigrationDDL`, `alterPrimaryKeyColumns` (the statement's new key)
  - packages/quereus-sync/src/sync/sync-manager-impl.ts             # `rekeyOnLocalKeyChange`; `getPkKeyingOf`, `getTableKeyColumns`, `db`
  - packages/quereus-sync/src/sync/change-applicator.ts             # `captureRetiredKeyColumns`, `rekeyAfterReplicatedKeyChange` (one pass per executed statement)
  - packages/quereus-sync/src/sync/sync-context.ts                  # `db?`, `getTableKeyColumns`, `getPkKeyingOf`
  - packages/quereus-sync/src/sync/events.ts                        # `PrimaryKeyRekeyedEvent`, `onPrimaryKeyRekeyed`
  - packages/quereus-sync/src/sync/store-adapter.ts                 # NOTE at the pk-projection site
  - packages/quereus-sync/src/metadata/tombstones.ts                # `setTombstoneBatch(..., createdAt?)`
  - packages/quereus-sync/test/sync/table-identity-strands-metadata.spec.ts   # delete arm, live-row arm, back-to-back key changes
  - packages/quereus/src/vtab/events.ts                             # `VTableSchemaChangeEvent.oldKeyColumns`
  - packages/quereus/src/core/database-events.ts
  - packages/quereus/src/vtab/alter-event-shape.ts                  # `alterEventShape(change, before?)`
  - packages/quereus/src/runtime/emit/alter-table.ts
  - packages/quereus/src/vtab/memory/module.ts
  - packages/quereus-store/src/common/store-module-alter.ts
  - docs/sync.md, docs/sync-schema.md, docs/usage.md, docs/module-events.md
difficulty: hard
----

# Complete: re-key sync bookkeeping when the primary key definition changes

## What landed

One pass, `rekeyTableBookkeeping` in `sync/rekey-on-pk-change.ts`, re-files a table's `cv:` / `tb:` / `cl:` records from the key they were filed under to the key an `alter table … alter primary key (…)` statement installed. It runs at both places a key change becomes known: the local commit capture (staged into the transaction's own batch ahead of its data records, noted into the read-your-own-writes overlay) and the replicated apply (Phase 3, one pass per executed `alter primary key` statement, each in its own batch, before the batch's own metadata is filed). Live rows get their new key from one scan of the table matched to records by old identity; deleted rows get it from their tombstone's before-image. The engine's ALTER PRIMARY KEY event now names the retired key (`oldKeyColumns`), and `alterEventShape(change, before)` lets emitter-backed modules do the same. Outcomes land on `onPrimaryKeyRekeyed`. Implement commit: `ticket(implement): sync-rekey-bookkeeping-on-primary-key-change`.

## Review findings

**Read first:** the implement diff in full, then every file it touched, then the docs it changed. Ran the sync package's typecheck (source and tests) and tests, the sync-coordinator, sync-client and store typechecks, and the engine lint. All pass (sync: 768 passing, 767 before this review plus one). The engine and store test suites were not re-run: this review changed no file in those packages, and the implement handoff ran them clean at the same engine SHA.

**Major, fixed inline (with a reproduction test):** the pass took its *target* key from the current catalog instead of from the statement. The commit capture runs on a chain that lags the engine, so when a second `alter primary key` commits before the first change's capture runs, the first pass re-filed the records to the *second* key, and the second pass then looked for them under the key the first statement installed, found nothing there, and dropped every row group (it cannot tell a moved record from a deleted row). Reproduced with the two statements committed back-to-back under a held capture: the second pass reported both rows dropped. The fix makes the pass re-file exactly the transition its statement made — `alterPrimaryKeyColumns(ddl)` reads the new key from the statement (replacing `isAlterPrimaryKeyDDL`), `rekeyTableBookkeeping` takes both key column lists, `getPkKeyingOf` (renamed from `getRetiredPkKeying`) derives either key's keying from the current columns, and the replicated path runs one pass per executed statement in order, each from the key the previous one installed. The new test `two primary-key changes committed before the first capture runs re-file in sequence on both peers` holds the capture through a private entry point (nothing public delays it; the comment says why), checks the per-pass counts on both the local and the replicated path, and checks that every change-log record is addressed by the final two-column key. It fails on the catalog-derived key (verified by temporarily restoring it) and passes on the statement-derived one.

**Minor, fixed inline:**
- The table scan now runs as a committed read (`readConcurrency: 'committed'`), so it neither joins nor waits on a statement the host may be running; the key change it follows has committed, and Phase 3 drains the commit chain from inside the host's apply call.
- The per-table warning no longer fires for dropped row groups alone. A row the table no longer holds was deleted, and that delete's own tombstone protects it; only a dropped tombstone is a lost protection. The handoff flagged this and I agreed. The event still carries `rowsDropped`.
- Key column names from the statement are mapped to the catalog's spelling before the scan is built, so a statement spelling a column in another case cannot change the projection.
- A replicated `alter primary key` whose retired key was not captured (the same batch created or renamed the table first) now warns instead of silently skipping the pass.

**Judgment calls from the handoff, reviewed and kept:**
- Dropping a tombstone whose new identity now belongs to a *different* live row: correct under delete-wins, since keeping it would block every future inbound write to a row the catalog says exists; the delete-then-reinsert coexistence under one old identity is preserved. No change.
- The relay-only skip, the overlay notes, the `?.` on `primaryKeyDefinition` for stub oracles, the additive `alterEventShape` parameter: all as described, nothing further.
- The implementer's two end-to-end tests stay; neither restates the implementation. The engine and store `shape()` pins of the retired key stay: they guard a cross-backend contract that a third producer could silently drop.

**Tripwires parked (not filed):**
- `rekey-on-pk-change.ts` `scanLiveRows`, second `NOTE:`: the pass reads the table as it is *now*, not as the key change left it, and the capture derives every keying from the *current* catalog (its DML records are filed the same way, a pre-existing property of the capture, not of this ticket). Both converge for a delete or a key-column edit that slips in between; the one residual is a collation-sensitive key column racing the capture, where the identity written for the new pk follows the catalog's keying rather than the statement's. Conditional on a same-peer write landing in the capture's lag window during a key change. If a key change ever has to be safe against that, carry the table's schema on the commit batch and derive every keying from it.
- `change-applicator.ts` `captureRetiredKeyColumns`: a batch that renames a table and then redefines its key looks the retired key up under the new name, which the catalog does not have yet, so the pass does not run and the warning in `rekeyAfterReplicatedKeyChange` says so. A single explicit transaction doing both is the only way to produce that batch. If it shows up, resolve the retired key through the batch's rename simulation (`computeBatchTableFates` already knows the old name).
- Kept from the implement stage: the per-row memory `NOTE:` at `scanLiveRows`, and the concurrent-DDL-versus-data `NOTE:` at the pk-projection site in `store-adapter.ts` with its write-up in `docs/sync.md` § Tombstones.

**Not filed, with reasons:** no ticket for the relay-only skip (an instance of the wire-race class the original ticket scoped out, and a relay has no column order to project a tombstone with). No ticket for the rename-plus-rekey batch or the capture-lag residual: both are conditional on a window no current anchor requires closing, and each now has a site that says what to do. No `debt-` ticket for file size: `change-applicator.ts` (1363 lines) and `sync-manager-impl.ts` (1749 lines, `wc -l`) were large before this ticket, and this ticket added one bounded function to each; a split is not this ticket's evidence to file on.

**Docs:** `docs/sync.md` § Tombstones now says the pass re-files the transition the statement made and why the catalog's current key is not the target; `docs/sync-schema.md`, `docs/usage.md` and `docs/module-events.md` were read against the final code and needed no further change.

## Validation

```
yarn workspace @quereus/sync typecheck            # source + test tsconfig — clean
yarn workspace @quereus/sync test                 # 768 passing
yarn workspace @quereus/sync-coordinator typecheck
yarn workspace @quereus/sync-client typecheck
yarn workspace @quereus/store typecheck
yarn workspace @quereus/quereus lint              # eslint + test tsc — clean
```

No pre-existing failures surfaced.
