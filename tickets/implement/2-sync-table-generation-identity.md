description: Give every synced table a stable identity that outlives its name, and file the sync engine's per-row conflict-tracking records under that identity instead of the table name, so renaming a table or dropping and re-creating one no longer strands or inherits the wrong history.
architecture: docs/sync.md#storage-layout
files:
  - packages/quereus-sync/src/metadata/keys.ts                 # cv:/tb:/cl: layout, parse/build, SYNC_METADATA_FORMAT_VERSION (5 → 6)
  - packages/quereus-sync/src/metadata/table-identity.ts       # NEW — tg: generation records + in-memory name↔generation map + transitions
  - packages/quereus-sync/src/metadata/column-version.ts       # stores: keep (schema, table, pk) signatures, resolve the generation inside
  - packages/quereus-sync/src/metadata/tombstones.ts
  - packages/quereus-sync/src/metadata/change-log.ts
  - packages/quereus-sync/src/metadata/index.ts
  - packages/quereus-sync/src/sync/sync-context.ts             # expose the identity store; deleteRowVersionsAndLogEntries
  - packages/quereus-sync/src/sync/sync-manager-impl.ts        # create(): load the maps; handleTransactionCommit: local create/drop/rename transitions; resolveLogEntry; pruneTombstones; repairChangeLog
  - packages/quereus-sync/src/sync/change-applicator.ts        # transitions after Phase 2 for executed replicated DDL; computeBatchTableFates comments; commitChangeMetadata ensure
  - packages/quereus-sync/src/sync/store-adapter.ts            # report which schema changes EXECUTED; retire the two stale NOTEs
  - packages/quereus-sync/src/sync/protocol.ts                 # ApplyToStoreResult gains the executed list
  - packages/quereus-sync/src/sync/snapshot-stream.ts          # sender groups by generation → name; receiver ensures per table-start; clearExistingMetadata preserve-by-name
  - packages/quereus-sync/src/sync/snapshot.ts                 # same for the non-streaming path
  - packages/quereus-sync/test/sync/table-identity-strands-metadata.spec.ts   # NEW — the reproduction below
  - packages/quereus-sync/test/metadata/keys.spec.ts           # key layout pins
  - packages/quereus-sync/test/sync/metadata-format-version.spec.ts           # pins the literal 5
  - packages/quereus-sync/test/sync/drop-recreate-batch.spec.ts               # arm B in-batch; its comments describe historyName
  - docs/sync.md                                               # § Storage Layout, § Row identity vs. address, § Metadata format version
  - docs/sync-schema.md                                        # § What replicates — the rename paragraph's stranding caveat
difficulty: hard
----

# Sync bookkeeping keyed by a stable table generation, not the table name

Sync keeps three per-row records for every synced table: a version per cell (`cv:`), a deletion marker per row (`tb:`), and an HLC-ordered index over both (`cl:`). All three are keyed by `(schema, table)` plus the row's primary-key identity (`metadata/keys.ts`). A table's name is not its identity, and three ordinary statements break the assumption:

- `alter table orders rename to orders2` leaves every record filed under `orders`. Nothing re-files them.
- `drop table orders; create table orders (...)` leaves the dropped incarnation's records in place, and the new table inherits them.
- `alter table orders alter primary key (...)` leaves every record filed under the old key values, in both the key identity and the record value. That arm is the sibling ticket `sync-rekey-bookkeeping-on-primary-key-change`, which builds on this one.

## Reproduction (verified in the fix stage)

The spec below runs on real two-peer engines. Add it FIRST; the rename case fails today and passes when this ticket lands. The control case passes today and must keep passing.

What the trace shows for the rename case: a ships `delete orders [1]` in the same batch as `rename_table orders → orders2`; b applies the rename, then diverts the delete as an unknown-table straggler because the batch leaves `orders` absent. b's stale edit was recorded under `orders` before the rename reached b, so b ships `column orders [1]` and a diverts that too. Both facts sit in quarantine under a name that never comes back: a has no row 1, b keeps it, forever.

