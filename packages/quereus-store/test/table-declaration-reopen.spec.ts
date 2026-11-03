/**
 * Reopen-survival guard for table declarations the catalog text used to drop: a column's own
 * `ON CONFLICT` action and the table's `with context` variables. Nothing that stays in one
 * session can see either loss, because the live schema is intact until the text is re-parsed.
 *
 * The column action uses IGNORE rather than ROLLBACK because IGNORE's effect is observable
 * here: a skipped row and no error, against the NOT NULL failure of the default action.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import { StoreModule, InMemoryKVStore, type KVStoreProvider } from '../src/index.js';

// NOTE: duplicated across the store specs; consolidating is tracked by
// tickets/backlog/debt-store-test-shared-inmemory-provider.
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

describe('table declarations survive a store reopen', () => {
	let provider: KVStoreProvider;

	beforeEach(() => {
		provider = createInMemoryProvider();
	});

	afterEach(async () => {
		await provider.closeAll();
	});

	async function persistAndReopen(create: string): Promise<Database> {
		const db1 = new Database();
		const mod1 = new StoreModule(provider);
		db1.registerModule('store', mod1);
		await db1.exec(create);
		await mod1.whenCatalogPersisted();
		await db1.close();

		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);
		const result = await mod2.rehydrateCatalog(db2);
		expect(result.errors, 'catalog rehydrates cleanly').to.have.lengthOf(0);
		return db2;
	}

	it('a non-key column keeps its NOT NULL ON CONFLICT IGNORE', async () => {
		const db = await persistAndReopen('create table t (id integer primary key, x integer not null on conflict ignore) using store');
		await db.exec('insert into t values (1, null)');
		const count = await db.get('select count(*) as cnt from t');
		expect(count?.cnt, 'the violating row was skipped, not raised').to.equal(0);
		await db.close();
	});

	it('a table with context variables stays writable', async () => {
		const db = await persistAndReopen(`create table t (
			id integer primary key,
			v integer not null,
			constraint under_cap check (new.v <= cap)
		) using store with context (cap integer)`);
		await db.exec('insert into t (id, v) with context cap = 10 values (1, 5)');
		const row = await db.get('select v from t where id = 1');
		expect(row?.v).to.equal(5);
		await db.close();
	});
});
