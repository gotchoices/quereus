/**
 * Integration tests for the store adapter's seam wiring: inbound sync changes
 * applied through `StoreTable.applyExternalRowChanges` (table-owned keying +
 * secondary-index maintenance) and reported through
 * `Database.ingestExternalRowChanges` (materialized-view maintenance,
 * `Database.watch` capture, opt-in parent-side FK actions).
 *
 * The headline gap this closes: a covering MV (or watch subscription) over a
 * synced table now converges on inbound apply — previously the adapter wrote
 * raw KV bytes and nothing downstream ever learned of the change.
 */

import { expect } from 'chai';
import { Database, type ChangeScope, type SqlValue, type TableSchema, type WatchEvent } from '@quereus/quereus';
import {
	StoreModule,
	StoreEventEmitter,
	InMemoryKVStore,
	buildFullScanBounds,
	type DataChangeEvent,
	type KVStoreProvider,
} from '@quereus/store';
import { createStoreAdapter, type SyncStoreAdapterOptions } from '../../src/sync/store-adapter.js';
import type { ApplyToStoreCallback, DataChangeToApply, Snapshot, SnapshotChunk } from '../../src/sync/protocol.js';
import { SyncManagerImpl } from '../../src/sync/sync-manager-impl.js';
import { SyncEventEmitterImpl, type SyncState } from '../../src/sync/events.js';
import { DEFAULT_SYNC_CONFIG } from '../../src/sync/protocol.js';
import { generateSiteId } from '../../src/clock/site.js';
import { HLCManager } from '../../src/clock/hlc.js';

function createInMemoryProvider(): { provider: KVStoreProvider; stores: Map<string, InMemoryKVStore> } {
	const stores = new Map<string, InMemoryKVStore>();
	const get = (key: string): InMemoryKVStore => {
		let s = stores.get(key);
		if (!s) {
			s = new InMemoryKVStore();
			stores.set(key, s);
		}
		return s;
	};
	const provider: KVStoreProvider = {
		async getStore(s, t) { return get(`${s}.${t}`); },
		async getIndexStore(s, t, i) { return get(`${s}.${t}_idx_${i}`); },
		async getStatsStore(s, t) { return get(`${s}.${t}.__stats__`); },
		async getCatalogStore() { return get('__catalog__'); },
		async closeStore() {},
		async closeIndexStore() {},
		async closeAll() {
			for (const store of stores.values()) await store.close();
			stores.clear();
		},
	};
	return { provider, stores };
}

async function collect(db: Database, sql: string): Promise<Record<string, SqlValue>[]> {
	const out: Record<string, SqlValue>[] = [];
	for await (const row of db.eval(sql)) out.push(row);
	return out;
}

/** Hand-built row-granular watch scope on a single-column-PK table. */
function rowsWatch(table: string, key: string, value: SqlValue): ChangeScope {
	return {
		watches: [{
			table: { schema: 'main', table },
			columns: new Set([key]),
			scope: { kind: 'rows', key: [key], values: [[value as never]] },
		}],
		nonDeterministicSources: [],
		unboundParameters: [],
	};
}

const upd = (table: string, pk: SqlValue[], columns: Record<string, SqlValue>): DataChangeToApply =>
	({ type: 'update', schema: 'main', table, pk, columns });
const del = (table: string, pk: SqlValue[]): DataChangeToApply =>
	({ type: 'delete', schema: 'main', table, pk });

