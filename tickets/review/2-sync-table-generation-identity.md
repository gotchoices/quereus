description: Give every synced table a stable identity that outlives its name, and file the sync engine's per-row conflict-tracking records under that identity instead of the table name, so renaming a table or dropping and re-creating one no longer strands or inherits the wrong history.
architecture: docs/sync.md#storage-layout
files:
  - packages/quereus-sync/src/metadata/table-identity.ts       # NEW — TableIdentityStore (tg: records + name↔generation maps), applySchemaChangeTransitions
  - packages/quereus-sync/src/metadata/keys.ts                 # tg: prefix/builders/parser; cv:/tb:/cl: keyed by generation; SYNC_METADATA_FORMAT_VERSION 5 → 6
  - packages/quereus-sync/src/metadata/column-version.ts       # stores take a TableIdentityResolver; batch writes ensure the generation themselves
  - packages/quereus-sync/src/metadata/tombstones.ts
  - packages/quereus-sync/src/metadata/change-log.ts           # ChangeLogEntry carries generation, not schema/table
  - packages/quereus-sync/src/sync/sync-context.ts             # tableIdentity + whenCommitsSettled on the context
  - packages/quereus-sync/src/sync/protocol.ts                 # ApplyToStoreResult.executedSchemaChanges (optional)
  - packages/quereus-sync/src/sync/admission.ts                # applyDataToStore returns the result; commitMetadata(executed); executedSchemaChanges helper
  - packages/quereus-sync/src/sync/store-adapter.ts            # reports executed DDL; the two stale NOTEs retired
  - packages/quereus-sync/src/sync/change-applicator.ts        # commit-chain drains, transitions before commitChangeMetadata, historyName comments reworded
  - packages/quereus-sync/src/sync/sync-manager-impl.ts        # load, local transitions, resolveLogEntry / collectAllChanges / pruneTombstones / repairChangeLog by generation
  - packages/quereus-sync/src/sync/snapshot-stream.ts          # sender groups by generation → current name, sorted by name; receiver applies transitions per flush; preserve-by-name → generation
  - packages/quereus-sync/src/sync/snapshot.ts                 # same for the non-streaming path
  - packages/quereus-sync/test/sync/table-identity-strands-metadata.spec.ts   # NEW — control + rename + cross-batch drop/re-create
  - packages/quereus-sync/test/metadata/keys.spec.ts           # rewritten for the generation-keyed layout + tg: pins
  - packages/quereus-sync/test/sync/metadata-format-version.spec.ts           # pins 6, refuses 5
  - docs/sync.md                                               # § Storage Layout rows, new § Table identity, § Metadata format version (6 + release note)
  - docs/sync-schema.md                                        # § What replicates: rename bullets and caveats rewritten
difficulty: hard
----

# Review: sync bookkeeping keyed by a stable table generation

Every per-row sync record (`cv:` cell version, `tb:` tombstone, `cl:` change-log entry) is now filed under a per-peer **table generation** instead of the table name. A new `tg:` record maps each `(schema, table)` name to its generation; a rename moves that one record, a drop retires the generation, and a same-name re-create mints a fresh one. On the wire nothing changed: a change is addressed by the table's current name at extraction time and the receiver resolves that name to its own generation. `SYNC_METADATA_FORMAT_VERSION` is now 6; a replica on 5 refuses to open and must re-bootstrap from a peer snapshot (release note in `docs/sync.md` § Metadata format version).

## Use cases to verify

