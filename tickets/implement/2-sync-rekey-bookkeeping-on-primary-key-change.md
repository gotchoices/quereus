description: When a synced table's primary key definition changes, re-file its conflict-tracking records under each row's new key so earlier deletions and edits still count against later writes from other devices.
prereq: sync-table-generation-identity
architecture: docs/sync.md#row-identity-vs-address
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts        # handleTransactionCommit: the local alter event; needs the Database handle create() already receives
  - packages/quereus-sync/src/sync/change-applicator.ts        # replicated alter: after Phase 2, from the executed list the prereq added
  - packages/quereus-sync/src/sync/store-adapter.ts            # parseMigrationDDL / the alterPrimaryKey decide arm and its NOTE
  - packages/quereus-sync/src/metadata/column-version.ts       # per-generation enumeration, record value carries pk
  - packages/quereus-sync/src/metadata/tombstones.ts           # Tombstone.priorRow is the only source of a deleted row's new key
  - packages/quereus-sync/src/metadata/change-log.ts           # cl: keys are rebuilt from each record's own hlc — no scan needed
  - packages/quereus-sync/src/sync/rekey-on-pk-change.ts       # NEW — the re-key pass, shared by both call sites
  - packages/quereus/src/runtime/emit/alter-table.ts           # runAlterPrimaryKey: what the engine emits (one alter event, no per-row events)
  - packages/quereus-sync/test/sync/table-identity-strands-metadata.spec.ts   # add the pk-change `it` from the fix stage (below)
  - docs/sync.md                                               # § Tombstones ("A primary-key change tombstones the old identity" is about row moves, not key redefinition — add the redefinition paragraph), § Row identity vs. address
  - docs/sync-schema.md                                        # § Apply order: the `alter primary key` paragraph
difficulty: hard
----

# Re-key sync bookkeeping when the primary key definition changes

With `sync-table-generation-identity` landed, the table component of every `cv:`/`tb:`/`cl:` key survives a primary-key change, but the row component does not: each record is filed under the pk IDENTITY (`encodePkIdentity` over the key columns in force when it was written) and carries the raw pk VALUES in its value. `alter table t alter primary key (…)` changes which columns make the key, so from the next write onward every existing record is unreachable (a lookup by the new key finds nothing) and every fact extracted from it is shipped addressed by a key the receiver no longer uses.

The engine re-keys the table in place (store and memory modules both have a native `alterPrimaryKey`; the shadow-table rebuild path suppresses its scaffolding events) and emits ONE `alter`/`table` schema event carrying the statement's DDL. No per-row event is emitted for existing rows, so sync sees nothing to re-file by. `rekeyBatchedDataEvents` in `database-events.ts` handles only the events of the SAME transaction.

## Reproduction (verified in the fix stage)

Add this `it` to the `describe` in `table-identity-strands-metadata.spec.ts` (the spec and its `runDeleteVsStaleEditRace` helper are in the prereq ticket; `WIDE_ORDERS_DDL` there carries the spare `extra` column this needs). It fails today and passes when this ticket lands.

```ts
	it('a primary-key change between the delete and the exchange still lets the delete win on both peers', async () => {
		await runDeleteVsStaleEditRace(a, b, async () => {
			await localWrite(a, 'alter table orders alter primary key (id, extra)');
		});

		expect(await collect(a.db, 'select id from orders'), 'a has no row 1').to.deep.equal([]);
		expect(await collect(b.db, 'select id from orders'), 'b has no row 1').to.deep.equal([]);
	});
```

