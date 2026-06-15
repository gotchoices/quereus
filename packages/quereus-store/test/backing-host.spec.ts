/**
 * Capability-surface tests for the store backing host (`src/common/backing-host.ts`),
 * mirroring the memory reference suite (`quereus/test/vtab/backing-host.spec.ts`).
 *
 * Run against BOTH registration shapes:
 *  - `createIsolatedStoreModule` — the registered `'store'` wrapper
 *    (`IsolationModule(StoreModule)`), where the capability is the conditional
 *    constructor-assigned forward;
 *  - the bare `StoreModule` — contract-conformant on its own thanks to the
 *    substrate's reads-own-writes merge.
 *
 * One DOCUMENTED divergence from the memory suite: the store's pending state is
 * the per-table TransactionCoordinator (shared by every connection to the
 * table), so a sibling connection from `host.connect()` DOES observe pending
 * maintenance — per-table-coordinator RYOW, the store's documented posture. The
 * contract only requires the writing connection to observe its ops; the
 * memory host's per-connection invisibility is an isolation property, not a
 * contract point. The suite pins the store semantics explicitly (sibling sees
 * pending; rollback restores committed).
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, QuereusError, StatusCode } from '@quereus/quereus';
import type { BackingHost, Row } from '@quereus/quereus';
import type { IsolationModule } from '@quereus/isolation';
import {
	StoreModule,
	InMemoryKVStore,
	StoreEventEmitter,
	createIsolatedStoreModule,
	type KVStoreProvider,
	type DataChangeEvent,
} from '../src/index.js';

/** Module under test: either the registered isolation wrapper or the bare store module. */
type BackingHostModule = StoreModule | IsolationModule;

function createProvider(): KVStoreProvider {
	const stores = new Map<string, InMemoryKVStore>();
	const get = (key: string): InMemoryKVStore => {
		let s = stores.get(key);
		if (!s) {
			s = new InMemoryKVStore();
			stores.set(key, s);
		}
		return s;
	};
	return {
		async getStore(s, t) { return get(`${s}.${t}`); },
		async getIndexStore(s, t, i) { return get(`${s}.${t}_idx_${i}`); },
		async getStatsStore() { return get('__stats__'); },
		async getCatalogStore() { return get('__catalog__'); },
		async closeStore() { /* no-op: shared in-memory store */ },
		async closeIndexStore() { /* no-op */ },
		async closeAll() {
			for (const s of stores.values()) await s.close();
			stores.clear();
		},
		// Real teardown so a drop+recreate in the incarnation test yields a FRESH
		// empty store rather than resurrecting old rows through the cached handle.
		async deleteTableStores(schemaName, tableName, indexNames) {
			stores.delete(`${schemaName}.${tableName}`);
			for (const i of indexNames) stores.delete(`${schemaName}.${tableName}_idx_${i}`);
		},
	};
}

const MODULE_FLAVORS: ReadonlyArray<{ label: string; make: (provider: KVStoreProvider) => BackingHostModule }> = [
	{ label: 'isolated store (registered IsolationModule(StoreModule) wrapper)', make: p => createIsolatedStoreModule({ provider: p }) },
	{ label: 'bare StoreModule', make: p => new StoreModule(p) },
];

async function collect(iter: AsyncIterable<Row>): Promise<Row[]> {
	const out: Row[] = [];
	for await (const r of iter) out.push(r);
	return out;
}

async function expectInternal(run: () => Promise<unknown> | unknown): Promise<void> {
	try {
		await run();
	} catch (e) {
		expect(e).to.be.instanceOf(QuereusError);
		expect((e as QuereusError).code).to.equal(StatusCode.INTERNAL);
		return;
	}
	expect.fail('expected a QuereusError with StatusCode.INTERNAL');
}

