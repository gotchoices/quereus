/**
 * Persistence of store-backed secondary indexes across close → reopen.
 *
 * Each table's CREATE INDEX DDL is bundled into its catalog entry (keyed
 * `{schema}.{table}`), so a `CREATE INDEX` on a `using store` table survives
 * closeAll() → reopen → rehydrateCatalog: the index reappears in `index_info`,
 * its backing KV store is reattached (not rebuilt), DML maintains it, and any
 * derived UNIQUE / partial / collation / desc / tags round-trip.
 *
 * Uses a *persistent* in-memory provider (no-op close, like real disk) plus
 * `open()` / `reopen()` helpers, the only way to express close → reopen against
 * the same storage — mirroring tag-persistence.spec.ts. The provider also
 * implements `deleteIndexStore` / `deleteTableStores` / `renameTableStores` over
 * its store map so DROP INDEX / DROP TABLE / RENAME TABLE teardown + relocation
 * are observable.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, asyncIterableToArray, type SqlValue } from '@quereus/quereus';
import {
	StoreModule,
	InMemoryKVStore,
	buildCatalogKey,
	type KVStore,
	type KVStoreProvider,
} from '../src/index.js';

/**
 * Persistent in-memory provider: logical close is a no-op so data survives a
 * StoreModule.closeAll(), and delete/rename hooks mutate the same store map so
 * DROP/RENAME physical teardown is observable. `_hardClose` is the real teardown.
 */
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
	const idxPrefix = (s: string, t: string) => `${s}.${t}_idx_`;

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
		async deleteTableStores(s: string, t: string) {
			stores.delete(dataKey(s, t));
			stores.delete(statsKey(s, t));
			const prefix = idxPrefix(s, t);
			for (const key of [...stores.keys()]) {
				if (key.startsWith(prefix)) stores.delete(key);
			}
		},
		async renameTableStores(s: string, oldName: string, newName: string) {
			const move = (from: string, to: string) => {
				const store = stores.get(from);
				if (store) { stores.set(to, store); stores.delete(from); }
			};
			move(dataKey(s, oldName), dataKey(s, newName));
			const oldPrefix = idxPrefix(s, oldName);
			for (const key of [...stores.keys()]) {
				if (key.startsWith(oldPrefix)) {
					move(key, idxKey(s, newName, key.substring(oldPrefix.length)));
				}
			}
		},
		async closeAll() { /* data survives module close, mirroring real disk */ },
		_hardClose() {
			for (const s of stores.values()) void s.close();
			stores.clear();
		},
	};
}