- **Rename with facts in flight.** Peer a deletes a row, renames the table, then exchanges with peer b that still holds a stale edit of that row. Both peers end with no row 1 under the new name. (`table-identity-strands-metadata.spec.ts`, rename case; control case without the rename must behave identically.)
- **Drop and re-create across separate batches.** a deletes row 1 and relays; a drops and re-creates the table and relays; b inserts row 1 into the new incarnation and relays. a now holds b's row — the dropped incarnation's tombstone cannot block it. (Same spec, second describe.)
- **In-batch drop/re-create, swaps, rename-away-and-back.** `drop-recreate-batch.spec.ts` is unchanged in substance; `computeBatchTableFates` keeps its logic, only its comments were reworded to describe generations.
- **Dropped table's facts no longer ship.** The origin retires the generation on `drop table`, so a delta pull carries only the `drop_table` DDL and none of the dropped incarnation's rows. Two specs that previously asserted the receiver *diverted* those rows now assert nothing ships and nothing is quarantined; the receiver-side "rows for a name the batch drops divert" rule is still pinned over a synthesized batch in `unknown-table-disposition.spec.ts` ('diverts changes to a table the batch drops').
- **Undecidable rename.** Because every fact ships under the current name, a receiver that cannot decide a `rename_table` (no `fromTable`) now diverts the pre-rename rows as well; its old table is not resurrected from them. `schema-alter-replication.spec.ts` was rewritten to that expectation and the caveat is in `docs/sync-schema.md`.
- **Snapshots.** Sender groups records by generation, ships each under its current name, skips retired generations, and streams tables sorted by name (generation order is random per peer, which broke the resume spec's table-order assumption until the sort was added). Receiver applies the executed DDL's transitions per flush and maps a checkpoint's `completedTables` names to generations for the resumed clear.
- **Local DDL in one transaction.** `drop t; create t; insert into t` files its rows under the new generation: transitions are staged into the commit batch ahead of the data records.

## Deviations from the implement ticket, each deliberate

- **The stores ensure the generation themselves.** The ticket had every record-writing path call `ensure` before staging records. Instead every batch write method (`setColumnVersionBatch`, `setTombstoneBatch`, `recordColumnChangeBatch`, `recordDeletionBatch`) calls `tables.ensure(schema, table, batch)` into the caller's batch, and the standalone (non-batch) write methods wrap themselves in a one-off batch. Reads return nothing for a name with no generation. This makes "every record-writing path ensures first" true by construction in one place instead of at five call sites. The pk keying resolver still runs before the generation lookup, so an out-of-basis table still throws there as before.
- **`ApplyToStoreResult.executedSchemaChanges` is optional.** Absent ⇒ every admitted `create_table`/`drop_table`/`rename_table` is treated as executed. That one rule covers the relay-only deployment (no `applyToStore`) and the sixteen test stubs that return `{ errors: [] }` without reporting; the store adapter always fills it. A third-party adapter that does not report gets the relay-only rule, which the doc comment states.
- **`TableIdentityStore.move` throws on an occupied target** (the same yes/yes collision `decideRenameTable` refuses) and is a no-op when the source name has no generation. On the local path a throw is caught by `handleTransactionCommit`'s top-level catch, which drops that transaction's capture and emits an error sync-state event — the pre-existing failure shape for any capture error.
- **`drainHeldChanges` also drains the commit chain** before resolving, not only `applyChanges`: a drain reads and files identity-keyed metadata too.
- **`clearExistingMetadata` leaves `tg:` records in place** on a snapshot apply; the rewritten records file under the same generations and a table the snapshot's DDL drops is retired by that DDL's transition.

## Tests

| Test | Verifies |
|---|---|
| `table-identity-strands-metadata.spec.ts` — control | the delete-vs-stale-edit race converges without a rename (passed before and after) |
| same — rename case | arm A: a rename between the delete and the exchange leaves both peers without the row (failed before, passes now) |
| same — drop/re-create across batches | arm B: a row written into a re-created table is not blocked by the dropped incarnation's tombstone (failed before, passes now) |
| `keys.spec.ts` (rewritten) | `tg:` round-trip and surrogate guard; `cv:`/`tb:`/`cl:` parse by generation; a version-5 name-keyed key does not parse as version 6; per-generation scan bounds are disjoint |
| `metadata-format-version.spec.ts` | the literal 6; a replica stamped 5 is refused with the re-bootstrap message |
| `change-log.spec.ts` | an entry carries the generation the first write minted |

Updated, not added: `drop-recreate-batch.spec.ts` (trailing drop ships no rows), `schema-ddl-replication.spec.ts` (same), `schema-alter-replication.spec.ts` (undecidable rename diverts pre-rename rows), `colon-table-name.spec.ts` / `dotted-table-name.spec.ts` (seed through `ensure`), `unknown-table-disposition.spec.ts` (no generation minted ⇒ no records), `store-adapter-seam.spec.ts` and `sync-manager.spec.ts` (resolve a parsed key's generation to a name), the three store specs (constructor takes the identity store).

## Validation

```
yarn workspace @quereus/sync test            # 764 passing
yarn workspace @quereus/sync typecheck       # clean (source + test tsconfig)
yarn workspace @quereus/sync build
yarn workspace @quereus/sync-coordinator typecheck && test   # clean; 134 passing
yarn workspace @quereus/sync-client typecheck
yarn workspace @quereus/quoomb-web typecheck
```

`yarn lint` was not run: only `packages/quereus` has a real lint and nothing there changed.

## Known gaps and things worth probing

- **Snapshot receivers do not drain the commit chain** before filing metadata (only `applyChanges` and `drainHeldChanges` do). A local rename committing during a bootstrap is already outside the supported window (`feat-sync-bootstrap-write-gate` in backlog), so this was left alone; a reviewer may disagree.
- **Read-free resolution for a table arriving by rename is still read-free.** `fate.historyName` now names where that table's history is readable (its old name, in basis, keying resolvable), so Phase 1 could resolve those rows against the moved table's own tombstones instead of skipping every read. Left as a `NOTE:` at the `freshLocalTable` site rather than widening the ticket; the behaviour is the pre-existing one.
- **Orphan records of a retired generation stay on disk** and are read by every full `cv:`/`tb:` scan until `sync-retire-dropped-table-bookkeeping` lands; their `cl:` entries are removed by the next `repairChangeLog` pass (doc comment updated to say so).
- **Case of names.** The maps key `(schema, table)` verbatim, exactly as the old name-keyed records did; the engine registers one canonical spelling per table and every emit site uses it, so this matches the prior behaviour, but it was not separately tested.
- **Relay-only fallback with a partially reporting adapter.** If an adapter reports `executedSchemaChanges` on some calls and omits it on others, the omitted calls treat everything as executed. Only the shipped adapter exists and it always reports.
- **The `move` collision throw on the apply path** aborts the admission unit's metadata commit after Phase 2's DDL already ran — the same shape as a `decideRenameTable` collision, but reached one step later. Not reproduced; reasoning only.

## Tripwires parked

- `change-applicator.ts`, the `await ctx.whenCommitsSettled()` before Phase 1a: `NOTE:` on what it orders and why a second drain precedes the identity transitions.
- `change-applicator.ts`, the `freshLocalTable` site: `NOTE:` on narrowing read-free resolution for a renamed-in table via `historyName`.
- `store-adapter.ts`, the `alterPrimaryKey` arm: `NOTE:` that the row component of the keys is still re-keyed by the sibling ticket `sync-rekey-bookkeeping-on-primary-key-change`.