for (const flavor of MODULE_FLAVORS) {
	describe(`backing-host capability (${flavor.label})`, () => {
		let db: Database;
		let provider: KVStoreProvider;
		let storeModule: BackingHostModule;

		beforeEach(async () => {
			db = new Database();
			provider = createProvider();
			storeModule = flavor.make(provider);
			db.registerModule('store', storeModule);
			// Composite PK (a, b) so equalityPrefix has a leading column to range on.
			await db.exec('create table comp (a integer, b integer, v text, primary key (a, b)) using store');
			await db.exec("insert into comp values (1,1,'a'),(1,2,'b'),(2,1,'c')");
		});
		afterEach(async () => {
			await db.close();
			await provider.closeAll();
		});

		function resolveHost(tableName = 'comp'): BackingHost {
			expect(storeModule.getBackingHost, 'module advertises the capability').to.be.a('function');
			const host = storeModule.getBackingHost!(db, 'main', tableName);
			expect(host, `backing host for '${tableName}'`).to.not.be.undefined;
			return host!;
		}

		it('getBackingHost resolves a host for an owned table and undefined for an unknown one', () => {
			expect(resolveHost()).to.not.be.undefined;
			expect(storeModule.getBackingHost!(db, 'main', 'no_such_table')).to.be.undefined;
		});

		it("ownsConnection accepts this table's connections and rejects another table's", async () => {
			await db.exec('create table other (k integer primary key, v text) using store');
			const compHost = resolveHost('comp');
			const otherHost = resolveHost('other');
			const compConn = compHost.connect();
			const otherConn = otherHost.connect();

			expect(compHost.ownsConnection(compConn)).to.equal(true);
			expect(otherHost.ownsConnection(otherConn)).to.equal(true);
			expect(compHost.ownsConnection(otherConn)).to.equal(false);
			expect(otherHost.ownsConnection(compConn)).to.equal(false);
		});

		it("a drop+recreate yields a new incarnation whose host rejects the old incarnation's connection", async () => {
			const oldHost = resolveHost();
			const oldConn = oldHost.connect();

			await db.exec('drop table comp');
			await db.exec('create table comp (a integer, b integer, v text, primary key (a, b)) using store');

			const newHost = resolveHost();
			// The new incarnation must not adopt the stale connection…
			expect(newHost.ownsConnection(oldConn)).to.equal(false);
			await expectInternal(() => newHost.applyMaintenance(oldConn, [{ kind: 'upsert', row: [9, 9, 'z'] }]));
			// …while the old host stays pinned (by reference) to its own incarnation.
			expect(oldHost.ownsConnection(oldConn)).to.equal(true);
		});

		it('driving the privileged surface with a foreign connection throws INTERNAL', async () => {
			await db.exec('create table other (k integer primary key, v text) using store');
			const compHost = resolveHost('comp');
			const otherConn = resolveHost('other').connect();

			await expectInternal(() => compHost.applyMaintenance(otherConn, []));
			await expectInternal(() => compHost.scanEffective(otherConn, {}));
		});

		it('applyMaintenance is reads-own-writes; pending state is coordinator-shared and discarded on rollback', async () => {
			const host = resolveHost();
			const conn = host.connect();

			const changes = await host.applyMaintenance(conn, [
				{ kind: 'upsert', row: [3, 1, 'z'] },
				{ kind: 'delete-key', key: [1, 2] },
			]);
			expect(changes).to.deep.equal([
				{ op: 'insert', newRow: [3, 1, 'z'] },
				{ op: 'delete', oldRow: [1, 2, 'b'] },
			]);

			// The writing connection's effective state reflects the pending ops…
			expect(await collect(host.scanEffective(conn, {}))).to.deep.equal(
				[[1, 1, 'a'], [2, 1, 'c'], [3, 1, 'z']]);
			// …and — store divergence from the memory suite — so does a sibling
			// connection: pending state lives on the shared per-table coordinator
			// (per-table-coordinator RYOW), not per connection.
			expect(await collect(host.scanEffective(host.connect(), {}))).to.deep.equal(
				[[1, 1, 'a'], [2, 1, 'c'], [3, 1, 'z']]);

			// The committed store is untouched until commit: rollback restores it.
			conn.rollback();
			expect(await collect(host.scanEffective(host.connect(), {}))).to.deep.equal(
				[[1, 1, 'a'], [1, 2, 'b'], [2, 1, 'c']]);
		});

		it('a value-identical upsert is suppressed (no op, nothing reported); a changed value reports update', async () => {
			const host = resolveHost();
			const conn = host.connect();
			const changes = await host.applyMaintenance(conn, [
				{ kind: 'upsert', row: [1, 1, 'a'] },   // value-identical to the committed row → suppressed
				{ kind: 'upsert', row: [1, 2, 'B'] },   // value change at an existing key → update
				{ kind: 'delete-key', key: [9, 9] },    // absent — no effective change
			]);
			// The no-op-write suppression contract (`mv-noop-upsert-suppression`): a
			// value-identical upsert changes nothing, so it queues no op and reports
			// no BackingRowChange — the point-op analogue of replace-all's keyed diff.
			expect(changes).to.deep.equal([
				{ op: 'update', oldRow: [1, 2, 'b'], newRow: [1, 2, 'B'] },
			]);
			conn.rollback();
		});

		it('scanEffective honors equalityPrefix as a leading-PK range and descending order', async () => {
			const host = resolveHost();
			const conn = host.connect();

			expect(await collect(host.scanEffective(conn, { equalityPrefix: [1] }))).to.deep.equal(
				[[1, 1, 'a'], [1, 2, 'b']]);
			expect(await collect(host.scanEffective(conn, { equalityPrefix: [99] }))).to.deep.equal([]);
			expect(await collect(host.scanEffective(conn, { descending: true }))).to.deep.equal(
				[[2, 1, 'c'], [1, 2, 'b'], [1, 1, 'a']]);
		});

		it('delete-by-prefix removes the whole leading-PK slice and reports one delete per row', async () => {
			const host = resolveHost();
			const conn = host.connect();

			const changes = await host.applyMaintenance(conn, [
				{ kind: 'delete-by-prefix', keyPrefix: [1] },
			]);
			expect(changes).to.deep.equal([
				{ op: 'delete', oldRow: [1, 1, 'a'] },
				{ op: 'delete', oldRow: [1, 2, 'b'] },
			]);
			expect(await collect(host.scanEffective(conn, {}))).to.deep.equal([[2, 1, 'c']]);

			// A non-matching prefix is a no-op producing no changes.
			expect(await host.applyMaintenance(conn, [{ kind: 'delete-by-prefix', keyPrefix: [42] }]))
				.to.deep.equal([]);
			conn.rollback();
		});

		it('replace-all realizes the minimal keyed diff, skipping value-identical rows', async () => {
			const host = resolveHost();
			const conn = host.connect();

			const changes = await host.applyMaintenance(conn, [{
				kind: 'replace-all',
				rows: [[1, 1, 'a'], [1, 2, 'B2'], [3, 3, 'n']],
			}]);
			// (1,1) identical → skipped; (1,2) changed → update; (3,3) new → insert;
			// (2,1) absent from the new set → delete (delete pass runs after upserts,
			// in ascending PK order — memory parity).
			expect(changes).to.deep.equal([
				{ op: 'update', oldRow: [1, 2, 'b'], newRow: [1, 2, 'B2'] },
				{ op: 'insert', newRow: [3, 3, 'n'] },
				{ op: 'delete', oldRow: [2, 1, 'c'] },
			]);
			expect(await collect(host.scanEffective(conn, {}))).to.deep.equal(
				[[1, 1, 'a'], [1, 2, 'B2'], [3, 3, 'n']]);
			conn.rollback();
		});

		it('replaceContents atomically replaces the committed contents', async () => {
			const host = resolveHost();
			await host.replaceContents([[5, 1, 'x'], [6, 1, 'y']]);
			expect(await collect(host.scanEffective(host.connect(), {}))).to.deep.equal(
				[[5, 1, 'x'], [6, 1, 'y']]);
		});

		it('replaceContents commits an open coordinator transaction first (DDL-commits posture)', async () => {
			const host = resolveHost();
			const conn = host.connect();
			await host.applyMaintenance(conn, [{ kind: 'upsert', row: [7, 7, 'pending'] }]);

			await host.replaceContents([[5, 1, 'x']]);
			// The pending op was committed, then the bulk replace cleared + rewrote —
			// final contents are exactly the replacement rows, and no transaction is
			// left open (a later rollback has nothing to discard).
			conn.rollback();
			expect(await collect(host.scanEffective(host.connect(), {}))).to.deep.equal([[5, 1, 'x']]);
		});

		it('replaceContents reports a duplicate PK through the onDuplicateKey factory, with no torn state', async () => {
			const host = resolveHost();
			try {
				await host.replaceContents(
					[[7, 1, 'x'], [7, 1, 'y']],
					() => new QuereusError('not a set', StatusCode.CONSTRAINT),
				);
				expect.fail('expected the onDuplicateKey error');
			} catch (e) {
				expect(e).to.be.instanceOf(QuereusError);
				expect((e as QuereusError).message).to.contain('not a set');
				expect((e as QuereusError).code).to.equal(StatusCode.CONSTRAINT);
			}
			// The failed replace must not have torn the committed contents.
			expect(await collect(host.scanEffective(host.connect(), {}))).to.deep.equal(
				[[1, 1, 'a'], [1, 2, 'b'], [2, 1, 'c']]);
		});
	});
}

