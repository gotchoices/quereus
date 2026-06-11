/**
 * Read-your-own-writes tests for the bare StoreModule (no isolation wrapper).
 *
 * Within an explicit transaction, `StoreTable.query` merges the shared
 * coordinator's pending ops over the committed store — point lookups honor
 * pending puts/deletes, and range/full scans emit a key-ordered merge — while
 * readers outside any transaction (and other connections after rollback) see
 * committed data only.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, type Row, type SqlValue } from '@quereus/quereus';
import {
	StoreModule,
	StoreTable,
	InMemoryKVStore,
	buildDataKey,
	serializeRow,
	type KVStoreProvider,
	type KVStore,
	type IterateOptions,
	type KVEntry,
} from '../src/index.js';

async function collect(db: Database, sql: string): Promise<Record<string, SqlValue>[]> {
	const out: Record<string, SqlValue>[] = [];
	for await (const row of db.eval(sql)) out.push(row);
	return out;
}

function createInMemoryProvider(): KVStoreProvider {
	const stores = new Map<string, InMemoryKVStore>();
	const get = (key: string) => {
		if (!stores.has(key)) stores.set(key, new InMemoryKVStore());
		return stores.get(key)!;
	};
	return {
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
}

/** Exposes the protected merge entry points for direct bounded/reverse tests. */
class HarnessStoreTable extends StoreTable {
	async open(): Promise<KVStore> {
		await this.ensureCoordinator();
		return this.ensureStore();
	}

	iterateMerged(store: KVStore, bounds: IterateOptions, reverse?: boolean): AsyncIterable<KVEntry> {
		return this.iterateEffective(store, bounds, reverse);
	}
}

