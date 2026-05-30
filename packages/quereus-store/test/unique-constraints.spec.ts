/**
 * Tests for non-PK UNIQUE constraint enforcement in StoreTable.
 *
 * Exercises StoreModule directly (without the isolation layer overlay) so the
 * checks in StoreTable.update are observable. The isolation-layer wrapped path
 * is covered separately by the engine's logic tests.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, type SqlValue, type ChangeScope, type WatchEvent, type DatabaseDataChangeEvent } from '@quereus/quereus';

async function collect(db: Database, sql: string): Promise<Record<string, SqlValue>[]> {
	const out: Record<string, SqlValue>[] = [];
	for await (const row of db.eval(sql)) out.push(row);
	return out;
}
import {
	StoreModule,
	InMemoryKVStore,
	type KVStoreProvider,
} from '../src/index.js';

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

describe('StoreTable UNIQUE constraints', () => {
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

	describe('single-column UNIQUE', () => {
		beforeEach(async () => {
			await db.exec(`
				CREATE TABLE t_uc (id INTEGER PRIMARY KEY, email TEXT UNIQUE, name TEXT) USING store
			`);
			await db.exec(`INSERT INTO t_uc VALUES (1, 'alice@test.com', 'Alice')`);
			await db.exec(`INSERT INTO t_uc VALUES (2, 'bob@test.com', 'Bob')`);
		});

		it('rejects duplicate value on INSERT', async () => {
			let err: Error | null = null;
			try {
				await db.exec(`INSERT INTO t_uc VALUES (3, 'alice@test.com', 'Eve')`);
			} catch (e) {
				err = e as Error;
			}
			expect(err).to.not.be.null;
			expect(err!.message).to.match(/UNIQUE constraint failed/i);

			const row = await db.get(`SELECT count(*) as cnt FROM t_uc`);
			expect(row?.cnt).to.equal(2);
		});

		it('INSERT OR IGNORE silently skips duplicates', async () => {
			await db.exec(`INSERT OR IGNORE INTO t_uc VALUES (4, 'alice@test.com', 'Ignored')`);
			const row = await db.get(`SELECT count(*) as cnt FROM t_uc`);
			expect(row?.cnt).to.equal(2);
		});

		it('INSERT OR REPLACE evicts conflicting row', async () => {
			await db.exec(`INSERT OR REPLACE INTO t_uc VALUES (5, 'alice@test.com', 'Replaced')`);
			const rows = await collect(db, `SELECT * FROM t_uc ORDER BY id`);
			expect(rows).to.deep.equal([
				{ id: 2, email: 'bob@test.com', name: 'Bob' },
				{ id: 5, email: 'alice@test.com', name: 'Replaced' },
			]);
		});
	});

	describe('NULL semantics', () => {
		it('allows multiple NULLs but rejects duplicate non-NULL', async () => {
			await db.exec(`CREATE TABLE t_null (id INTEGER PRIMARY KEY, code TEXT NULL UNIQUE) USING store`);
			await db.exec(`INSERT INTO t_null VALUES (1, null)`);
			await db.exec(`INSERT INTO t_null VALUES (2, null)`);
			await db.exec(`INSERT INTO t_null VALUES (3, 'abc')`);

			const row = await db.get(`SELECT count(*) as cnt FROM t_null`);
			expect(row?.cnt).to.equal(3);

			let err: Error | null = null;
			try {
				await db.exec(`INSERT INTO t_null VALUES (4, 'abc')`);
			} catch (e) { err = e as Error; }
			expect(err).to.not.be.null;
			expect(err!.message).to.match(/UNIQUE constraint failed/i);
		});
	});

	describe('UPDATE same-PK', () => {
		beforeEach(async () => {
			await db.exec(`CREATE TABLE t_upd (id INTEGER PRIMARY KEY, tag TEXT UNIQUE, val INTEGER) USING store`);
			await db.exec(`INSERT INTO t_upd VALUES (1, 'alpha', 10)`);
			await db.exec(`INSERT INTO t_upd VALUES (2, 'beta', 20)`);
		});

		it('rejects update to a conflicting UNIQUE value', async () => {
			let err: Error | null = null;
			try {
				await db.exec(`UPDATE t_upd SET tag = 'alpha' WHERE id = 2`);
			} catch (e) { err = e as Error; }
			expect(err).to.not.be.null;
			expect(err!.message).to.match(/UNIQUE constraint failed/i);

			const rows = await collect(db, `SELECT * FROM t_upd ORDER BY id`);
			expect(rows).to.deep.equal([
				{ id: 1, tag: 'alpha', val: 10 },
				{ id: 2, tag: 'beta', val: 20 },
			]);
		});

		it('allows update of UNIQUE column to its own value (no self-conflict)', async () => {
			await db.exec(`UPDATE t_upd SET tag = 'beta' WHERE id = 2`);
			const row = await db.get(`SELECT tag FROM t_upd WHERE id = 2`);
			expect(row?.tag).to.equal('beta');
		});

		it('allows update to a fresh UNIQUE value', async () => {
			await db.exec(`UPDATE t_upd SET tag = 'gamma' WHERE id = 2`);
			const row = await db.get(`SELECT tag FROM t_upd WHERE id = 2`);
			expect(row?.tag).to.equal('gamma');
		});

		it('allows update of non-UNIQUE column without UNIQUE check', async () => {
			await db.exec(`UPDATE t_upd SET val = 99 WHERE id = 2`);
			const row = await db.get(`SELECT val FROM t_upd WHERE id = 2`);
			expect(row?.val).to.equal(99);
		});
	});

	describe('composite UNIQUE', () => {
		it('rejects duplicate combination, allows partial overlap', async () => {
			await db.exec(`
				CREATE TABLE t_comp (
					id INTEGER PRIMARY KEY, a TEXT, b INTEGER, UNIQUE (a, b)
				) USING store
			`);
			await db.exec(`INSERT INTO t_comp VALUES (1, 'x', 1)`);
			await db.exec(`INSERT INTO t_comp VALUES (2, 'x', 2)`);
			await db.exec(`INSERT INTO t_comp VALUES (3, 'y', 1)`);

			let err: Error | null = null;
			try {
				await db.exec(`INSERT INTO t_comp VALUES (4, 'x', 1)`);
			} catch (e) { err = e as Error; }
			expect(err).to.not.be.null;
			expect(err!.message).to.match(/UNIQUE constraint failed/i);

			const row = await db.get(`SELECT count(*) as cnt FROM t_comp`);
			expect(row?.cnt).to.equal(3);
		});
	});

	describe('PK-change UPDATE', () => {
		beforeEach(async () => {
			await db.exec(`CREATE TABLE t_pk (id INTEGER PRIMARY KEY, code TEXT UNIQUE) USING store`);
			await db.exec(`INSERT INTO t_pk VALUES (1, 'aaa')`);
			await db.exec(`INSERT INTO t_pk VALUES (2, 'bbb')`);
		});

		it('rejects PK-change UPDATE that triggers a UNIQUE conflict', async () => {
			let err: Error | null = null;
			try {
				await db.exec(`UPDATE t_pk SET id = 3, code = 'aaa' WHERE id = 2`);
			} catch (e) { err = e as Error; }
			expect(err).to.not.be.null;
			expect(err!.message).to.match(/UNIQUE constraint failed/i);

			const rows = await collect(db, `SELECT * FROM t_pk ORDER BY id`);
			expect(rows).to.deep.equal([
				{ id: 1, code: 'aaa' },
				{ id: 2, code: 'bbb' },
			]);
		});

		it('allows PK-change UPDATE with no UNIQUE conflict', async () => {
			await db.exec(`UPDATE t_pk SET id = 3, code = 'ccc' WHERE id = 2`);
			const rows = await collect(db, `SELECT * FROM t_pk ORDER BY id`);
			expect(rows).to.deep.equal([
				{ id: 1, code: 'aaa' },
				{ id: 3, code: 'ccc' },
			]);
		});
	});

	// StoreTable routes UNIQUE conflict resolution through a linked row-time
	// covering materialized view's backing table when one is present (the store
	// analogue of the memory enforcement path; see
	// covering-structure-mv-rowtime-enforcement). Every MV is row-time maintained.
	// The backing table is the memory module, queried through the db with
	// reads-own-writes. Exercised directly here (no isolation overlay), since the
	// isolation-wrapped logic sweep enforces UNIQUE via its own merged-view
	// detection rather than the covering MV.
	describe('covering materialized-view enforcement', () => {
		beforeEach(async () => {
			await db.exec(`CREATE TABLE cm (id INTEGER PRIMARY KEY, x INTEGER NOT NULL, y INTEGER NOT NULL, UNIQUE (x, y)) USING store`);
			await db.exec(`CREATE MATERIALIZED VIEW cm_ix AS SELECT x, y, id FROM cm ORDER BY x, y`);
			await db.exec(`INSERT INTO cm VALUES (1, 5, 5)`);
		});

		it('routes ABORT through the covering MV', async () => {
			let err: Error | null = null;
			try {
				await db.exec(`INSERT INTO cm VALUES (2, 5, 5)`);
			} catch (e) { err = e as Error; }
			expect(err).to.not.be.null;
			expect(err!.message).to.match(/UNIQUE constraint failed/i);
			expect(await collect(db, `SELECT * FROM cm ORDER BY id`)).to.deep.equal([{ id: 1, x: 5, y: 5 }]);
		});

		it('routes OR IGNORE through the covering MV', async () => {
			await db.exec(`INSERT OR IGNORE INTO cm VALUES (2, 5, 5)`);
			expect(await collect(db, `SELECT * FROM cm ORDER BY id`)).to.deep.equal([{ id: 1, x: 5, y: 5 }]);
		});

		it('routes OR REPLACE through the covering MV — evicts the recovered source row and maintains the backing', async () => {
			await db.exec(`INSERT OR REPLACE INTO cm VALUES (10, 5, 5)`);
			// Correct source PK (id=1) recovered + evicted; new row present.
			expect(await collect(db, `SELECT * FROM cm ORDER BY id`)).to.deep.equal([{ id: 10, x: 5, y: 5 }]);
			// The evicted row's backing entry is gone (MV resolves to the backing table).
			expect(await collect(db, `SELECT x, y, id FROM cm_ix ORDER BY x, y`)).to.deep.equal([{ x: 5, y: 5, id: 10 }]);
		});

		it('detects an intra-statement duplicate via reads-own-writes', async () => {
			await db.exec(`DELETE FROM cm`);
			let err: Error | null = null;
			try {
				await db.exec(`INSERT INTO cm VALUES (1, 7, 7), (2, 7, 7)`);
			} catch (e) { err = e as Error; }
			expect(err).to.not.be.null;
			expect(err!.message).to.match(/UNIQUE constraint failed/i);
			expect(await collect(db, `SELECT count(*) AS n FROM cm`)).to.deep.equal([{ n: 0 }]);
		});

		it('a PK-only UPDATE (UC unchanged) is not a self-conflict', async () => {
			await db.exec(`UPDATE cm SET id = 99 WHERE id = 1`);
			expect(await collect(db, `SELECT * FROM cm ORDER BY id`)).to.deep.equal([{ id: 99, x: 5, y: 5 }]);
		});
	});

	// A secondary-UNIQUE REPLACE eviction (a new row collides on a NON-PK UNIQUE with an
	// existing row at a DIFFERENT primary key) is now surfaced via UpdateResult.evictedRows,
	// so the DML executor runs the full delete pipeline for the evicted row — FK ON DELETE
	// actions, change-scope deltas, and delete events. Exercised on the direct store module
	// (no isolation overlay); see internal-eviction-reporting.
	describe('internal-eviction reporting (secondary-UNIQUE REPLACE)', () => {
		it('cascades FK ON DELETE CASCADE to the evicted row\'s children', async () => {
			await db.exec(`CREATE TABLE p (id INTEGER PRIMARY KEY, email TEXT NOT NULL, UNIQUE (email)) USING store`);
			await db.exec(`CREATE TABLE c (cid INTEGER PRIMARY KEY, pid INTEGER NOT NULL, FOREIGN KEY (pid) REFERENCES p(id) ON DELETE CASCADE) USING store`);
			await db.exec(`INSERT INTO p VALUES (1, 'a@x')`);
			await db.exec(`INSERT INTO c VALUES (10, 1), (11, 1)`);
			// new row (id=2, email='a@x') evicts id=1 at a different PK; children cascade.
			await db.exec(`INSERT OR REPLACE INTO p VALUES (2, 'a@x')`);
			expect(await collect(db, `SELECT id, email FROM p ORDER BY id`)).to.deep.equal([{ id: 2, email: 'a@x' }]);
			expect(await collect(db, `SELECT cid FROM c ORDER BY cid`)).to.deep.equal([]);
		});

		it('records a change-scope watch delta and a delete event for the evicted PK', async () => {
			await db.exec(`CREATE TABLE pe (id INTEGER PRIMARY KEY, email TEXT NOT NULL, UNIQUE (email)) USING store`);
			await db.exec(`INSERT INTO pe VALUES (1, 'a@x')`);

			const dataEvents: DatabaseDataChangeEvent[] = [];
			const unsub = db.onDataChange(e => dataEvents.push(e));
			const watchEvents: WatchEvent[] = [];
			const scope: ChangeScope = {
				watches: [{ table: { schema: 'main', table: 'pe' }, columns: new Set(['id']), scope: { kind: 'rows', key: ['id'], values: [[1]] } }],
				nonDeterministicSources: [],
				unboundParameters: [],
			};
			const sub = db.watch(scope, e => watchEvents.push(e));

			await db.exec(`INSERT OR REPLACE INTO pe VALUES (2, 'a@x')`);
			sub.unsubscribe();
			unsub();

			// (b) Database.watch / change-scope delta for the evicted PK (id=1).
			expect(watchEvents).to.have.length(1);
			expect(watchEvents[0].matched[0].hits).to.deep.equal([[1]]);
			// (c) a delete event for the evicted row.
			const deletes = dataEvents.filter(e => e.type === 'delete' && e.tableName === 'pe');
			expect(deletes.map(d => d.key)).to.deep.equal([[1]]);
		});
	});
});