describe('backing-host capability (store): DESC / NOCASE leading PK', () => {
	let db: Database;
	let provider: KVStoreProvider;
	let storeModule: BackingHostModule;

	beforeEach(async () => {
		db = new Database();
		provider = createProvider();
		storeModule = createIsolatedStoreModule({ provider });
		db.registerModule('store', storeModule);
		// Leading PK column: text under the store's default key collation (NOCASE),
		// DESC direction — prefix bounds must fold BOTH into the encoded bytes.
		await db.exec('create table p (name text, k integer, v text, primary key (name desc, k)) using store');
		await db.exec("insert into p values ('a', 1, 'a1'), ('a', 2, 'a2'), ('b', 1, 'b1')");
	});
	afterEach(async () => {
		await db.close();
		await provider.closeAll();
	});

	function resolveHost(): BackingHost {
		const host = storeModule.getBackingHost!(db, 'main', 'p');
		expect(host).to.not.be.undefined;
		return host!;
	}

	it('scanEffective equalityPrefix matches case-variants under the NOCASE key collation, in DESC key order', async () => {
		const host = resolveHost();
		const conn = host.connect();
		// 'A' ≡ 'a' under the NOCASE key encoding — the prefix seek must find the slice.
		expect(await collect(host.scanEffective(conn, { equalityPrefix: ['A'] }))).to.deep.equal(
			[['a', 1, 'a1'], ['a', 2, 'a2']]);
		// Full scan follows the physical key order: name DESC, k ASC.
		expect(await collect(host.scanEffective(conn, {}))).to.deep.equal(
			[['b', 1, 'b1'], ['a', 1, 'a1'], ['a', 2, 'a2']]);
	});

	it('delete-by-prefix with a case-variant prefix deletes the whole NOCASE slice', async () => {
		const host = resolveHost();
		const conn = host.connect();
		const changes = await host.applyMaintenance(conn, [
			{ kind: 'delete-by-prefix', keyPrefix: ['A'] },
		]);
		expect(changes).to.deep.equal([
			{ op: 'delete', oldRow: ['a', 1, 'a1'] },
			{ op: 'delete', oldRow: ['a', 2, 'a2'] },
		]);
		expect(await collect(host.scanEffective(conn, {}))).to.deep.equal([['b', 1, 'b1']]);
		conn.rollback();
	});

	it('a collation-equal / byte-different upsert is NOT suppressed (byte-faithful skip, memory-host parity)', async () => {
		const host = resolveHost();
		const conn = host.connect();
		// Byte-identical to the committed row → suppressed (writes nothing, reports nothing).
		expect(await host.applyMaintenance(conn, [{ kind: 'upsert', row: ['a', 1, 'a1'] }]))
			.to.deep.equal([]);
		// 'A' NOCASE-matches the stored key 'a' (key identity is collation-aware: same
		// encoded data key) but the skip is byte-faithful (`rowsValueIdentical`), so this
		// is a real update that replaces the stored bytes — never a skip (the engine's
		// vtab/backing-host.ts § value-identical suppression).
		expect(await host.applyMaintenance(conn, [{ kind: 'upsert', row: ['A', 1, 'a1'] }]))
			.to.deep.equal([{ op: 'update', oldRow: ['a', 1, 'a1'], newRow: ['A', 1, 'a1'] }]);
		expect(await collect(host.scanEffective(conn, { equalityPrefix: ['a'] }))).to.deep.equal(
			[['A', 1, 'a1'], ['a', 2, 'a2']]);
		conn.rollback();
	});

	it('replace-all: a collation-equal / byte-different row re-keys; a byte-identical row skips (byte-faithful, memory-host parity)', async () => {
		const host = resolveHost();
		const conn = host.connect();
		// Wholesale replacement with the EXACT committed bytes → every paired row is
		// byte-identical, so the byte-faithful skip fires and nothing is emitted.
		expect(await host.applyMaintenance(conn, [
			{ kind: 'replace-all', rows: [['a', 1, 'a1'], ['a', 2, 'a2'], ['b', 1, 'b1']] },
		])).to.deep.equal([]);

		// Now replace-all where only ('a',1) differs by KEY case ('A'): the key NOCASE-pairs
		// with the stored 'a' (same encoded data key — an update, never insert + delete), but
		// the VALUE compare is byte-faithful, so the byte-different row re-keys the stored
		// bytes. ('a',2) and ('b',1) are byte-identical → skipped.
		expect(await host.applyMaintenance(conn, [
			{ kind: 'replace-all', rows: [['A', 1, 'a1'], ['a', 2, 'a2'], ['b', 1, 'b1']] },
		])).to.deep.equal([
			{ op: 'update', oldRow: ['a', 1, 'a1'], newRow: ['A', 1, 'a1'] },
		]);
		// Full scan follows physical key order (name DESC, k ASC); the re-keyed bytes show.
		expect(await collect(host.scanEffective(conn, {}))).to.deep.equal(
			[['b', 1, 'b1'], ['A', 1, 'a1'], ['a', 2, 'a2']]);
		conn.rollback();
	});
});

