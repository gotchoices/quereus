/**
 * Repro/regression tests: the sync store-adapter must key rows IDENTICALLY to
 * StoreTable — including per-column PK key collations. A text PK column with a
 * collation that diverges from the table-level key collation K (e.g.
 * `collate binary` PK on a default-NOCASE store) is encoded under its own
 * collation by the store; the adapter must match those bytes or remote
 * inserts land at phantom keys and remote deletes miss.
 */

import { expect } from 'chai';
import { Database, type SqlValue } from '@quereus/quereus';
import {
	StoreModule,
	StoreEventEmitter,
	InMemoryKVStore,
	type KVStoreProvider,
} from '@quereus/store';
import { createStoreAdapter } from '../../src/sync/store-adapter.js';
import type { ApplyToStoreCallback } from '../../src/sync/protocol.js';

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

describe('store-adapter PK key collation', () => {
	let db: Database;
	let provider: KVStoreProvider;
	let events: StoreEventEmitter;
	let applyToStore: ApplyToStoreCallback;

	beforeEach(() => {
		db = new Database();
		provider = createInMemoryProvider();
		events = new StoreEventEmitter();
		db.registerModule('store', new StoreModule(provider, events));
		applyToStore = createStoreAdapter({
			db,
			getKVStore: (schemaName, tableName) => provider.getStore(schemaName, tableName),
			events,
			getTableSchema: (schemaName, tableName) => db.schemaManager.getTable(schemaName, tableName),
			collation: 'NOCASE',
		});
	});

	afterEach(async () => {
		await provider.closeAll();
	});

	it('control: remote insert/delete round-trips when PK collation matches K', async () => {
		await db.exec(`create table t (x text primary key, v text) using store`);
		await db.exec(`insert into t values ('A', 'local')`);

		let res = await applyToStore([
			{ type: 'insert', schema: 'main', table: 't', pk: ['B'], columns: { v: 'remote' } },
		], [], { remote: true });
		expect(res.errors).to.have.length(0);
		expect(await collect(db, `select v from t where x = 'B'`)).to.deep.equal([{ v: 'remote' }]);

		res = await applyToStore([
			{ type: 'delete', schema: 'main', table: 't', pk: ['A'] },
		], [], { remote: true });
		expect(res.errors).to.have.length(0);
		expect(await collect(db, `select x from t where x = 'A'`)).to.deep.equal([]);
	});

	it('remote insert on a divergent-collation PK lands at the key the store reads', async () => {
		await db.exec(`create table t (x text collate binary primary key, v text) using store`);

		const res = await applyToStore([
			{ type: 'insert', schema: 'main', table: 't', pk: ['A'], columns: { v: 'remote' } },
		], [], { remote: true });
		expect(res.errors).to.have.length(0);

		// Point lookup goes through buildDataKey with the store's per-column PK
		// collations — a mismatched adapter key makes this come back empty.
		expect(await collect(db, `select v from t where x = 'A'`)).to.deep.equal([{ v: 'remote' }]);
	});

	it('remote delete on a divergent-collation PK removes the store-written row', async () => {
		await db.exec(`create table t (x text collate binary primary key, v text) using store`);
		await db.exec(`insert into t values ('A', 'local')`);

		const res = await applyToStore([
			{ type: 'delete', schema: 'main', table: 't', pk: ['A'] },
		], [], { remote: true });
		expect(res.errors).to.have.length(0);

		// Full scan — independent of point-lookup key bytes, so a missed delete
		// (adapter keyed 'A' under NOCASE, store wrote it under BINARY) shows up.
		expect(await collect(db, `select x from t`)).to.deep.equal([]);
	});

	it('remote update on a divergent-collation PK modifies the existing row in place', async () => {
		await db.exec(`create table t (x text collate binary primary key, v text) using store`);
		await db.exec(`insert into t values ('A', 'local')`);

		const res = await applyToStore([
			{ type: 'update', schema: 'main', table: 't', pk: ['A'], columns: { v: 'remote' } },
		], [], { remote: true });
		expect(res.errors).to.have.length(0);

		// A mismatched key makes the UPSERT miss the existing row and write a
		// phantom second copy instead of updating in place.
		expect(await collect(db, `select x, v from t`)).to.deep.equal([{ x: 'A', v: 'remote' }]);
	});
});
