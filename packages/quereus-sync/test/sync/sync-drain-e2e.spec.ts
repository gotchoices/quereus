/**
 * Held-change drain (revival), real-engine end-to-end.
 *
 * Sibling of `unknown-table-disposition.spec.ts`'s `drainHeldChanges (revival)`
 * block, which proves the drain at the CRDT-metadata layer (a `SyncManagerImpl`
 * over an in-memory KV, a recording `applyToStore` stub that writes into a `Map`,
 * and a mutable `known`-set basis oracle). There the materialization claim — "a
 * held out-of-basis change replays into a re-created table" — is asserted via the
 * stub `store` Map and `columnVersions`, NOT via `select * from <table>`, and the
 * stub fires only `onRemoteChange` so it CANNOT exercise the derived effects of the
 * real ingestion seam (`Database.watch` capture, materialized-view maintenance).
 * THIS suite closes that gap: it drives REAL `Database` + `StoreModule` +
 * `createStoreAdapter` peers, so the drain's `admitGroup` calls the store adapter,
 * which runs `db.ingestExternalRowChanges(...)` — the path that feeds watch capture
 * and MV maintenance (`store-adapter.ts` header + step 5).
 *
 *   S (straggler)                         H (holder)
 *   ─────────────                         ──────────
 *   has `orders` (real, store-backed)     NO `orders` at receive time
 *   writes row(s) under S's HLC           disposition = quarantine | store-and-forward
 *
 *   insert/delete on S ──relay(S→H)──► H diverts (out of basis) ──► held (durable)
 *                                                                        │
 *                           H.db.exec('create table orders …')          │  table reappears
 *                                                                        ▼
 *                           H.manager.drainHeldChanges('main','orders')  │  replays via
 *                                                                        ▼  createStoreAdapter
 *                                                           db.ingestExternalRowChanges
 *                                                           → row materializes  (select)
 *                                                           → Database.watch / MV fire
 *                                                           → entry cleared from hold
 *
 * Wiring facts (verified against the source, mirroring the relay e2e):
 *  - The basis oracle is the table-lookup function itself
 *    (`(s, t) => db.schemaManager.getTable(s, t)`), so dropping / re-creating
 *    `orders` on H automatically flips the table out of / back into basis and
 *    updates its column set — `getTableColumnNames` (the drain's basis gate +
 *    schema-drift filter) reads it LIVE. No stub mutation is needed.
 *  - DDL is not synced here: each peer creates its own schema directly, and
 *    `relay()` strips `schemaMigrations`. The holder's re-create is a plain
 *    `H.db.exec`, not a synced migration.
 *  - Per-column recording: a fresh insert is held as one entry per column (PK
 *    included), so a held `insert into orders(id, note)` is TWO held entries — counts
 *    are asserted against `COLUMNS_PER_FRESH_INSERT`, not literally 1.
 *  - Why drain, not relay, is the trigger: unlike the relay e2e (where the relay
 *    never has the table and forwards it onward), here H re-acquires the table and
 *    the host explicitly calls `drainHeldChanges`. The drain runs as a SEPARATE
 *    apply after the re-creating DDL has committed, so older held changes simply
 *    LWW-resolve against whatever fresh data is present.
 */

import { expect } from 'chai';
import { Database, type SqlValue, type WatchEvent } from '@quereus/quereus';
import {
	StoreModule,
	StoreEventEmitter,
	InMemoryKVStore,
	type DataChangeEvent,
	type KVStoreProvider,
} from '@quereus/store';
import { createStoreAdapter } from '../../src/sync/store-adapter.js';
import { SyncManagerImpl } from '../../src/sync/sync-manager-impl.js';
import { SyncEventEmitterImpl, type HeldChangesDrainedEvent } from '../../src/sync/events.js';
import {
	DEFAULT_SYNC_CONFIG,
	type SyncConfig,
	type ChangeSet,
	type Change,
	type UnknownTableDisposition,
} from '../../src/sync/protocol.js';
import { generateSiteId, siteIdEquals, type SiteId } from '../../src/clock/site.js';
import { compareHLC } from '../../src/clock/hlc.js';