/**
 * `quereus.sync.replicate` opt-in: an opted-in backing's maintenance writes are
 * published as local store `DataChangeEvent`s on coordinator commit, so the sync
 * layer records the derivation (migration target). Default off; value-identical
 * re-derivation suppresses (the echo seam); rollback discards. Run against both
 * registration shapes (each wires the same coordinator/emitter pair).
 *
 * The coordinator carries the module's `StoreEventEmitter`, so subscribing to
 * `emitter.onDataChange` captures exactly what the sync layer would see.
 */
const EMIT_FLAVORS: ReadonlyArray<{
	label: string;
	make: (provider: KVStoreProvider, emitter: StoreEventEmitter) => BackingHostModule;
}> = [
	{ label: 'isolated store (IsolationModule(StoreModule))', make: (p, e) => createIsolatedStoreModule({ provider: p, eventEmitter: e }) },
	{ label: 'bare StoreModule', make: (p, e) => new StoreModule(p, e) },
];

for (const flavor of EMIT_FLAVORS) {
	describe(`backing-host quereus.sync.replicate change-log opt-in (${flavor.label})`, () => {
		let db: Database;
		let provider: KVStoreProvider;
		let emitter: StoreEventEmitter;
		let storeModule: BackingHostModule;
		let events: DataChangeEvent[];

		/** Project a captured event to the fields the sync layer keys off. */
		const shape = (e: DataChangeEvent) => ({ type: e.type, key: e.key, oldRow: e.oldRow, newRow: e.newRow });

		beforeEach(() => {
			db = new Database();
			provider = createProvider();
			emitter = new StoreEventEmitter();
			storeModule = flavor.make(provider, emitter);
			db.registerModule('store', storeModule);
			events = [];
			emitter.onDataChange(e => events.push(e));
		});
		afterEach(async () => {
			await db.close();
			await provider.closeAll();
		});

		/**
		 * Create the `repl` backing (composite PK so `key` is an array) and seed it.
		 * `tagOn` carries the `quereus.sync.replicate = true` opt-in. Setup data
		 * events are discarded so each test asserts only its own maintenance.
		 */
		async function setup(tagOn: boolean): Promise<void> {
			const tagClause = tagOn ? ' with tags ("quereus.sync.replicate" = true)' : '';
			await db.exec(`create table repl (a integer, b integer, v text, primary key (a, b)) using store${tagClause}`);
			await db.exec("insert into repl values (1,1,'a'),(1,2,'b'),(2,1,'c')");
			events.length = 0;
		}

		function resolveHost(): BackingHost {
			const host = storeModule.getBackingHost!(db, 'main', 'repl');
			expect(host, "backing host for 'repl'").to.not.be.undefined;
			return host!;
		}

		it('publishes a local insert / update / delete event per realized change on commit', async () => {
			await setup(true);
			const host = resolveHost();
			const conn = host.connect();
			await host.applyMaintenance(conn, [
				{ kind: 'upsert', row: [3, 1, 'z'] },   // new key → insert
				{ kind: 'upsert', row: [1, 2, 'B'] },   // existing key, changed → update
				{ kind: 'delete-key', key: [2, 1] },    // existing → delete
			]);
			// Events ride the coordinator: nothing is delivered until commit.
			expect(events, 'buffered until commit').to.have.length(0);

			await conn.commit();
			expect(events.map(shape)).to.deep.equal([
				{ type: 'insert', key: [3, 1], oldRow: undefined, newRow: [3, 1, 'z'] },
				{ type: 'update', key: [1, 2], oldRow: [1, 2, 'b'], newRow: [1, 2, 'B'] },
				{ type: 'delete', key: [2, 1], oldRow: [2, 1, 'c'], newRow: undefined },
			]);
			// All are local derivations — never marked remote (that's the inbound-sync path).
			expect(events.every(e => !e.remote)).to.equal(true);
		});

		it('suppresses a value-identical upsert (the echo seam): no change, no event', async () => {
			await setup(true);
			const host = resolveHost();
			const conn = host.connect();
			const changes = await host.applyMaintenance(conn, [
				{ kind: 'upsert', row: [1, 1, 'a'] },   // byte-identical to committed → suppressed
			]);
			expect(changes).to.deep.equal([]);
			await conn.commit();
			expect(events).to.have.length(0);
		});

		it('replace-all publishes only the genuine diffs; identical paired rows publish nothing', async () => {
			await setup(true);
			const host = resolveHost();
			const conn = host.connect();
			await host.applyMaintenance(conn, [{
				kind: 'replace-all',
				rows: [[1, 1, 'a'], [1, 2, 'B2'], [3, 3, 'n']],
			}]);
			await conn.commit();
			// (1,1) identical → skipped (no event); (1,2) changed → update; (3,3) new →
			// insert; (2,1) absent → delete. Order matches the returned changes[].
			expect(events.map(shape)).to.deep.equal([
				{ type: 'update', key: [1, 2], oldRow: [1, 2, 'b'], newRow: [1, 2, 'B2'] },
				{ type: 'insert', key: [3, 3], oldRow: undefined, newRow: [3, 3, 'n'] },
				{ type: 'delete', key: [2, 1], oldRow: [2, 1, 'c'], newRow: undefined },
			]);
		});

		it('a replace-all of the exact committed contents publishes nothing (steady-state attach)', async () => {
			await setup(true);
			const host = resolveHost();
			const conn = host.connect();
			await host.applyMaintenance(conn, [{
				kind: 'replace-all',
				rows: [[1, 1, 'a'], [1, 2, 'b'], [2, 1, 'c']],
			}]);
			await conn.commit();
			expect(events).to.have.length(0);
		});

		it('without the tag, maintenance emits no events (default off, no regression)', async () => {
			await setup(false);
			const host = resolveHost();
			const conn = host.connect();
			await host.applyMaintenance(conn, [
				{ kind: 'upsert', row: [3, 1, 'z'] },
				{ kind: 'delete-key', key: [1, 2] },
			]);
			await conn.commit();
			expect(events).to.have.length(0);
		});

		it('a rolled-back maintenance batch publishes nothing', async () => {
			await setup(true);
			const host = resolveHost();
			const conn = host.connect();
			await host.applyMaintenance(conn, [{ kind: 'upsert', row: [9, 9, 'rb'] }]);
			conn.rollback();
			expect(events).to.have.length(0);
		});

		it('rolling back to a savepoint discards only that span\'s queued maintenance events', async () => {
			// The coordinator snapshots `pendingEvents.length` per savepoint and
			// truncates back to it on rollback-to (transaction.ts createSavepoint /
			// rollbackToSavepoint), so maintenance events ride the same eventIndex
			// truncation as data ops: the pre-savepoint batch survives, the batch
			// inside the released span is dropped, and commit fires only the survivor.
			await setup(true);
			const host = resolveHost();
			const conn = host.connect();
			await host.applyMaintenance(conn, [{ kind: 'upsert', row: [5, 5, 'keep'] }]);
			conn.createSavepoint(0);
			await host.applyMaintenance(conn, [{ kind: 'upsert', row: [6, 6, 'drop'] }]);
			conn.rollbackToSavepoint(0);
			await conn.commit();
			expect(events.map(shape)).to.deep.equal([
				{ type: 'insert', key: [5, 5], oldRow: undefined, newRow: [5, 5, 'keep'] },
			]);
		});

		it('ALTER add-tags turns replication on for subsequent maintenance (live propagation)', async () => {
			await setup(false);
			// table_modified propagates to the live StoreTable.updateSchema — no reopen.
			await db.exec('alter table repl add tags ("quereus.sync.replicate" = true)');
			events.length = 0;
			const host = resolveHost();
			const conn = host.connect();
			await host.applyMaintenance(conn, [{ kind: 'upsert', row: [4, 4, 'on'] }]);
			await conn.commit();
			expect(events.map(shape)).to.deep.equal([
				{ type: 'insert', key: [4, 4], oldRow: undefined, newRow: [4, 4, 'on'] },
			]);
		});

		it('ALTER drop-tags turns replication off for subsequent maintenance (live propagation)', async () => {
			await setup(true);
			await db.exec('alter table repl drop tags ("quereus.sync.replicate")');
			events.length = 0;
			const host = resolveHost();
			const conn = host.connect();
			await host.applyMaintenance(conn, [{ kind: 'upsert', row: [4, 4, 'off'] }]);
			await conn.commit();
			expect(events).to.have.length(0);
		});
	});
}