describe('StoreModule secondary-index persistence', () => {
	let provider: ReturnType<typeof createPersistentProvider>;

	beforeEach(() => {
		provider = createPersistentProvider();
	});

	afterEach(() => {
		provider._hardClose();
	});

	/** Phase 1: a fresh db + module over the shared provider. */
	function open(): { db: Database; mod: StoreModule } {
		const db = new Database();
		const mod = new StoreModule(provider);
		db.registerModule('store', mod);
		return { db, mod };
	}

	/** Phase 2: a brand-new db + module rehydrates the same provider's catalog. */
	async function reopen(): Promise<{ db: Database; mod: StoreModule }> {
		const db = new Database();
		const mod = new StoreModule(provider);
		db.registerModule('store', mod);
		const result = await mod.rehydrateCatalog(db);
		expect(result.errors, 're-parsed catalog bundle parses cleanly').to.have.lengthOf(0);
		return { db, mod };
	}

	async function indexInfo(db: Database, table: string): Promise<Record<string, SqlValue>[]> {
		return await asyncIterableToArray(db.eval(`select * from index_info('${table}')`)) as Record<string, SqlValue>[];
	}

	async function rows(db: Database, sql: string): Promise<Record<string, SqlValue>[]> {
		return await asyncIterableToArray(db.eval(sql)) as Record<string, SqlValue>[];
	}

	/** Number of entries in the backing index KV store (one per indexed row). */
	function indexStoreSize(table: string, indexName: string, schema = 'main'): number {
		const s = provider.stores.get(`${schema}.${table}_idx_${indexName}`);
		return s ? s.size : 0;
	}

	/** Decoded catalog bundle for a table, or undefined when absent. */
	async function catalogEntry(table: string, schema = 'main'): Promise<string | undefined> {
		const catalog = await provider.getCatalogStore();
		const raw = await catalog.get(buildCatalogKey(schema, table));
		return raw ? new TextDecoder().decode(raw) : undefined;
	}

	it('plain CREATE INDEX survives reopen; backing store reattaches and DML maintains it', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index ix_b on t (b)`);
		await db.exec(`insert into t values (1, 10), (2, 20), (3, 30)`);
		expect(indexStoreSize('t', 'ix_b'), 'index has one entry per row pre-reopen').to.equal(3);
		await mod.closeAll();

		const { db: db2 } = await reopen();

		// index_info lists the index after reopen.
		const info = await indexInfo(db2, 't');
		expect(info.map(r => r.index_name)).to.include('ix_b');

		// Backing store entries SURVIVED (reattached, not rebuilt or lost).
		expect(indexStoreSize('t', 'ix_b'), 'backing entries survive reopen').to.equal(3);

		// DML after reopen maintains the rehydrated index.
		await db2.exec(`insert into t values (4, 40)`);
		expect(indexStoreSize('t', 'ix_b'), 'INSERT grows the index store').to.equal(4);

		// An index-backed predicate returns the right rows.
		const r = await rows(db2, `select id from t where b = 20`);
		expect(r).to.deep.equal([{ id: 2 }]);
	});

	it('CREATE UNIQUE INDEX survives reopen and still rejects duplicates', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, email text) using store`);
		await db.exec(`create unique index uq_email on t (email)`);
		await db.exec(`insert into t values (1, 'a@x.com')`);
		await mod.closeAll();

		const { db: db2 } = await reopen();

		const uq = (await indexInfo(db2, 't')).find(r => r.index_name === 'uq_email')!;
		expect(uq, 'unique index present').to.not.be.undefined;
		expect(uq.unique, 'unique flag round-trips').to.equal(1);

		// Duplicate rejected, distinct succeeds (derived UNIQUE constraint enforces).
		let rejected = false;
		try {
			await db2.exec(`insert into t values (2, 'a@x.com')`);
		} catch (e) {
			rejected = true;
			expect(String(e)).to.match(/constraint/i);
		}
		expect(rejected, 'duplicate email rejected after reopen').to.be.true;
		await db2.exec(`insert into t values (3, 'b@x.com')`);
	});

	it('partial CREATE INDEX (WHERE) survives reopen; only in-scope rows are indexed', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index ix_pos on t (b) where b > 0`);
		// Two in-scope rows, one out-of-scope — only the in-scope rows index.
		await db.exec(`insert into t values (1, 10), (2, 20), (3, -5)`);
		expect(indexStoreSize('t', 'ix_pos'), 'only in-scope rows indexed at build').to.equal(2);
		await mod.closeAll();

		const { db: db2 } = await reopen();

		const ix = (await indexInfo(db2, 't')).find(r => r.index_name === 'ix_pos')!;
		expect(ix.partial, 'partial flag round-trips').to.equal(1);
		expect(indexStoreSize('t', 'ix_pos'), 'backing entries survive reopen').to.equal(2);

		// An out-of-scope INSERT after reopen adds NO index entry; an in-scope one does.
		await db2.exec(`insert into t values (4, -1)`);
		expect(indexStoreSize('t', 'ix_pos'), 'out-of-scope INSERT adds no entry').to.equal(2);
		await db2.exec(`insert into t values (5, 50)`);
		expect(indexStoreSize('t', 'ix_pos'), 'in-scope INSERT adds an entry').to.equal(3);
	});

	it('UPDATE relocates a full-index entry on the rehydrated index (no stale key leak)', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index ix_b on t (b)`);
		await db.exec(`insert into t values (1, 10)`);
		await mod.closeAll();

		const { db: db2 } = await reopen();

		// Mutating the indexed column re-keys the single backing entry: the count
		// stays 1 only if the old (b=10) key was removed before the new (b=99) key
		// was written. A leak would leave two entries.
		await db2.exec(`update t set b = 99 where id = 1`);
		expect(indexStoreSize('t', 'ix_b'), 'UPDATE re-keys without leaking the old entry').to.equal(1);
		expect(await rows(db2, `select id from t where b = 99`)).to.deep.equal([{ id: 1 }]);
		expect(await rows(db2, `select id from t where b = 10`), 'old value no longer present').to.deep.equal([]);
	});

	it('UPDATE across a partial-index predicate scope maintains the rehydrated backing store both ways', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index ix_pos on t (b) where b > 0`);
		await db.exec(`insert into t values (1, 10)`);
		expect(indexStoreSize('t', 'ix_pos')).to.equal(1);
		await mod.closeAll();

		const { db: db2 } = await reopen();

		// in-scope → out-of-scope: the old entry is removed and none is added.
		await db2.exec(`update t set b = -5 where id = 1`);
		expect(indexStoreSize('t', 'ix_pos'), 'edit out of scope drops the entry').to.equal(0);

		// out-of-scope → in-scope: an entry is added with no stale delete to undo it.
		await db2.exec(`update t set b = 7 where id = 1`);
		expect(indexStoreSize('t', 'ix_pos'), 'edit back into scope re-adds the entry').to.equal(1);

		// in-scope → in-scope: the entry is re-keyed in place, count unchanged.
		await db2.exec(`update t set b = 8 where id = 1`);
		expect(indexStoreSize('t', 'ix_pos'), 'in-scope→in-scope stays a single entry').to.equal(1);
	});

	it('DESC + COLLATE index columns round-trip across reopen', async () => {
		const { db, mod } = open();
		// Collation flows into the index by inheriting the column's COLLATE (the live
		// CREATE INDEX path does not accept an inline per-column COLLATE — a separate
		// pre-existing engine limitation); the persisted DDL still emits the explicit
		// `COLLATE NOCASE DESC`, which import unwraps.
		await db.exec(`create table t (id integer primary key, name text collate nocase) using store`);
		await db.exec(`create index ix_name on t (name desc)`);
		await db.exec(`insert into t values (1, 'Alice')`);
		await mod.closeAll();

		const { db: db2 } = await reopen();
		const col = (await indexInfo(db2, 't')).find(r => r.index_name === 'ix_name')!;
		expect(col.desc, 'desc round-trips').to.equal(1);
		expect(col.collation, 'collation round-trips').to.equal('NOCASE');
	});

	it('a multi-index table rehydrates both indexes cleanly (table-before-indexes)', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, a integer, b integer) using store`);
		await db.exec(`create index ix_a on t (a)`);
		await db.exec(`create index ix_b on t (b)`);
		await db.exec(`insert into t values (1, 10, 100)`);
		await mod.closeAll();

		// reopen() already asserts result.errors is empty (bundle imports in order).
		const { db: db2 } = await reopen();
		const names = (await indexInfo(db2, 't')).map(r => r.index_name);
		expect(names).to.include.members(['ix_a', 'ix_b']);
	});

	it('DROP INDEX is durable: index absent, bundle no longer carries it, backing store gone', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index ix_b on t (b)`);
		await db.exec(`insert into t values (1, 10)`);
		expect(indexStoreSize('t', 'ix_b')).to.equal(1);

		await db.exec(`drop index ix_b`);
		// Backing store torn down immediately (deleteIndexStore).
		expect(indexStoreSize('t', 'ix_b'), 'backing store gone after drop').to.equal(0);
		// Bundle no longer carries the index line.
		expect(await catalogEntry('t'), 'bundle drops the index DDL').to.not.match(/CREATE INDEX/i);
		await mod.closeAll();

		const { db: db2 } = await reopen();
		const names = (await indexInfo(db2, 't')).map(r => r.index_name);
		expect(names, 'index absent after reopen').to.not.include('ix_b');
	});

	it('DROP TABLE then reopen: no table/index resurrection, no orphan catalog entry', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index ix_b on t (b)`);
		await db.exec(`insert into t values (1, 10)`);

		await db.exec(`drop table t`);
		expect(await catalogEntry('t'), 'catalog entry removed on DROP TABLE').to.be.undefined;
		expect(indexStoreSize('t', 'ix_b'), 'index store torn down on DROP TABLE').to.equal(0);
		await mod.closeAll();

		const { db: db2 } = await reopen();
		expect(db2.schemaManager.findTable('t'), 'table does not resurrect').to.be.undefined;
	});

	it('RENAME TABLE then reopen: index present under new name, absent under old', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index ix_b on t (b)`);
		await db.exec(`insert into t values (1, 10), (2, 20)`);

		await db.exec(`alter table t rename to t2`);
		await mod.closeAll();

		const { db: db2 } = await reopen();

		// Index present under the new name; data survived the relocation.
		const names = (await indexInfo(db2, 't2')).map(r => r.index_name);
		expect(names, 'index present under new name').to.include('ix_b');
		expect(indexStoreSize('t2', 'ix_b'), 'backing entries relocated under new name').to.equal(2);
		const r = await rows(db2, `select id from t2 where b = 20`);
		expect(r).to.deep.equal([{ id: 2 }]);

		// Old name is gone (no catalog entry, no live table).
		expect(await catalogEntry('t'), 'old catalog entry removed').to.be.undefined;
		expect(db2.schemaManager.findTable('t'), 'old name not present').to.be.undefined;
	});

	it('ALTER INDEX SET / ADD / DROP TAGS round-trip via index_info after reopen', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index ix_b on t (b)`);
		await db.exec(`insert into t values (1, 10)`);

		// SET (whole-set replace), then ADD (merge), then DROP one key.
		await db.exec(`alter index ix_b set tags (owner = 'search', purpose = 'lookup')`);
		await db.exec(`alter index ix_b add tags (team = 'core')`);
		await db.exec(`alter index ix_b drop tags (purpose)`);
		await mod.closeAll();

		const { db: db2 } = await reopen();
		const ix = (await indexInfo(db2, 't')).find(r => r.index_name === 'ix_b')!;
		expect(JSON.parse(ix.tags as string)).to.deep.equal({ owner: 'search', team: 'core' });
	});

	it('inline UNIQUE constraint + a separate CREATE INDEX on one table both survive reopen', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, email text, b integer, constraint uq_email unique (email)) using store`);
		await db.exec(`create index ix_b on t (b)`);
		await db.exec(`insert into t values (1, 'a@x', 10)`);
		await mod.closeAll();

		const { db: db2 } = await reopen();

		// The separate CREATE INDEX round-trips via its own bundle line.
		const names = (await indexInfo(db2, 't')).map(r => r.index_name);
		expect(names, 'separate index present').to.include('ix_b');

		// The inline UNIQUE round-trips via the table DDL (table constraint) and
		// still enforces — and is NOT doubled by an extra CREATE INDEX line.
		const entry = (await catalogEntry('t'))!;
		expect((entry.match(/CREATE INDEX/gi) ?? []).length, 'inline UNIQUE not emitted as CREATE INDEX').to.equal(1);
		let rejected = false;
		try {
			await db2.exec(`insert into t values (2, 'a@x', 99)`);
		} catch (e) {
			rejected = true;
			expect(String(e)).to.match(/constraint/i);
		}
		expect(rejected, 'inline UNIQUE still enforces after reopen').to.be.true;
	});

	it('CREATE INDEX produces exactly one effective catalog write (listener skips identical bundle)', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`insert into t values (1, 10)`); // persist table DDL (ddlSaved = true) before spying

		const catalog: KVStore = await provider.getCatalogStore();
		let putCount = 0;
		const origPut = catalog.put.bind(catalog);
		catalog.put = async (key: Uint8Array, value: Uint8Array) => {
			putCount++;
			await origPut(key, value);
		};

		await db.exec(`create index ix_b on t (b)`);
		await mod.whenCatalogPersisted();

		// createIndex writes the bundle once; the follow-up table_modified listener
		// regenerates an identical bundle and skips — no double-write.
		expect(putCount, 'exactly one catalog write for CREATE INDEX').to.equal(1);

		const { db: db2 } = await reopen();
		expect((await indexInfo(db2, 't')).map(r => r.index_name)).to.include('ix_b');
	});
});