What the trace shows today: a ships `delete orders [1]` (the tombstone's stored pk, under the OLD key) together with the `alter_column` migration. b applies the DDL first (re-keys to `(id, extra)`), then the delete: `readRowByPk([1])` under a two-column key finds nothing, so the store deletes nothing. Phase 3 then files the tombstone under b's NEW keying of `[1]`, which happens to coincide with the identity of b's stale edit, and `deleteRowVersionsAndLogEntries` wipes that edit's record. End state: b's table holds `(1, 'stale', 'x')`, b's metadata says the row is deleted, and b has nothing left to ship. a has no row. A ghost row that no later sync can remove.

## Shape

One pass, `rekeyTableBookkeeping(ctx, db, schema, table, batch)` in a new `sync/rekey-on-pk-change.ts`, run with the post-change schema in force, at two call sites:

- Local: `handleTransactionCommit`, on an `alter`/`table` event whose DDL parses to an `alterPrimaryKey` action (the engine's parser, as `store-adapter.ts`'s `parseMigrationDDL` already does; move or export that helper rather than duplicating it). Stage into the transaction's `kvBatch` BEFORE `recordDataEvent`, so the transaction's own batched events (already re-keyed by the engine) overwrite re-filed records rather than the reverse.
- Replicated: the applicator, from the executed-schema-change list the prereq added, when an executed `alter_column` parses to `alterPrimaryKey`. Run before `commitChangeMetadata`, same reason.

The pass itself, per record under the table's generation:

- **Cell versions.** Group the `cv:` scan by old identity (records of one row are contiguous under the row prefix). For each row, read the live row from the table through `db` by the OLD pk values stored in the record (`select … where <old key columns> = ?`; the manager's `create()` already receives the `Database`, keep it on the instance) and project the NEW key from it. Rewrite each cell record under the new identity with the new pk in its value, and move its `cl:` entry: the old entry's key is reconstructible from the record's own `hlc` (`buildChangeLogKey(hlc, 'column', generation, oldIdentity, column)`), so no change-log scan is needed. A row the table no longer holds (deleted between the records being written and now, which the delete's own cleanup should already have removed) is dropped with a warning count.
- **Tombstones.** A deleted row cannot be read back, so the only source of its new key is `Tombstone.priorRow`, present when the delete carried the engine's `oldRow` (local deletes; relayed deletes keep whatever the origin shipped). Re-key the tombstone and its `delete` change-log entry from `priorRow` when it is present and its length matches the current column count (a column added or dropped since the delete shifts the layout, and a wrong projection is worse than none). Otherwise delete the tombstone and its change-log entry outright, and warn once per table with the count: those rows lose delete-wins protection against a stale write from a peer, which is the honest cost of a key redefinition.
- Count what was re-filed and dropped and emit it on the sync-state events channel so an operator can see a key change's cost.

Both the old and the new keying are needed in the pass: the old identity is read straight from the key (never recomputed), the new identity is `encodePkIdentity` under the table's current keying.

**What this does not cover, and must be stated in `docs/sync.md`:** a change already on the wire, or recorded by a peer that has not yet applied the key change, carries pk values under the old definition and reaches a re-keyed receiver that cannot address a row by them. The receiver has no way to tell which key definition the sender used. That is the concurrent-DDL-versus-data race the prereq ticket also leaves; a change that carried the sender's schema version for the table (the `sm:` version counters exist) would make it detectable. Record it as a `NOTE:` at the `mergeColumnUpdates` pk-projection site in `store-adapter.ts` (the `row[pkDef[i].index] = pk[i]` loop), not as a ticket.

## TODO

- [ ] Add the pk-change `it` to the spec; confirm it fails before the source change.
- [ ] `sync/rekey-on-pk-change.ts`: the pass as described; share the DDL parse helper with `store-adapter.ts`.
- [ ] Local call site in `handleTransactionCommit`; keep the `Database` handle on the manager.
- [ ] Replicated call site in the applicator from the executed list; retire the `NOTE` in the `alterPrimaryKey` decide arm.
- [ ] Telemetry counts on the sync-state events; the `NOTE:` at the pk-projection site.
- [ ] Docs: `docs/sync.md` § Tombstones and § Row identity vs. address; `docs/sync-schema.md` § Apply order's `alter primary key` paragraph.
- [ ] `yarn workspace @quereus/quereus-sync test`, `yarn typecheck`.