```ts
// packages/quereus-sync/test/sync/table-identity-strands-metadata.spec.ts
/**
 * Sync bookkeeping (`cv:` / `tb:` / `cl:`) used to be filed under the table NAME, so a
 * rename stranded every record written before it under a name that no longer existed
 * (`bug-sync-metadata-keyed-by-unstable-table-identity`, arm A).
 *
 * The sequence below is an ordinary in-flight-edit race that converges WITHOUT the
 * rename (the control spec): a deletes a row while b still holds a stale edit of it,
 * then the two exchange. Delete-wins resolves it on both sides. A `rename to` between
 * a's delete and the exchange must leave the same outcome: both facts travel under the
 * table's CURRENT name and land against the table's own history.
 */

import { expect } from 'chai';
import {
	closePeer,
	collect,
	localWrite,
	makePeer,
	relayAll,
	type Peer,
} from './_peer-harness.js';

/** `orders` with a spare non-key column for the sibling ticket's primary-key change. */
const WIDE_ORDERS_DDL = 'create table orders (id integer primary key, note text, extra text) using store';

/** Two peers that each created `orders` and have reconciled those two creates. */
async function makeReconciledPair(): Promise<[Peer, Peer]> {
	const a = await makePeer('a', { createOrders: true, ordersDdl: WIDE_ORDERS_DDL });
	const b = await makePeer('b', { createOrders: true, ordersDdl: WIDE_ORDERS_DDL });
	await relayAll(a, b);
	await relayAll(b, a);
	return [a, b];
}

/**
 * The race: a seeds row 1 on both peers; b edits it (in flight); a deletes it; then
 * `betweenDeleteAndExchange` runs on a; then the two exchange both ways.
 */
async function runDeleteVsStaleEditRace(
	a: Peer,
	b: Peer,
	betweenDeleteAndExchange: () => Promise<void>,
): Promise<void> {
	await localWrite(a, "insert into orders (id, note, extra) values (1, 'seed', 'x')");
	await relayAll(a, b);
	expect(await collect(b.db, 'select note from orders where id = 1')).to.deep.equal([{ note: 'seed' }]);

	await localWrite(b, "update orders set note = 'stale' where id = 1");
	await localWrite(a, 'delete from orders where id = 1');
	await betweenDeleteAndExchange();

	await relayAll(a, b);
	await relayAll(b, a);
}

describe('sync bookkeeping follows the table across a rename', () => {
	let a: Peer;
	let b: Peer;

	beforeEach(async () => {
		[a, b] = await makeReconciledPair();
	});

	afterEach(async () => {
		await closePeer(a);
		await closePeer(b);
	});

	it('control: without a rename the delete wins on both peers', async () => {
		await runDeleteVsStaleEditRace(a, b, async () => {});

		expect(await collect(a.db, 'select id from orders'), 'a has no row 1').to.deep.equal([]);
		expect(await collect(b.db, 'select id from orders'), 'b has no row 1').to.deep.equal([]);
	});

	it('a rename between the delete and the exchange still lets the delete win on both peers', async () => {
		await runDeleteVsStaleEditRace(a, b, async () => {
			await localWrite(a, 'alter table orders rename to orders2');
		});

		expect(await collect(a.db, 'select id from orders2'), 'a has no row 1').to.deep.equal([]);
		expect(await collect(b.db, 'select id from orders2'), 'b has no row 1').to.deep.equal([]);
	});
});
```

Arm B (drop, then re-create, relayed in SEPARATE batches — the arm the original ticket verified) needs its own `it` in the same spec. `drop-recreate-batch.spec.ts` covers only the in-batch case that `computeBatchTableFates` already handles. Sequence: a deletes row 1 (tombstone at a), relays to b; a drops `orders` and re-creates it, relays; b inserts row 1 into the new incarnation, relays to a. Expected: a holds b's row. Today a's stale tombstone under `orders` blocks it under the default `allowResurrection: false`, and the row never lands.

## Design decision: identity is local to each peer; the wire stays name-addressed

Settled in the fix stage. Two options were weighed:

1. **A creator-minted identity carried on the wire**, where every change and every `create_table` names the table's id. Rejected. The dominant deployment pattern creates the same schema independently on every device (app DDL at startup; every two-peer spec in this package does exactly this through `makeSyncedPair`) and reconciles the two `create_table` migrations by definition equality. Two creators would mint two ids for one table, every change would reference an id the other side does not know, and reconciling would need an election plus a re-key of the loser's records. The wire protocol, the snapshot format and the relay-only coordinator would all change too.
2. **A local generation per peer, with the name as the shared handle on the wire.** Chosen. Each peer mints a random 128-bit generation for a `(schema, table)` the first time it files anything for it, persists the mapping, and keys `cv:`/`tb:`/`cl:` by the generation. A rename moves the mapping and touches no record. A drop retires the generation. A same-name create mints a fresh one and so cannot inherit anything. On the wire nothing changes: a change is addressed by the table's CURRENT name at extraction time (the record's generation resolves to its current name), and the receiver resolves that name to its own current generation. This is how DDL already replicates (`rename_table` carries old and new names; `decideRenameTable` decides against the catalog), so peers keep converging by the rule they use today.

