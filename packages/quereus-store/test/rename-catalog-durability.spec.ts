/**
 * Durability of the catalog bundle across ALTER TABLE RENAME.
 *
 * A rename must never durably write a table definition that names the pre-rename
 * table or column: the engine's rename propagation runs only *after* the module's
 * hook returns, so a module that persists first would write a stale bundle and rely
 * on a follow-up `table_modified` event to correct it. A crash — or a failed second
 * write — in that window strands an un-rehydratable definition on disk.
 *
 * `index-persistence.spec.ts` covers the partial-index predicate under the same
 * invariant (its `reopen()` harness is index-shaped). This file covers the other
 * two self-naming parts of a table's own definition: CHECK constraint expressions
 * and self-referencing foreign keys.
 *
 * Every test asserts on the *whole* sequence of durable catalog writes, not just
 * the last one — the final entry has always been correct, which is exactly why the
 * stale intermediate went unnoticed.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import { StoreModule, InMemoryKVStore, type KVStoreProvider } from '../src/index.js';

/** Persistent in-memory provider: logical close is a no-op, so data survives closeAll(). */
function createPersistentProvider(): KVStoreProvider & {
	stores: Map<string, InMemoryKVStore>;
	_hardClose: () => void;
} {
	const stores = new Map<string, InMemoryKVStore>();
	const getOrCreate = (key: string): InMemoryKVStore => {
		let s = stores.get(key);
		if (!s) {
			s = new InMemoryKVStore();
			stores.set(key, s);
		}
		return s;
	};
	const dataKey = (s: string, t: string) => `${s}.${t}`;
	const statsKey = (s: string, t: string) => `${s}.${t}.__stats__`;
	const idxKey = (s: string, t: string, i: string) => `${s}.${t}_idx_${i}`;

	return {
		stores,
		async getStore(s: string, t: string) { return getOrCreate(dataKey(s, t)); },
		async getIndexStore(s: string, t: string, i: string) { return getOrCreate(idxKey(s, t, i)); },
		async getStatsStore(s: string, t: string) { return getOrCreate(statsKey(s, t)); },
		async getCatalogStore() { return getOrCreate('__catalog__'); },
		async closeStore() { /* durable */ },
		async closeIndexStore() { /* durable */ },
		async deleteIndexStore(s: string, t: string, i: string) {
			stores.delete(idxKey(s, t, i));
		},
		async deleteTableStores(s: string, t: string, indexNames: readonly string[]) {
			stores.delete(dataKey(s, t));
			stores.delete(statsKey(s, t));
			for (const i of indexNames) stores.delete(idxKey(s, t, i));
		},
		async renameTableStores(s: string, oldName: string, newName: string, indexNames: readonly string[]) {
			const move = (from: string, to: string) => {
				const store = stores.get(from);
				if (store) { stores.set(to, store); stores.delete(from); }
			};
			move(dataKey(s, oldName), dataKey(s, newName));
			for (const i of indexNames) move(idxKey(s, oldName, i), idxKey(s, newName, i));
		},
		async closeAll() { /* data survives module close, mirroring real disk */ },
		_hardClose() {
			for (const s of stores.values()) void s.close();
			stores.clear();
		},
	};
}

describe('StoreModule rename catalog durability', () => {
	let provider: ReturnType<typeof createPersistentProvider>;

	beforeEach(() => {
		provider = createPersistentProvider();
	});

	afterEach(() => {
		provider._hardClose();
	});

	function open(): { db: Database; mod: StoreModule } {
		const db = new Database();
		const mod = new StoreModule(provider);
		db.registerModule('store', mod);
		return { db, mod };
	}

	async function reopen(): Promise<{ db: Database; mod: StoreModule }> {
		const db = new Database();
		const mod = new StoreModule(provider);
		db.registerModule('store', mod);
		const result = await mod.rehydrateCatalog(db);
		expect(result.errors, 're-parsed catalog bundle parses cleanly').to.have.lengthOf(0);
		return { db, mod };
	}

	/** Record the DDL of every value durably written to the catalog store from now on. */
	async function traceCatalogWrites(): Promise<string[]> {
		const catalog = await provider.getCatalogStore();
		const writes: string[] = [];
		const originalPut = catalog.put.bind(catalog);
		catalog.put = async (key, value, options?) => {
			writes.push(new TextDecoder().decode(value));
			await originalPut(key, value, options);
		};
		return writes;
	}

	/** Assert no durable write matched `stale`, and that exactly `expected` writes happened. */
	function expectCleanWrites(writes: readonly string[], stale: RegExp, expected: number): void {
		for (const ddl of writes) {
			expect(ddl, `no bundle written during the rename matches ${stale}`).to.not.match(stale);
		}
		expect(writes.length, 'the rename persisted exactly one bundle').to.equal(expected);
	}

	/** Whether `sql` is rejected by a constraint. */
	async function violates(db: Database, sql: string): Promise<boolean> {
		try {
			await db.exec(sql);
			return false;
		} catch (e) {
			expect(String(e)).to.match(/constraint|foreign key/i);
			return true;
		}
	}

	it('RENAME COLUMN never durably writes a CHECK expression naming the old column', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, b integer check (b > 0)) using store`);
		const writes = await traceCatalogWrites();

		await db.exec(`alter table t rename column b to c`);
		await mod.whenCatalogPersisted();
		expectCleanWrites(writes, /check[^)]*\(\s*b\s*>\s*0\s*\)/i, 1);

		await mod.closeAll();
		const { db: db2 } = await reopen(); // asserts zero rehydration errors
		expect(await violates(db2, `insert into t values (1, -1)`), 'CHECK still enforced after reopen').to.be.true;
		await db2.exec(`insert into t values (2, 5)`);
	});

	it('RENAME COLUMN never durably writes a self-FK referencing the old column name', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, p integer null, foreign key (p) references t(id)) using store`);
		const writes = await traceCatalogWrites();

		await db.exec(`alter table t rename column id to id2`);
		await mod.whenCatalogPersisted();
		expectCleanWrites(writes, /references\s+t\s*\(\s*id\s*\)/i, 1);

		await mod.closeAll();
		const { db: db2 } = await reopen();
		await db2.exec(`insert into t values (1, null)`);
		expect(await violates(db2, `insert into t values (2, 99)`), 'self-FK still enforced after reopen').to.be.true;
		await db2.exec(`insert into t values (3, 1)`);
	});

	it('RENAME TABLE never durably writes a CHECK or self-FK naming the old table', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (
			id integer primary key, p integer null, b integer,
			check (t.b > 0),
			foreign key (p) references t(id)
		) using store`);
		const writes = await traceCatalogWrites();

		await db.exec(`alter table t rename to t2`);
		await mod.whenCatalogPersisted();
		// `t.b` in the CHECK and `references t(id)` in the FK both name the vanished
		// table — and `removeTableDDL` drops the old bundle right after this write.
		expectCleanWrites(writes, /\bt\.b\b|references\s+t\s*\(/i, 1);

		await mod.closeAll();
		const { db: db2 } = await reopen();
		expect(await violates(db2, `insert into t2 values (1, null, -1)`), 'CHECK still enforced after reopen').to.be.true;
		await db2.exec(`insert into t2 values (1, null, 5)`);
		expect(await violates(db2, `insert into t2 values (2, 99, 5)`), 'self-FK still enforced after reopen').to.be.true;
		await db2.exec(`insert into t2 values (3, 1, 5)`);
	});
});