describe('store-adapter seam integration', () => {
	let db: Database;
	let provider: KVStoreProvider;
	let stores: Map<string, InMemoryKVStore>;
	let events: StoreEventEmitter;
	let storeModule: StoreModule;
	let applyToStore: ApplyToStoreCallback;

	const makeAdapter = (overrides?: Partial<SyncStoreAdapterOptions>): ApplyToStoreCallback =>
		createStoreAdapter({ db, storeModule, events, ...overrides });

	beforeEach(() => {
		db = new Database();
		({ provider, stores } = createInMemoryProvider());
		events = new StoreEventEmitter();
		storeModule = new StoreModule(provider, events);
		db.registerModule('store', storeModule);
		applyToStore = makeAdapter();
	});

	afterEach(async () => {
		await db.close();
		await provider.closeAll();
	});

	describe('covering MV convergence', () => {
		beforeEach(async () => {
			await db.exec('create table t (id text primary key, v text) using store');
			await db.exec('create materialized view mv as select id, v from t');
		});

		it('inbound insert / column-update / delete converge the MV', async () => {
			let res = await applyToStore([upd('t', ['x'], { v: 'a' })], [], { remote: true });
			expect(res.errors).to.have.length(0);
			expect(await collect(db, 'select id, v from mv')).to.deep.equal([{ id: 'x', v: 'a' }]);

			res = await applyToStore([upd('t', ['x'], { v: 'b' })], [], { remote: true });
			expect(res.errors).to.have.length(0);
			expect(await collect(db, 'select id, v from mv')).to.deep.equal([{ id: 'x', v: 'b' }]);

			res = await applyToStore([del('t', ['x'])], [], { remote: true });
			expect(res.errors).to.have.length(0);
			expect(await collect(db, 'select id, v from mv')).to.deep.equal([]);
		});

		it('an update for an absent row lands as a PK+nulls partial insert, MV included', async () => {
			// Column changes can arrive before the rest of the row (UPSERT
			// semantics); the seam sees a full-row insert (PK + nulls).
			await db.exec('create table wide (id text primary key, a text, b text) using store');
			await db.exec('create materialized view mv_wide as select id, a, b from wide');

			const res = await applyToStore([upd('wide', ['k'], { b: 'beta' })], [], { remote: true });
			expect(res.errors).to.have.length(0);
			expect(await collect(db, 'select id, a, b from wide')).to.deep.equal([{ id: 'k', a: null, b: 'beta' }]);
			expect(await collect(db, 'select id, a, b from mv_wide')).to.deep.equal([{ id: 'k', a: null, b: 'beta' }]);
		});
	});

	describe('Database.watch capture', () => {
		it('fires row-granular hits post-apply', async () => {
			await db.exec('create table t (id text primary key, v text) using store');
			const watchEvents: WatchEvent[] = [];
			const sub = db.watch(rowsWatch('t', 'id', 'x'), e => { watchEvents.push(e); });

			await applyToStore([upd('t', ['x'], { v: 'a' })], [], { remote: true });
			sub.unsubscribe();

			expect(watchEvents).to.have.length(1);
			expect(watchEvents[0].matched[0].hits).to.deep.equal([['x']]);
		});
	});

	describe('secondary-index maintenance', () => {
		it('inbound apply maintains the index; an indexed query returns the row', async () => {
			await db.exec('create table t (id text primary key, v text) using store');
			await db.exec('create index t_v on t(v)');

			await applyToStore([upd('t', ['x'], { v: 'needle' })], [], { remote: true });

			// The table's own index store gained the entry (raw-KV writes used to skip it).
			let indexEntries = 0;
			for await (const _e of stores.get('main.t_idx_t_v')!.iterate(buildFullScanBounds())) indexEntries++;
			expect(indexEntries).to.equal(1);

			expect(await collect(db, `select id from t where v = 'needle'`)).to.deep.equal([{ id: 'x' }]);

			// Delete removes the entry again.
			await applyToStore([del('t', ['x'])], [], { remote: true });
			indexEntries = 0;
			for await (const _e of stores.get('main.t_idx_t_v')!.iterate(buildFullScanBounds())) indexEntries++;
			expect(indexEntries).to.equal(0);
		});
	});

	describe('no-op suppression', () => {
		it('value-identical upsert and absent delete emit no event and do no seam work', async () => {
			await db.exec('create table t (id text primary key, v text) using store');
			await db.exec('create materialized view mv as select id, v from t');
			await applyToStore([upd('t', ['x'], { v: 'a' })], [], { remote: true });

			const dataEvents: DataChangeEvent[] = [];
			events.onDataChange(e => dataEvents.push(e));
			const watchEvents: WatchEvent[] = [];
			const sub = db.watch(rowsWatch('t', 'id', 'x'), e => { watchEvents.push(e); });

			const res = await applyToStore([
				upd('t', ['x'], { v: 'a' }),   // value-identical → suppressed
				del('t', ['absent']),          // absent key → suppressed
			], [], { remote: true });
			sub.unsubscribe();

			expect(res.errors).to.have.length(0);
			expect(res.dataChangesApplied).to.equal(2);
			expect(dataEvents, 'no module events for suppressed no-ops').to.deep.equal([]);
			expect(watchEvents, 'no watch dispatch (empty seam batch)').to.have.length(0);
			expect(await collect(db, 'select id, v from mv')).to.deep.equal([{ id: 'x', v: 'a' }]);
		});
	});

	describe('delete-wins row grouping', () => {
		it('a delete and updates for one row in one batch resolve to delete, either order', async () => {
			await db.exec('create table t (id text primary key, v text) using store');
			await db.exec(`insert into t values ('x', 'local'), ('y', 'local')`);

			const res = await applyToStore([
				upd('t', ['x'], { v: 'remote' }),
				del('t', ['x']),
				del('t', ['y']),
				upd('t', ['y'], { v: 'remote' }),
			], [], { remote: true });

			expect(res.errors).to.have.length(0);
			expect(await collect(db, 'select id from t')).to.deep.equal([]);
		});
	});

	describe('module-event emission (remote: true, effective images)', () => {
		it('insert/update/delete events carry remote, oldRow/newRow, and changedColumns', async () => {
			await db.exec('create table t (id text primary key, a text, b text) using store');

			const dataEvents: DataChangeEvent[] = [];
			events.onDataChange(e => dataEvents.push(e));

			await applyToStore([upd('t', ['x'], { a: '1', b: '2' })], [], { remote: true });
			await applyToStore([upd('t', ['x'], { b: '3' })], [], { remote: true });
			await applyToStore([del('t', ['x'])], [], { remote: true });

			expect(dataEvents).to.have.length(3);

			expect(dataEvents[0].type).to.equal('insert');
			expect(dataEvents[0].remote).to.equal(true);
			expect(dataEvents[0].key).to.deep.equal(['x']);
			expect(dataEvents[0].newRow).to.deep.equal(['x', '1', '2']);

			expect(dataEvents[1].type).to.equal('update');
			expect(dataEvents[1].remote).to.equal(true);
			expect(dataEvents[1].oldRow, 'accurate before-image').to.deep.equal(['x', '1', '2']);
			expect(dataEvents[1].newRow).to.deep.equal(['x', '1', '3']);
			expect(dataEvents[1].changedColumns, 'effective changed columns').to.deep.equal(['b']);

			expect(dataEvents[2].type).to.equal('delete');
			expect(dataEvents[2].remote).to.equal(true);
			expect(dataEvents[2].oldRow, 'delete carries the before-image now').to.deep.equal(['x', '1', '3']);
		});
	});

	describe('foreign-key actions opt-in', () => {
		beforeEach(async () => {
			await db.exec(`
				create table p (id text primary key) using store;
				create table c (id text primary key, pid text not null references p(id) on delete cascade) using store;
				insert into p values ('p1');
				insert into c values ('c1', 'p1');
			`);
		});

		it('default off: inbound parent delete leaves local children untouched', async () => {
			const res = await applyToStore([del('p', ['p1'])], [], { remote: true });
			expect(res.errors).to.have.length(0);
			expect(await collect(db, 'select id from p')).to.deep.equal([]);
			expect(await collect(db, 'select id from c'), 'stream is assumed to carry origin cascades').to.deep.equal([{ id: 'c1' }]);
		});

		it('opted in: inbound parent delete cascades; cascaded child writes are LOCAL (no remote flag)', async () => {
			const fkApply = makeAdapter({ applyForeignKeyActions: true });

			const dataEvents: DataChangeEvent[] = [];
			events.onDataChange(e => dataEvents.push(e));

			const res = await fkApply([del('p', ['p1'])], [], { remote: true });
			expect(res.errors).to.have.length(0);
			expect(await collect(db, 'select id from p')).to.deep.equal([]);
			expect(await collect(db, 'select id from c'), 'children cascaded').to.deep.equal([]);

			// The adapter's own parent-delete event is remote; the cascade re-enters
			// the DML pipeline, so the child delete emits WITHOUT remote and is
			// recorded as a local change that propagates outward.
			const parentEvent = dataEvents.find(e => e.tableName === 'p' && e.type === 'delete');
			expect(parentEvent?.remote).to.equal(true);
			const childEvent = dataEvents.find(e => e.tableName === 'c' && e.type === 'delete');
			void expect(childEvent, 'cascaded child delete emitted a module event').to.exist;
			expect(childEvent!.remote ?? false).to.equal(false);
		});
	});

	describe('partial failure (unresolvable table mid-invocation)', () => {
		it('errors recorded per change; other tables still apply and reach the seam', async () => {
			await db.exec('create table t (id text primary key, v text) using store');
			await db.exec('create materialized view mv as select id, v from t');

			const res = await applyToStore([
				upd('t', ['x'], { v: 'a' }),
				upd('no_such_table', ['k'], { v: 'b' }),
			], [], { remote: true });

			expect(res.dataChangesApplied).to.equal(1);
			expect(res.errors).to.have.length(1);
			expect((res.errors[0].change as DataChangeToApply).table).to.equal('no_such_table');
			// The resolvable table's change applied AND drove the MV through the seam.
			expect(await collect(db, 'select id, v from mv')).to.deep.equal([{ id: 'x', v: 'a' }]);
		});
	});

	describe('seam-throw propagation through the sync layer', () => {
		/** One remote single-column change set against `main.t`. */
		const remoteChangeSet = (remoteHLC: HLCManager, remoteSiteId: Uint8Array, value: SqlValue) => [{
			siteId: remoteSiteId,
			transactionId: 'tx1',
			hlc: remoteHLC.tick(),
			changes: [{
				type: 'column' as const,
				schema: 'main',
				table: 't',
				pk: ['x'],
				column: 'v',
				value,
				hlc: remoteHLC.tick(),
			}],
			schemaMigrations: [],
		}];

		it('assertion failure propagates, leaves CRDT metadata uncommitted; retry converges', async () => {
			await db.exec('create table t (id text primary key, v integer) using store');
			await db.exec('create assertion non_negative check (not exists (select 1 from t where v < 0))');

			const syncEvents = new SyncEventEmitterImpl();
			const syncManager = await SyncManagerImpl.create(
				new InMemoryKVStore(), undefined, { ...DEFAULT_SYNC_CONFIG }, syncEvents, applyToStore,
				(schemaName, tableName) => db.schemaManager.getTable(schemaName, tableName),
			);

			const remoteSiteId = generateSiteId();
			const remoteHLC = new HLCManager(remoteSiteId);
			const changeSets = remoteChangeSet(remoteHLC, remoteSiteId, -5);

			// First attempt: storage applies, then the seam's commit-time assertion
			// evaluation throws → applyChanges propagates, metadata uncommitted.
			let thrown: unknown;
			try {
				await syncManager.applyChanges(changeSets);
			} catch (e) {
				thrown = e;
			}
			expect(String(thrown)).to.contain('non_negative');

			// Storage rows stay applied (trust-the-origin posture)...
			expect((await collect(db, 'select v from t')).map(r => Number(r.v))).to.deep.equal([-5]);
			// ...but no CRDT metadata committed: nothing to relay to a third peer.
			const relayed = await syncManager.getChangesSince(generateSiteId());
			expect(relayed.flatMap(cs => cs.changes)).to.have.length(0);

			// Retry with the SAME change sets: re-application is a value-identical
			// upsert → suppressed → empty seam batch (no assertion re-evaluation) →
			// metadata commits. The violating row persists (origin trusted) and the
			// derived effects for it were unwound — recovery policy is the host's.
			const retry = await syncManager.applyChanges(changeSets);
			expect(retry.applied).to.be.greaterThan(0);
			const relayedAfter = await syncManager.getChangesSince(generateSiteId());
			expect(relayedAfter.flatMap(cs => cs.changes)).to.have.length(1);
		});

		it('no CRDT echo: applying remote changes records nothing as local', async () => {
			await db.exec('create table t (id text primary key, v text) using store');

			const syncEvents = new SyncEventEmitterImpl();
			const syncManager = await SyncManagerImpl.create(
				new InMemoryKVStore(), undefined, { ...DEFAULT_SYNC_CONFIG }, syncEvents, applyToStore,
				(schemaName, tableName) => db.schemaManager.getTable(schemaName, tableName),
			);

			const remoteSiteId = generateSiteId();
			const remoteHLC = new HLCManager(remoteSiteId);
			const result = await syncManager.applyChanges(remoteChangeSet(remoteHLC, remoteSiteId, 'a'));
			expect(result.applied).to.equal(1);
			expect(await collect(db, 'select id, v from t')).to.deep.equal([{ id: 'x', v: 'a' }]);

			// getChangesSince(origin) excludes the origin's own changes — anything
			// left would be an echo recorded under OUR site id. There must be none.
			const echoed = await syncManager.getChangesSince(remoteSiteId);
			expect(echoed.flatMap(cs => cs.changes)).to.have.length(0);
		});
	});

	describe('per-change apply errors abort with no metadata committed', () => {
		// The adapter collects per-change failures in `result.errors` rather than
		// throwing (it keeps applying other tables). The consumer must still treat
		// any non-empty `errors` like a whole-batch throw: emit error + throw, with
		// NO CRDT metadata committed, so the whole batch re-resolves next sync.
		//
		// The trigger here is a basis/store-ownership MISMATCH: the oracle reports
		// `no_such_table` as in-basis (so unknown-table detection passes it through
		// to the adapter rather than diverting it to quarantine), but no backing
		// store table exists, so the adapter's defensive `Table not found for
		// external write` throw fires as a per-change error. This is the exact net
		// the unknown-table-disposition work leaves in place for ownership drift —
		// distinct from a genuinely retired (out-of-basis) table, which is diverted.
		const makeSyncManager = (syncEvents: SyncEventEmitterImpl) =>
			SyncManagerImpl.create(
				new InMemoryKVStore(), undefined, { ...DEFAULT_SYNC_CONFIG }, syncEvents, applyToStore,
				(schemaName, tableName): TableSchema | undefined =>
					tableName === 'no_such_table'
						? ({} as TableSchema)
						: db.schemaManager.getTable(schemaName, tableName),
			);

		it('applyChanges: a per-change storage failure throws and commits no metadata; retry converges', async () => {
			await db.exec('create table t (id text primary key, v text) using store');

			const syncEvents = new SyncEventEmitterImpl();
			const syncManager = await makeSyncManager(syncEvents);

			const remoteSiteId = generateSiteId();
			const remoteHLC = new HLCManager(remoteSiteId);
			// One change set spanning a resolvable table `t` and an unresolvable
			// `no_such_table`. Built once and reused so the HLCs are stable across
			// both attempts.
			const changeSets = [{
				siteId: remoteSiteId,
				transactionId: 'tx1',
				hlc: remoteHLC.tick(),
				changes: [
					{ type: 'column' as const, schema: 'main', table: 't', pk: ['x'], column: 'v', value: 'a', hlc: remoteHLC.tick() },
					{ type: 'column' as const, schema: 'main', table: 'no_such_table', pk: ['k'], column: 'v', value: 'b', hlc: remoteHLC.tick() },
				],
				schemaMigrations: [],
			}];

			// First attempt: `t` applies to storage, `no_such_table` fails → the
			// adapter records the error, applyChanges aggregates it into a throw
			// (carrying the failed change), and NO CRDT metadata is committed.
			let thrown: unknown;
			try {
				await syncManager.applyChanges(changeSets);
			} catch (e) {
				thrown = e;
			}
			expect(String(thrown)).to.contain('no_such_table');
			// throwIfApplyErrors aggregates the failed change(s) into one Error and
			// chains the underlying store error as `cause`.
			expect(thrown).to.be.instanceOf(Error);
			expect((thrown as Error).message).to.contain('apply-to-store failed for');
			expect((thrown as Error).cause).to.be.instanceOf(Error);

			// Whole batch uncommitted: nothing to relay (neither `t` nor `no_such_table`).
			const relayed = await syncManager.getChangesSince(generateSiteId());
			expect(relayed.flatMap(cs => cs.changes)).to.have.length(0);

			// Create the missing table and re-apply the SAME change set: both apply,
			// metadata commits, both changes relay (convergence on idempotent retry).
			await db.exec('create table no_such_table (id text primary key, v text) using store');
			const retry = await syncManager.applyChanges(changeSets);
			expect(retry.applied).to.equal(2);
			const relayedAfter = await syncManager.getChangesSince(generateSiteId());
			expect(relayedAfter.flatMap(cs => cs.changes)).to.have.length(2);
		});

		it('applySnapshot: an unresolvable table throws before clearing/rewriting metadata', async () => {
			const syncEvents = new SyncEventEmitterImpl();
			const syncManager = await makeSyncManager(syncEvents);

			const remoteSiteId = generateSiteId();
			const remoteHLC = new HLCManager(remoteSiteId);
			const snapshot: Snapshot = {
				siteId: remoteSiteId,
				hlc: remoteHLC.tick(),
				tables: [{
					schema: 'main',
					table: 'no_such_table',
					rows: [],
					// versionKey = `${encodePK(pk)}:${column}` — encodePK is JSON.stringify.
					columnVersions: new Map([['["k"]:v', { hlc: remoteHLC.tick(), value: 'b' }]]),
				}],
				schemaMigrations: [],
			};

			let thrown: unknown;
			try {
				await syncManager.applySnapshot(snapshot);
			} catch (e) {
				thrown = e;
			}
			expect(String(thrown)).to.contain('no_such_table');

			// Throw fired before the clear/rewrite phase → no column-version metadata committed.
			const relayed = await syncManager.getChangesSince(generateSiteId());
			expect(relayed.flatMap(cs => cs.changes)).to.have.length(0);
		});

		it('applySnapshotStream: an unresolvable table throws and never emits status synced', async () => {
			const syncEvents = new SyncEventEmitterImpl();
			const states: SyncState[] = [];
			syncEvents.onSyncStateChange(s => states.push(s));
			const syncManager = await makeSyncManager(syncEvents);

			const remoteSiteId = generateSiteId();
			const remoteHLC = new HLCManager(remoteSiteId);
			const snapshotId = 'snap-err-1';
			const chunks: SnapshotChunk[] = [
				{ type: 'header', siteId: remoteSiteId, hlc: remoteHLC.tick(), tableCount: 1, migrationCount: 0, snapshotId },
				{ type: 'table-start', schema: 'main', table: 'no_such_table', estimatedEntries: 0 },
				{ type: 'column-versions', schema: 'main', table: 'no_such_table', entries: [['["k"]:v', remoteHLC.tick(), 'b']] },
				{ type: 'table-end', schema: 'main', table: 'no_such_table', entriesWritten: 1 },
				{ type: 'footer', snapshotId, totalTables: 1, totalEntries: 1, totalMigrations: 0 },
			];
			async function* stream(): AsyncIterable<SnapshotChunk> {
				for (const c of chunks) yield c;
			}

			let thrown: unknown;
			try {
				await syncManager.applySnapshotStream(stream());
			} catch (e) {
				thrown = e;
			}
			expect(String(thrown)).to.contain('no_such_table');

			// The footer's data flush throws before `status: 'synced'` is emitted.
			expect(states.map(s => s.status)).to.include('error');
			expect(states.map(s => s.status)).to.not.include('synced');

			// Metadata batch is flushed only after the data flush → none committed.
			const relayed = await syncManager.getChangesSince(generateSiteId());
			expect(relayed.flatMap(cs => cs.changes)).to.have.length(0);
		});
	});

	describe('resumed snapshot stream preserves completed-table metadata', () => {
		// A resumed transfer's sender skips already-completed tables and never
		// re-emits their metadata. The receiver's up-front clear must consult the
		// persisted checkpoint and preserve those tables — otherwise their CRDT
		// state is wiped and never rewritten (metadata/data divergence).
		it('omitted completed table survives the clear; re-streamed table applies', async () => {
			// tableB is re-streamed → its rows flush to the store at table-end, so
			// the store must be able to resolve it. tableA is skipped entirely.
			await db.exec('create table tableB (id text primary key, v text) using store');

			const kv = new InMemoryKVStore();
			const syncEvents = new SyncEventEmitterImpl();
			const syncManager = await SyncManagerImpl.create(
				kv, undefined, { ...DEFAULT_SYNC_CONFIG }, syncEvents, applyToStore,
				(schemaName, tableName) => db.schemaManager.getTable(schemaName, tableName),
			);

			const remoteSiteId = generateSiteId();
			const remoteHLC = new HLCManager(remoteSiteId);
			const snapshotId = 'snap-resume-1';

			// Seed tableA's column version (the "already completed" table) and a
			// checkpoint that lists it completed — mirroring saveSnapshotCheckpoint's
			// serialization (hlc.wallTime as string, siteId arrays).
			await syncManager.columnVersions.setColumnVersion('main', 'tableA', ['a1'], 'v', {
				hlc: remoteHLC.tick(),
				value: 'survives',
			});
			// Also seed a tombstone and a change-log entry for the completed table,
			// plus a *non*-completed table (tableC) that the stream never re-emits.
			// The resume-aware clear must preserve tableA's tb:/cl: state (the two
			// branches of clearExistingMetadata that the cv assertions don't reach)
			// while still dropping tableC's — proving the preserve filter is
			// selective, not a blanket skip.
			await syncManager.tombstones.setTombstone('main', 'tableA', ['a2'], remoteHLC.tick());
			await syncManager.changeLog.recordColumnChange(remoteHLC.tick(), 'main', 'tableA', ['a1'], 'v');
			await syncManager.tombstones.setTombstone('main', 'tableC', ['c1'], remoteHLC.tick());
			await syncManager.changeLog.recordColumnChange(remoteHLC.tick(), 'main', 'tableC', ['c1'], 'v');
			const checkpoint = {
				snapshotId,
				siteId: remoteSiteId,
				hlc: remoteHLC.tick(),
				lastTableIndex: 1,
				lastEntryIndex: 1,
				completedTables: ['main.tableA'],
				entriesProcessed: 1,
				createdAt: 0,
			};
			const ckptJson = JSON.stringify({
				...checkpoint,
				hlc: {
					wallTime: checkpoint.hlc.wallTime.toString(),
					counter: checkpoint.hlc.counter,
					siteId: Array.from(checkpoint.hlc.siteId),
					opSeq: checkpoint.hlc.opSeq,
				},
				siteId: Array.from(checkpoint.siteId),
			});
			await kv.put(new TextEncoder().encode(`sc:${snapshotId}`), new TextEncoder().encode(ckptJson));

			// Resumed stream: header (full table count) + tableB only + footer.
			const chunks: SnapshotChunk[] = [
				{ type: 'header', siteId: remoteSiteId, hlc: remoteHLC.tick(), tableCount: 2, migrationCount: 0, snapshotId },
				{ type: 'table-start', schema: 'main', table: 'tableB', estimatedEntries: 0 },
				{ type: 'column-versions', schema: 'main', table: 'tableB', entries: [['["b1"]:v', remoteHLC.tick(), 'bval']] },
				{ type: 'table-end', schema: 'main', table: 'tableB', entriesWritten: 1 },
				{ type: 'footer', snapshotId, totalTables: 2, totalEntries: 1, totalMigrations: 0 },
			];
			async function* stream(): AsyncIterable<SnapshotChunk> {
				for (const c of chunks) yield c;
			}

			await syncManager.applySnapshotStream(stream());

			// tableA's metadata survived the resume-aware clear...
			const survived = await syncManager.columnVersions.getColumnVersion('main', 'tableA', ['a1'], 'v');
			void expect(survived, 'completed-table column version preserved on resume').to.exist;
			expect(survived!.value).to.equal('survives');

			// ...and tableB was applied (metadata + store row).
			const applied = await syncManager.columnVersions.getColumnVersion('main', 'tableB', ['b1'], 'v');
			void expect(applied, 'resumed table column version applied').to.exist;
			expect(applied!.value).to.equal('bval');
			expect(await collect(db, 'select id, v from tableB')).to.deep.equal([{ id: 'b1', v: 'bval' }]);

			// tableA's tombstone (tb:) and change-log entry (cl:) survived the clear...
			void expect(
				await syncManager.tombstones.getTombstone('main', 'tableA', ['a2']),
				'completed-table tombstone preserved on resume',
			).to.exist;
			const clTables = new Set<string>();
			for await (const e of syncManager.changeLog.getAllChanges()) clTables.add(e.table);
			void expect(clTables.has('tableA'), 'completed-table change-log entry preserved on resume').to.be.true;

			// ...while the non-completed tableC's tb:/cl: state was cleared.
			void expect(
				await syncManager.tombstones.getTombstone('main', 'tableC', ['c1']),
				'non-completed tombstone cleared on resume',
			).to.not.exist;
			void expect(clTables.has('tableC'), 'non-completed change-log entry cleared on resume').to.be.false;

			// Divergence angle: a full delta sync to a fresh peer still relays
			// tableA's change, proving the metadata is not orphaned from its data.
			const relayed = await syncManager.getChangesSince(generateSiteId());
			const tableAChange = relayed
				.flatMap(cs => cs.changes)
				.find(c => c.type === 'column' && c.table === 'tableA' && c.column === 'v');
			void expect(tableAChange, 'tableA change relayed after resume').to.exist;
		});
	});
});