for (const flavor of EMIT_FLAVORS) {
	describe(`backing-host quereus.sync.replicate on store-hosted materialized view (${flavor.label})`, () => {
		let db: Database;
		let provider: KVStoreProvider;
		let emitter: StoreEventEmitter;
		let storeModule: BackingHostModule;
		let events: DataChangeEvent[];

		const shape = (e: DataChangeEvent) => ({ type: e.type, key: e.key, oldRow: e.oldRow, newRow: e.newRow });

		beforeEach(async () => {
			db = new Database();
			provider = createProvider();
			emitter = new StoreEventEmitter();
			storeModule = flavor.make(provider, emitter);
			db.registerModule('store', storeModule);
			events = [];
			emitter.onDataChange(e => events.push(e));

			// Source table + store-hosted materialized view (no replicate tag by default).
			await db.exec(`create table src (k integer primary key, v text) using store`);
			await db.exec(`create materialized view mv using store as select k, v from src`);
			events.length = 0;
		});

		afterEach(async () => {
			await db.close();
			await provider.closeAll();
		});

		function resolveMvHost(): BackingHost {
			const host = storeModule.getBackingHost!(db, 'main', 'mv');
			expect(host, "backing host for 'mv'").to.not.be.undefined;
			return host!;
		}

		it('create-time quereus.sync.replicate = true emits on maintenance', async () => {
			// Drop and re-create the MV with the tag at create time.
			await db.exec(`drop materialized view mv`);
			await db.exec(`create materialized view mv using store as select k, v from src with tags ("quereus.sync.replicate" = true)`);
			events.length = 0;

			const host = resolveMvHost();
			const conn = host.connect();
			await host.applyMaintenance(conn, [{ kind: 'upsert', row: [1, 'hello'] }]);
			await conn.commit();
			expect(events.map(shape)).to.deep.equal([
				{ type: 'insert', key: [1], oldRow: undefined, newRow: [1, 'hello'] },
			]);
		});

		it('without tag, maintenance emits nothing (default off)', async () => {
			const host = resolveMvHost();
			const conn = host.connect();
			await host.applyMaintenance(conn, [{ kind: 'upsert', row: [1, 'hello'] }]);
			await conn.commit();
			expect(events).to.have.length(0);
		});

		it('ALTER add-tags turns MV replication on immediately (live propagation, no reopen)', async () => {
			// materialized_view_modified must refresh the connected StoreTable cache.
			await db.exec(`alter materialized view mv add tags ("quereus.sync.replicate" = true)`);
			events.length = 0;

			const host = resolveMvHost();
			const conn = host.connect();
			await host.applyMaintenance(conn, [{ kind: 'upsert', row: [2, 'on'] }]);
			await conn.commit();
			expect(events.map(shape)).to.deep.equal([
				{ type: 'insert', key: [2], oldRow: undefined, newRow: [2, 'on'] },
			]);
		});

		it('ALTER drop-tags turns MV replication off immediately (live propagation, no reopen)', async () => {
			// Start with tag on, then drop it.
			await db.exec(`drop materialized view mv`);
			await db.exec(`create materialized view mv using store as select k, v from src with tags ("quereus.sync.replicate" = true)`);
			events.length = 0;

			await db.exec(`alter materialized view mv drop tags ("quereus.sync.replicate")`);
			events.length = 0;

			const host = resolveMvHost();
			const conn = host.connect();
			await host.applyMaintenance(conn, [{ kind: 'upsert', row: [3, 'off'] }]);
			await conn.commit();
			expect(events).to.have.length(0);
		});
	});
}

/**
 * Echo-loop quiescence — the spec's explicit cross-peer test (docs/migration.md
 * § Synced vs. local derived tables). Peer A's source write derives + logs the
 * derived row; B ingests source + derived; B's own re-derivation of the ingested
 * source change is value-identical, so suppression drops it → B logs zero
 * B-origin derived entries (no ping-pong). This is heavier than a store-host unit
 * test — it needs a store+`@quereus/sync` two-peer harness (HLC, change log,
 * ingest) — so it is tracked as a follow-up rather than stubbed here; the
 * single-host echo seam (value-identical upsert → no event) is pinned by the
 * suppression test above. See review handoff `sync-derivation-changelog-optin`.
 */
it('echo-loop quiescence across two synced peers (integration; tracked follow-up)');
