/**
 * Tests for DESC primary-key iteration order in StoreTable.
 *
 * Exercises StoreModule directly (without the isolation layer overlay) so the
 * encoded byte order from `buildDataKey(..., pkDirections)` is what drives the
 * natural scan. The isolation-layer wrapped path of DESC iteration is tracked
 * separately (see MEMORY_ONLY_FILES exclusion of 40.1-pk-desc-direction.sqllogic
 * in the engine logic tests).
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, type SqlValue } from '@quereus/quereus';
import {
	StoreModule,
	InMemoryKVStore,
	type KVStoreProvider,
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

describe('StoreTable PK DESC iteration order', () => {
	let db: Database;
	let provider: KVStoreProvider;

	beforeEach(() => {
		db = new Database();
		provider = createInMemoryProvider();
		db.registerModule('store', new StoreModule(provider));
	});

	afterEach(async () => {
		await provider.closeAll();
	});

	it('INTEGER PRIMARY KEY DESC iterates descending', async () => {
		await db.exec(`create table t (id integer primary key desc) using store`);
		await db.exec(`insert into t values (1), (3), (2)`);
		const rows = await collect(db, `select id from t`);
		expect(rows).to.deep.equal([{ id: 3 }, { id: 2 }, { id: 1 }]);
	});

	it('TEXT PRIMARY KEY DESC iterates descending', async () => {
		await db.exec(`create table t (name text primary key desc) using store`);
		await db.exec(`insert into t values ('banana'), ('cherry'), ('apple')`);
		const rows = await collect(db, `select name from t`);
		expect(rows).to.deep.equal([
			{ name: 'cherry' }, { name: 'banana' }, { name: 'apple' },
		]);
	});

	it('REAL PRIMARY KEY DESC iterates descending', async () => {
		await db.exec(`create table t (val real primary key desc) using store`);
		await db.exec(`insert into t values (1.5), (3.7), (2.1)`);
		const rows = await collect(db, `select val from t`);
		expect(rows).to.deep.equal([{ val: 3.7 }, { val: 2.1 }, { val: 1.5 }]);
	});

	it('table-level PRIMARY KEY (col DESC) iterates descending', async () => {
		await db.exec(`create table t (name text, primary key (name desc)) using store`);
		await db.exec(`insert into t values ('banana'), ('cherry'), ('apple')`);
		const rows = await collect(db, `select name from t`);
		expect(rows).to.deep.equal([
			{ name: 'cherry' }, { name: 'banana' }, { name: 'apple' },
		]);
	});

	it('composite (ASC, DESC) groups primary ASC, secondary DESC within group', async () => {
		await db.exec(`
			create table t (
				category text,
				seq integer,
				primary key (category asc, seq desc)
			) using store
		`);
		await db.exec(`insert into t values ('a', 1), ('a', 2), ('a', 3), ('b', 1), ('b', 2)`);
		const rows = await collect(db, `select category, seq from t`);
		expect(rows).to.deep.equal([
			{ category: 'a', seq: 3 },
			{ category: 'a', seq: 2 },
			{ category: 'a', seq: 1 },
			{ category: 'b', seq: 2 },
			{ category: 'b', seq: 1 },
		]);
	});

	it('UPDATE on a DESC PK round-trips through encoded key', async () => {
		await db.exec(`create table t (id integer primary key desc, v text) using store`);
		await db.exec(`insert into t values (1, 'a'), (2, 'b'), (3, 'c')`);
		await db.exec(`update t set v = 'B' where id = 2`);
		const rows = await collect(db, `select id, v from t`);
		expect(rows).to.deep.equal([
			{ id: 3, v: 'c' },
			{ id: 2, v: 'B' },
			{ id: 1, v: 'a' },
		]);
	});

	it('DELETE on a DESC PK removes the row at the encoded key', async () => {
		await db.exec(`create table t (id integer primary key desc) using store`);
		await db.exec(`insert into t values (1), (2), (3)`);
		await db.exec(`delete from t where id = 2`);
		const rows = await collect(db, `select id from t`);
		expect(rows).to.deep.equal([{ id: 3 }, { id: 1 }]);
	});
});