/** One CRDT ColumnChange per column of a fresh insert — PK included (id + note). */
const COLUMNS_PER_FRESH_INSERT = 2;

/** The standard 2-column `orders` base table both S and a revived H use. */
const DEFAULT_ORDERS_DDL = 'create table orders (id integer primary key, note text) using store';

/** Per-store-key in-memory KV provider (copied from the relay e2e harness). */
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

/**
 * Local-change capture is anchored to the engine transaction boundary and runs
 * fire-and-forget *after* the commit, so this manual-relay harness must let the
 * capture settle before reading the change log. (A generous in-memory delay; the
 * handler completes in microtasks.)
 */
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 25));

/** A self-contained sync peer: real Database + StoreModule + adapter + SyncManager. */
interface Peer {
	readonly name: string;
	readonly db: Database;
	readonly provider: KVStoreProvider;
	readonly events: StoreEventEmitter;
	readonly storeModule: StoreModule;
	readonly manager: SyncManagerImpl;
}

/**
 * Build a real-engine peer parameterized by its unknown-table disposition, whether
 * it creates the `orders` base table, and (for the schema-drift case) the `orders`
 * DDL. The basis oracle is the table-lookup function itself, so a peer that never
 * creates `orders` reports it out-of-basis — exactly how H starts "retired".
 */
async function makePeer(
	name: string,
	opts: { createOrders?: boolean; disposition?: UnknownTableDisposition; ordersDdl?: string } = {},
): Promise<Peer> {
	const { provider } = createInMemoryProvider();
	const events = new StoreEventEmitter();
	const db = new Database();
	const storeModule = new StoreModule(provider, events);
	db.registerModule('store', storeModule);
	const applyToStore = createStoreAdapter({ db, storeModule, events });

	const config: SyncConfig = {
		...DEFAULT_SYNC_CONFIG,
		...(opts.disposition ? { unknownTableDisposition: opts.disposition } : {}),
	};

	const manager = await SyncManagerImpl.create(
		new InMemoryKVStore(),
		db,
		config,
		new SyncEventEmitterImpl(),
		applyToStore,
		(schemaName, tableName) => db.schemaManager.getTable(schemaName, tableName),
	);

	if (opts.createOrders) {
		await db.exec(opts.ordersDdl ?? DEFAULT_ORDERS_DDL);
	}

	return { name, db, provider, events, storeModule, manager };
}

async function closePeer(peer: Peer): Promise<void> {
	await peer.db.close();
	await peer.provider.closeAll();
}

/** Apply one local SQL write and let its transaction-boundary capture settle. */
async function localWrite(peer: Peer, sql: string): Promise<void> {
	await peer.db.exec(sql);
	await settle();
}

/**
 * Re-create the `orders` base table on a holder that had retired it — the revival
 * step. A plain local `exec` (NOT a synced migration); the live basis oracle flips
 * `orders` back into basis the instant the table exists, with the DDL's columns.
 */
async function reviveOrders(peer: Peer, ddl: string = DEFAULT_ORDERS_DDL): Promise<void> {
	await peer.db.exec(ddl);
	await settle();
}

/**
 * One-directional full DATA relay (real-db analogue of a transport pull):
 * `from`'s data changes excluding `to`-origin → `to`, from-zero (no `sinceHLC`).
 * Schema migrations are stripped — each peer creates its own schema directly.
 */
async function relay(from: Peer, to: Peer): Promise<{ applied: number }> {
	await settle(); // flush `from`'s pending local capture before reading its log
	const sets = await from.manager.getChangesSince(to.manager.getSiteId());
	const dataOnly = sets.map(cs => ({ ...cs, schemaMigrations: [] }));
	const res = await to.manager.applyChanges(dataOnly);
	await settle(); // flush `to`'s capture from the apply
	await to.manager.updatePeerSyncState(from.manager.getSiteId(), from.manager.getCurrentHLC());
	return res;
}

/** Flatten a peer's relayable change log (from-zero) for a given peer-id exclusion. */
async function changesFor(peer: Peer, excludeSiteId: SiteId): Promise<Change[]> {
	await settle(); // flush any pending local capture before reading the log
	const sets = await peer.manager.getChangesSince(excludeSiteId);
	return sets.flatMap(cs => [...cs.changes]);
}