What option 2 does not solve, and `docs/sync.md` must say so: a change recorded against one incarnation on peer X and applied to a different same-named incarnation on peer Y (X writes to `orders` while Y has already dropped and re-created it) lands in Y's new table. That is a concurrent-DDL-versus-data race, the same class as the rename collision that already throws, and it is pre-existing. Not in scope.

## Shape

**Generation record.** New prefix `tg:` in `keys.ts`: key `tg:{n}:{schema}{n}:{table}` (length-prefixed like every other name component), value `{ generation, mintedAt }`. `generation` is 16 random bytes rendered base64url; reuse the random-bytes source behind `generateSiteId` and `toBase64Url` in `clock/site.ts`. The record count is bounded by the table count, so `SyncManagerImpl.create` loads the whole prefix into two in-memory maps (name → generation, generation → name), and every later transition writes the record and updates both maps.

**Key layout.** `SYNC_METADATA_FORMAT_VERSION` goes 5 → 6. Say what changed in the version's doc comment and in `docs/sync.md` § Metadata format version. The `fv:` gate already refuses to open a store on an older layout, so the only migration is a re-bootstrap from a peer snapshot; that is the release-notes line, and both docs must state it plainly.

```
cv:{n}:{generation}{n}:{identity}{n}:{column}
tb:{n}:{generation}{n}:{identity}
cl:{hlc}{type}{n}:{generation}{n}:{identity}[{n}:{column}]
tg:{n}:{schema}{n}:{table}
```

`qt:` (quarantine), `bl:` (basis lifecycle) and `sm:` (migrations) stay name-keyed by design: they describe names, not tables. A quarantined change is for a name the receiver does not have, and the DDL stream is the thing that moves names.