describe('StoreTable read-your-own-writes (bare StoreModule)', () => {
	let db: Database;
	let provider: KVStoreProvider;
	let module: StoreModule;

	beforeEach(() => {
		db = new Database();
		provider = createInMemoryProvider();
		module = new StoreModule(provider);
		db.registerModule('store', module);
	});

	afterEach(async () => {
		await provider.closeAll();
	});

	it('begin → insert → select sees the row; rollback discards it', async () => {
		await db.exec(`create table t (id integer primary key, v text) using store`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (1, 'a')`);

		const during = await collect(db, `select id, v from t`);
		expect(during).to.deep.equal([{ id: 1, v: 'a' }]);

		await db.exec(`rollback`);
		const after = await collect(db, `select id, v from t`);
		expect(after).to.deep.equal([]);
	});

	it('commit persists mid-transaction rows', async () => {
		await db.exec(`create table t (id integer primary key) using store`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (1), (2)`);
		await db.exec(`commit`);
		const rows = await collect(db, `select id from t`);
		expect(rows).to.deep.equal([{ id: 1 }, { id: 2 }]);
	});

	it('point lookup honors a pending put and a pending delete', async () => {
		await db.exec(`create table t (id integer primary key, v text) using store`);
		await db.exec(`insert into t values (1, 'committed'), (2, 'doomed')`);

		await db.exec(`begin`);
		await db.exec(`update t set v = 'pending' where id = 1`);
		await db.exec(`delete from t where id = 2`);
		await db.exec(`insert into t values (3, 'new')`);

		expect(await collect(db, `select v from t where id = 1`))
			.to.deep.equal([{ v: 'pending' }]);
		expect(await collect(db, `select v from t where id = 2`)).to.deep.equal([]);
		expect(await collect(db, `select v from t where id = 3`))
			.to.deep.equal([{ v: 'new' }]);

		await db.exec(`rollback`);
		expect(await collect(db, `select v from t where id = 1`))
			.to.deep.equal([{ v: 'committed' }]);
		expect(await collect(db, `select v from t where id = 2`))
			.to.deep.equal([{ v: 'doomed' }]);
	});

	it('merged full scan stays in PK order with mixed pending/committed rows (ASC)', async () => {
		await db.exec(`create table t (id integer primary key) using store`);
		await db.exec(`insert into t values (10), (30), (50)`);

		await db.exec(`begin`);
		await db.exec(`insert into t values (5), (20), (60)`);
		await db.exec(`delete from t where id = 30`);

		const rows = await collect(db, `select id from t`);
		expect(rows).to.deep.equal([{ id: 5 }, { id: 10 }, { id: 20 }, { id: 50 }, { id: 60 }]);
		await db.exec(`rollback`);
	});

	it('merged full scan stays in PK order with a DESC PK', async () => {
		await db.exec(`create table t (id integer primary key desc) using store`);
		await db.exec(`insert into t values (10), (30), (50)`);

		await db.exec(`begin`);
		await db.exec(`insert into t values (20), (60)`);

		const rows = await collect(db, `select id from t`);
		expect(rows).to.deep.equal([{ id: 60 }, { id: 50 }, { id: 30 }, { id: 20 }, { id: 10 }]);
		await db.exec(`rollback`);
	});

	it('NOCASE PK pending overwrite merges with its committed entry (no duplicate)', async () => {
		// Default store key collation is NOCASE: 'a' and 'A' share key bytes, so
		// the pending put must shadow the committed entry, not sit beside it.
		await db.exec(`create table t (name text primary key, v integer) using store`);
		await db.exec(`insert into t values ('a', 1)`);

		await db.exec(`begin`);
		await db.exec(`update t set name = 'A', v = 2 where name = 'a'`);

		const rows = await collect(db, `select name, v from t`);
		expect(rows).to.deep.equal([{ name: 'A', v: 2 }]);
		await db.exec(`rollback`);
	});

	it('rollback to savepoint discards only the tail', async () => {
		await db.exec(`create table t (id integer primary key) using store`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (1)`);
		await db.exec(`savepoint s1`);
		await db.exec(`insert into t values (2)`);
		await db.exec(`rollback to s1`);
		await db.exec(`insert into t values (3)`);

		expect(await collect(db, `select id from t`)).to.deep.equal([{ id: 1 }, { id: 3 }]);

		await db.exec(`commit`);
		expect(await collect(db, `select id from t`)).to.deep.equal([{ id: 1 }, { id: 3 }]);
	});

	it('UNIQUE constraints still see pending writes through the merge', async () => {
		await db.exec(`create table t (id integer primary key, u text unique) using store`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (1, 'x')`);
		let failed = false;
		try {
			await db.exec(`insert into t values (2, 'x')`);
		} catch {
			failed = true;
		}
		expect(failed).to.equal(true, 'intra-transaction UNIQUE duplicate must be rejected');
		await db.exec(`rollback`);
	});

	describe('iterateEffective (direct merge harness)', () => {
		it('bounded merge excludes out-of-bounds pending puts; reverse mirrors forward', async () => {
			await db.exec(`create table t (id integer primary key) using store`);
			await db.exec(`insert into t values (10), (30), (50)`);

			const schema = db.schemaManager.getTable('main', 't');
			expect(schema).to.not.equal(undefined);
			const harness = new HarnessStoreTable(db, module, schema!, { collation: 'NOCASE' }, undefined, true);
			const store = await harness.open();

			// Pending ops via the SHARED per-table coordinator (the same one SQL DML
			// would use): puts at 20 and 60, delete of committed 30.
			const coordinator = module.getCoordinator('main.t', { collation: 'NOCASE' });
			coordinator.begin();
			try {
				coordinator.put(buildDataKey([20]), serializeRow([20] as Row));
				coordinator.put(buildDataKey([60]), serializeRow([60] as Row));
				coordinator.delete(buildDataKey([30]));

				const keysOf = async (bounds: IterateOptions, reverse?: boolean) => {
					const out: string[] = [];
					for await (const entry of harness.iterateMerged(store, bounds, reverse)) {
						out.push(Array.from(entry.key).join(','));
					}
					return out;
				};
				const expectKeys = (values: number[]) =>
					values.map(v => Array.from(buildDataKey([v])).join(','));

				// Unbounded: pending 20/60 merge in, deleted 30 suppressed.
				const forward = await keysOf({});
				expect(forward).to.deep.equal(expectKeys([10, 20, 50, 60]));

				// Reverse yields the exact reverse of forward.
				const reversed = await keysOf({}, true);
				expect(reversed).to.deep.equal([...forward].reverse());

				// Bounded window [15, 45): pending 20 included, committed 30 stays
				// suppressed, pending 60 (out of bounds) must not leak in.
				const bounds: IterateOptions = { gte: buildDataKey([15]), lt: buildDataKey([45]) };
				expect(await keysOf(bounds)).to.deep.equal(expectKeys([20]));
				expect(await keysOf(bounds, true)).to.deep.equal(expectKeys([20]));
			} finally {
				coordinator.rollback();
			}
		});

		it('degrades to the committed iterate when no transaction is active', async () => {
			await db.exec(`create table t (id integer primary key) using store`);
			await db.exec(`insert into t values (1), (2)`);

			const schema = db.schemaManager.getTable('main', 't');
			const harness = new HarnessStoreTable(db, module, schema!, { collation: 'NOCASE' }, undefined, true);
			const store = await harness.open();

			const out: Uint8Array[] = [];
			for await (const entry of harness.iterateMerged(store, {})) {
				out.push(entry.key);
			}
			expect(out).to.deep.equal([buildDataKey([1]), buildDataKey([2])]);
		});
	});
});