/** Flatten a ChangeSet[] to its data changes. */
const flattenSets = (sets: ChangeSet[]): Change[] => sets.flatMap(cs => [...cs.changes]);

/** Whether any flattened change targets the `orders` table. */
const hasOrders = (changes: Change[]): boolean => changes.some(c => c.table === 'orders');

describe('real-engine held-change drain (revival): straggler → hold → re-create → drain', () => {
	// Heterogeneous setups (different dispositions / orders DDL per test), so peers
	// are spawned per-test and tracked for teardown rather than built in beforeEach.
	let tracked: Peer[] = [];
	const spawn = async (name: string, opts?: Parameters<typeof makePeer>[1]): Promise<Peer> => {
		const peer = await makePeer(name, opts);
		tracked.push(peer);
		return peer;
	};

	beforeEach(() => { tracked = []; });
	afterEach(async () => {
		for (const peer of tracked) await closePeer(peer);
		tracked = [];
	});

	it('drain materializes a held row carrying S\'s origin HLC — idempotently, with no spurious echo', async () => {
		const S = await spawn('S', { createOrders: true });
		const H = await spawn('H'); // quarantine (default), NO orders

		// (1) Straggler writes the row; capture S's origin HLC for the cross-hop check.
		await localWrite(S, "insert into orders values (1, 'hi')");
		const sCv = await S.manager.columnVersions.getColumnVersion('main', 'orders', [1], 'note');
		expect(sCv, 'S logged the note column under its own HLC').to.not.be.undefined;
		const original = sCv!.hlc;

		// (2) Relay S→H: H has no orders → the change is diverted in Phase 1 and held.
		await relay(S, H);
		const held = await H.manager.quarantine.list('main', 'orders');
		expect(held, 'H holds the straggler insert as one entry per column').to.have.lengthOf(COLUMNS_PER_FRESH_INSERT);
		expect(H.db.schemaManager.getTable('main', 'orders'), 'H had no orders at hold time').to.be.undefined;

		// (3) Re-create orders on H; subscribe to data events BEFORE the drain to catch echoes.
		await reviveOrders(H);
		const hEvents: DataChangeEvent[] = [];
		H.events.onDataChange(e => hEvents.push(e));

		// (4) Drain: replays the held change via the real store adapter.
		const drained = await H.manager.drainHeldChanges('main', 'orders');
		await settle();
		expect(drained, 'drain returns the held count').to.equal(COLUMNS_PER_FRESH_INSERT);

		// THE HEADLINE: the row is really there in a real, store-backed SQL table.
		expect(
			await collect(H.db, 'select id, note from orders'),
			'select on H deep-equals the row S wrote',
		).to.deep.equal([{ id: 1, note: 'hi' }]);

		// Origin identity preserved end to end: S's siteId + original HLC, not H's clock.
		const hCv = await H.manager.columnVersions.getColumnVersion('main', 'orders', [1], 'note');
		expect(hCv, 'the note column materialized on H').to.not.be.undefined;
		expect(hCv!.value, 'materialized note value is the straggler\'s').to.equal('hi');
		expect(siteIdEquals(hCv!.hlc.siteId, S.manager.getSiteId()), 'materialized with S\'s origin siteId').to.be.true;
		expect(compareHLC(hCv!.hlc, original), 'materialized with S\'s original HLC').to.equal(0);

		// The hold cleared.
		expect(await H.manager.quarantine.list('main', 'orders'), 'hold cleared after drain').to.have.lengthOf(0);

		// No spurious local echo: arrived remote:true, no non-remote orders event, no H-origin echo.
		expect(hEvents.filter(e => e.tableName === 'orders' && e.remote), 'H received orders remote:true').to.have.length.greaterThan(0);
		expect(hEvents.filter(e => e.tableName === 'orders' && !e.remote), 'no local orders event on H (no spurious echo)').to.have.length(0);
		expect(hasOrders(await changesFor(H, S.manager.getSiteId())), 'no H-origin orders echo recorded').to.equal(false);

		// H is now a second-order relay/server: it serves the orders change from its OWN
		// change log with S's origin intact (origin ≠ neutral).
		const hServes = flattenSets(await H.manager.getChangesSince(generateSiteId())).filter(c => c.table === 'orders');
		expect(hServes, 'H serves the orders change from its own log').to.have.lengthOf(COLUMNS_PER_FRESH_INSERT);
		expect(hServes.every(c => siteIdEquals(c.hlc.siteId, S.manager.getSiteId())), 'H serves it with S\'s origin').to.equal(true);

		// Idempotent re-drain: returns 0, fires NO drained event, and the row + log stay put.
		const drainedEvents: HeldChangesDrainedEvent[] = [];
		H.manager.getEventEmitter().onHeldChangesDrained(e => drainedEvents.push(e));
		const second = await H.manager.drainHeldChanges('main', 'orders');
		expect(second, 'second drain is a no-op (returns 0)').to.equal(0);
		expect(drainedEvents, 'no drained event on the idempotent re-drain').to.have.lengthOf(0);
		expect(await collect(H.db, 'select id, note from orders'), 'row value-unchanged by the re-drain').to.deep.equal([{ id: 1, note: 'hi' }]);
	});

	it('a revival drain drives materialized-view maintenance and Database.watch (the claim the stub cannot make)', async () => {
		const S = await spawn('S', { createOrders: true });
		const H = await spawn('H');

		await localWrite(S, "insert into orders values (1, 'hi')");
		await relay(S, H);
		expect(await H.manager.quarantine.list('main', 'orders')).to.have.lengthOf(COLUMNS_PER_FRESH_INSERT);

		// Re-create orders, then register a full watch + an MV over it BEFORE the drain,
		// so the revival is the firing transaction (a watch/MV against a missing table
		// would fail scope validation / have no source).
		await reviveOrders(H);
		await H.db.exec('create materialized view orders_mv as select id, note from orders');
		const watchEvents: WatchEvent[] = [];
		const sub = H.db.watch(H.db.prepare('select id, note from orders').getChangeScope(), e => { watchEvents.push(e); });

		const drained = await H.manager.drainHeldChanges('main', 'orders');
		await settle();
		sub.unsubscribe();
		expect(drained).to.equal(COLUMNS_PER_FRESH_INSERT);

		// The watch fired with `orders` in `matched` — the revival drove capture.
		expect(watchEvents.length, 'watch fired on the revival').to.be.greaterThan(0);
		expect(
			watchEvents.some(e => e.matched.some(m => m.watch.table.table === 'orders')),
			'a fired watch matched orders',
		).to.equal(true);

		// The MV reflects the drained row via `select` — derived-effect maintenance ran.
		expect(
			await collect(H.db, 'select id, note from orders_mv'),
			'the MV reflects the drained row',
		).to.deep.equal([{ id: 1, note: 'hi' }]);
	});

	it('a held delete of an absent pk drains as a genuine store no-op (no throw), recording S\'s tombstone', async () => {
		const S = await spawn('S', { createOrders: true });
		const H = await spawn('H');

		// Insert then delete on S so the relay carries ONLY a RowDeletion (the insert's
		// column versions were dropped by the delete).
		await localWrite(S, "insert into orders values (1, 'hi')");
		await localWrite(S, 'delete from orders where id = 1');
		await relay(S, H);

		const held = await H.manager.quarantine.list('main', 'orders');
		expect(held, 'H holds only the deletion').to.have.lengthOf(1);
		expect(held[0].change.type, 'the held change is a delete').to.equal('delete');

		// Re-create orders EMPTY; the drain must not throw on the absent-pk delete — the
		// table now exists, and the adapter suppresses the absent delete as a no-op.
		await reviveOrders(H);
		let threw: Error | undefined;
		let drained = -1;
		try {
			drained = await H.manager.drainHeldChanges('main', 'orders');
		} catch (error) {
			threw = error as Error;
		}
		await settle();
		expect(threw, 'drain did not throw on the absent-pk delete').to.be.undefined;
		expect(drained, 'the held delete drained').to.equal(1);

		// No residue: select is empty.
		expect(await collect(H.db, 'select id, note from orders'), 'orders is empty (delete no-op, no residue)').to.deep.equal([]);

		// The tombstone IS recorded on H, carrying S's origin (not H's clock).
		const tomb = await H.manager.tombstones.getTombstone('main', 'orders', [1]);
		expect(tomb, 'H records a tombstone for the absent-pk delete').to.not.be.undefined;
		expect(siteIdEquals(tomb!.hlc.siteId, S.manager.getSiteId()), 'tombstone carries S\'s origin siteId').to.be.true;

		// Held entry cleared.
		expect(await H.manager.quarantine.list('main', 'orders'), 'hold cleared').to.have.lengthOf(0);
	});

	it('a forwardable held change, once drained, leaves the forwardable hold and rides the normal change log', async () => {
		const S = await spawn('S', { createOrders: true });
		const H = await spawn('H', { disposition: 'store-and-forward' });

		await localWrite(S, "insert into orders values (1, 'hi')");
		await relay(S, H);
		expect(
			await H.manager.quarantine.listForwardable(),
			'held forwardable before drain',
		).to.have.lengthOf(COLUMNS_PER_FRESH_INSERT);

		await reviveOrders(H);
		const drained = await H.manager.drainHeldChanges('main', 'orders');
		await settle();
		expect(drained).to.equal(COLUMNS_PER_FRESH_INSERT);

		// No longer forwardable — it is a real local version now, relayed via the normal
		// change-log path henceforth; the forwardable hold (and the hold) are empty.
		expect(await H.manager.quarantine.listForwardable(), 'forwardable hold empty after drain').to.have.lengthOf(0);
		expect(await H.manager.quarantine.list('main', 'orders'), 'hold fully cleared').to.have.lengthOf(0);

		// The value materialized, and rides H's own change log with S's origin (H is now a
		// second-order relay exactly like the relay e2e's holder).
		expect(await collect(H.db, 'select id, note from orders')).to.deep.equal([{ id: 1, note: 'hi' }]);
		const hServes = flattenSets(await H.manager.getChangesSince(generateSiteId())).filter(c => c.table === 'orders');
		expect(hServes, 'H serves the orders change from its own log').to.have.lengthOf(COLUMNS_PER_FRESH_INSERT);
		expect(hServes.every(c => siteIdEquals(c.hlc.siteId, S.manager.getSiteId())), 'served with S\'s origin').to.equal(true);
	});

	it('drains around schema drift: a held column absent on the re-created table is drift-dropped, siblings apply', async () => {
		const S = await spawn('S', {
			createOrders: true,
			ordersDdl: 'create table orders (id integer primary key, note text, memo text) using store',
		});
		const H = await spawn('H'); // quarantine, NO orders

		await localWrite(S, "insert into orders values (1, 'keep', 'dropme')");
		await relay(S, H);
		expect(
			await H.manager.quarantine.list('main', 'orders'),
			'three held column entries (id, note, memo)',
		).to.have.lengthOf(3);

		// Re-create WITHOUT `memo` (the migration dropped it) — a real store-backed table.
		await reviveOrders(H); // default 2-column DDL (id, note)
		const drainedEvents: HeldChangesDrainedEvent[] = [];
		H.manager.getEventEmitter().onHeldChangesDrained(e => drainedEvents.push(e));

		const drained = await H.manager.drainHeldChanges('main', 'orders');
		await settle();

		// No throw; all held entries cleared; only the present-column changes applied.
		expect(drained, 'all three held entries drained').to.equal(3);
		expect(drainedEvents, 'one drained event').to.have.lengthOf(1);
		expect(drainedEvents[0]).to.include({ schema: 'main', table: 'orders', drained: 3, applied: 2, skipped: 1 });
		expect(drainedEvents[0].applied, 'applied < drained (the memo entry was drift-dropped)').to.be.lessThan(drainedEvents[0].drained);

		expect(
			await collect(H.db, 'select id, note from orders'),
			'surviving cells materialized',
		).to.deep.equal([{ id: 1, note: 'keep' }]);
		expect(
			await H.manager.columnVersions.getColumnVersion('main', 'orders', [1], 'memo'),
			'the drift-dropped memo column was never recorded',
		).to.be.undefined;
		expect(await H.manager.quarantine.list('main', 'orders'), 'hold cleared').to.have.lengthOf(0);
	});
});