**The metadata stores keep their signatures.** `ColumnVersionStore`, `TombstoneStore` and `ChangeLogStore` already take a `PkKeyingResolver` and encode the pk identity internally. Give them a sibling `TableIdentityResolver` (`(schema, table) => generation`, synchronous, throws if the table has no generation yet) and keep every public method `(schemaName, tableName, pk, …)`. The call sites across `sync/` (45 by count) and the test files stay untouched. The `parse*Key` functions return `{ generation, identity, column? }` instead of `{ schema, table, … }`; the few consumers that need a name (`resolveLogEntry`, `pruneTombstones`, `repairChangeLog`, the snapshot sender's table grouping, `clearExistingMetadata`) call `nameOf(generation)` and treat `undefined` as a retired generation's leftover: skip it, and for the change log delete the orphan entry.

**`TableIdentityStore`** in `metadata/table-identity.ts`: one class, with every write staged into a caller-supplied `WriteBatch` so it commits atomically with the records that depend on it.

- `ensure(schema, table, batch)` mints if absent and returns the generation. Lazy minting is what makes tables that existed before sync attached, and tables created by replicated DDL, just work: the first record filed for a name mints its generation.
- `retire(schema, table, batch)` deletes the record and drops the name from both maps; the generation's records become orphans. Reclaiming them is the sibling ticket `sync-retire-dropped-table-bookkeeping`; this ticket only has to make them unreachable, which the maps already do.
- `move(schema, from, to, batch)` is the rename. The record moves to the new name; the generation does not change.
- `generationOf(schema, table)` and `nameOf(generation)` are synchronous map reads.

**Who drives the transitions.** Two call sites, one store:

- Local DDL. `handleTransactionCommit` already walks the transaction's local schema events. A `create` of a `table` ensures; a `drop` of a `table` retires; an `alter` of a `table` with `oldObjectName` moves. All three stage into the same `kvBatch` as the migration and data records, ahead of `recordDataEvent`, so a `drop t; create t; insert into t` transaction files its rows under the NEW generation.
- Replicated DDL. `handleTransactionCommit` filters out remote-flagged events (it must, or they would echo), and the store adapter's `applyToStore` runs inside the admission unit BEFORE `commitChangeMetadata`. So the applicator drives these: extend `ApplyToStoreResult` with the list of schema changes the adapter actually EXECUTED (`decideSchemaChange` returned `'execute'` and the DDL ran; not the `already-applied` ones, whose tables and bookkeeping survive untouched). In `admitGroup`'s `commitMetadata`, apply the transitions for that list (create → ensure, drop → retire, rename → move) in a batch written before `commitChangeMetadata` files anything. A deployment with no `applyToStore` at all (a relay-only coordinator, no catalog) treats every admitted create/drop/rename migration as executed. The snapshot receivers replay DDL through the same adapter, so they get the same report.
- `evictExpiredBasisTables` drops through the engine (`dropLocalTable`), whose drop event is local, so it takes the local path with no extra wiring. `basis-eviction.spec.ts` is the check.

**Every record-writing path ensures first.** `handleTransactionCommit` (per table named by the transaction's events), `commitChangeMetadata` (per table in the resolved batch), and both snapshot receivers (per `table-start`, after the DDL chunks have replayed) call `ensure` into their batch before staging any `cv:`/`tb:`/`cl:` record, so the synchronous resolver inside the stores never meets an unknown table.

**`computeBatchTableFates` keeps its logic.** Phase 1 resolves BEFORE Phase 2's DDL executes, so a batch that drops and re-creates a name must still resolve that name's rows read-free: the current generation's tombstones belong to the incarnation the batch is about to destroy. `historyName !== key` already means exactly "this name's generation is replaced by this batch". Reword the `BatchTableFate.historyName` doc comment and the long comment at the `freshLocalTable` site to say so, and retire the `NOTE`s there that point at `bug-sync-rename-and-pk-change-strand-crdt-metadata` and `bug-sync-recreated-table-inherits-dropped-table-metadata` (both superseded by this chain). Same for the two in `store-adapter.ts`: `decideRenameTable`'s doc comment, and the `alterPrimaryKey` arm, which becomes a pointer to the sibling pk ticket until that lands.

**Snapshot sender.** `streamSnapshotChunks` groups the `cv:` scan by parsed `(schema, table)`; it now groups by generation and resolves each to its current name for the chunk headers, skipping retired generations. The per-table scan bounds (`buildTableColumnVersionScanBounds`, `buildTombstoneScanBounds`) take a generation. `SnapshotCheckpoint.completedTables` stays a list of names; resume maps names to generations when it builds the preserve set for `clearExistingMetadata`.

**Ordering hazard to close.** Local capture runs on the async commit chain (`enqueueTransactionCommit`), so a local rename can commit, and an inbound batch for the NEW name can resolve and lazily mint a second generation for it, before the chain has moved the first. `applyChanges` must `await ctx.whenCommitsSettled()` before Phase 1 and again before the transitions in `commitMetadata` (the chain tail is cheap when idle). Put a `NOTE:` at the await saying what it orders.

**Docs.** `docs/sync.md` § Storage Layout: table rows for `tg:` and the three re-keyed prefixes; a short "Table identity" subsection after "Row identity vs. address" stating the local-generation decision, the name-on-the-wire rule, and the concurrent-DDL race it leaves; § Metadata format version: 6 and what changed. `docs/sync-schema.md` § What replicates: the `RENAME TO` paragraph's "a rename moves the table but not its records" caveat becomes "the bookkeeping follows the table".

## TODO

- [ ] Add the reproduction spec above as `test/sync/table-identity-strands-metadata.spec.ts` (control + rename), plus the cross-relay drop/re-create `it` for arm B; confirm the two non-control cases fail before any source change.
- [ ] `keys.ts`: `tg:` prefix, builders and scan bounds; re-key `cv:`/`tb:`/`cl:` by generation; parse functions return `generation`; per-table scan bounds take a generation; bump `SYNC_METADATA_FORMAT_VERSION` to 6 with the layout note; update `keys.spec.ts` and `metadata-format-version.spec.ts`.
- [ ] `metadata/table-identity.ts`: `TableIdentityStore` with `load`, `ensure`, `retire`, `move`, `generationOf`, `nameOf`; export from `metadata/index.ts`.
- [ ] Wire a `TableIdentityResolver` into the three stores next to the `PkKeyingResolver`; fix the `parse*Key` consumers (`resolveLogEntry`, `pruneTombstones`, `repairChangeLog`, the snapshot sender grouping, `clearExistingMetadata`, and `deleteRowVersionsAndLogEntries` if it parses) to go through `nameOf` and skip or clean retired generations.
- [ ] `SyncManagerImpl.create`: load the maps; expose the store on `SyncContext`.
- [ ] `handleTransactionCommit`: local create/drop/rename transitions and per-table `ensure`, staged before the data records.
- [ ] `ApplyToStoreResult` gains the executed-schema-change list, filled by the store adapter; the applicator applies the transitions in `commitMetadata` before `commitChangeMetadata`; relay-only fallback; both snapshot receivers `ensure` per `table-start`.
- [ ] `await whenCommitsSettled()` at the two points in `applyChanges`, with the `NOTE:`.
- [ ] Retire the four stale `NOTE`s naming the superseded backlog slugs; reword the `historyName` comments.
- [ ] Docs as listed; state the breaking key-layout change for release notes.
- [ ] `yarn workspace @quereus/quereus-sync test`, `yarn typecheck`, and the coordinator's tests under `packages/sync-coordinator`, since it consumes `ApplyToStoreResult`.
