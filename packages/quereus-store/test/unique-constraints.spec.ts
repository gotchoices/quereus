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
	type IterateOptions,
	type KVEntry,
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

/**
 * Data store that tallies how many entries its `iterate` actually YIELDS.
 * Counting yielded entries (not `iterate` calls) is what separates an O(rows)
 * full scan from a bounded index seek: the full-scan UNIQUE check bails out
 * early on a conflict, so call-counting would under-report it. Mirrors
 * `pushdown.spec.ts`' CountingKVStore.
 */
class CountingKVStore extends InMemoryKVStore {
	public iterateEntryCount = 0;
	override async *iterate(options?: IterateOptions): AsyncIterable<KVEntry> {
		for await (const entry of super.iterate(options)) {
			this.iterateEntryCount++;
			yield entry;
		}
	}
}

/**
 * An in-memory provider whose DATA stores count iterated entries; index / stats
 * / catalog stores stay plain, so only data-row iteration is tallied.
 */
function createCountingProvider(): KVStoreProvider & { dataEntriesScanned(table: string): number } {
	const dataStores = new Map<string, CountingKVStore>();
	const auxStores = new Map<string, InMemoryKVStore>();
	const aux = (key: string) => {
		if (!auxStores.has(key)) auxStores.set(key, new InMemoryKVStore());
		return auxStores.get(key)!;
	};
	return {
		dataEntriesScanned(table: string) { return dataStores.get(`main.${table}`)?.iterateEntryCount ?? 0; },
		async getStore(s, t) {
			const key = `${s}.${t}`;
			if (!dataStores.has(key)) dataStores.set(key, new CountingKVStore());
			return dataStores.get(key)!;
		},
		async getIndexStore(s, t, i) { return aux(`${s}.${t}_idx_${i}`); },
		async getStatsStore(s, t) { return aux(`${s}.${t}.__stats__`); },
		async getCatalogStore() { return aux('__catalog__'); },
		async closeStore() {},
		async closeIndexStore() {},
		async closeAll() {
			for (const store of dataStores.values()) await store.close();
			for (const store of auxStores.values()) await store.close();
			dataStores.clear();
			auxStores.clear();
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

	// A UNIQUE over a column declared with a non-binary collation must be enforced under
	// that collation, not BINARY (unique-constraint-honors-column-collation). Exercised on
	// the direct store module (no isolation overlay) so both StoreTable conflict scanners
	// are covered: findUniqueConflict (no covering MV) and findUniqueConflictViaCoveringMv
	// (covering MV present). The isolation-wrapped logic sweep covers the merge path
	// (isolated-table.findMergedUniqueConflict) separately.
	describe('collation-aware UNIQUE (honors column collation)', () => {
		it('NOCASE UNIQUE rejects a case-insensitive duplicate (plain scan path)', async () => {
			await db.exec(`CREATE TABLE nc (id INTEGER PRIMARY KEY, x TEXT COLLATE NOCASE, UNIQUE (x)) USING store`);
			await db.exec(`INSERT INTO nc VALUES (1, 'abc')`);

			let err: Error | null = null;
			try {
				await db.exec(`INSERT INTO nc VALUES (2, 'ABC')`);
			} catch (e) { err = e as Error; }
			expect(err, 'a NOCASE-equal duplicate must be rejected, not stored as BINARY-distinct').to.not.be.null;
			expect(err!.message).to.match(/UNIQUE constraint failed/i);
			expect(await collect(db, `SELECT count(*) AS n FROM nc`)).to.deep.equal([{ n: 1 }]);

			// A value that is NOT NOCASE-equal still inserts (guard against over-matching).
			await db.exec(`INSERT INTO nc VALUES (3, 'abd')`);
			expect(await collect(db, `SELECT id, x FROM nc ORDER BY id`)).to.deep.equal([
				{ id: 1, x: 'abc' }, { id: 3, x: 'abd' },
			]);
		});

		it('NOCASE UNIQUE rejects a case-insensitive duplicate through the covering MV path', async () => {
			await db.exec(`CREATE TABLE ncm (id INTEGER PRIMARY KEY, x TEXT COLLATE NOCASE, UNIQUE (x)) USING store`);
			await db.exec(`CREATE MATERIALIZED VIEW ncm_ix AS SELECT x, id FROM ncm ORDER BY x`);
			await db.exec(`INSERT INTO ncm VALUES (1, 'abc')`);

			let err: Error | null = null;
			try {
				await db.exec(`INSERT INTO ncm VALUES (2, 'ABC')`);
			} catch (e) { err = e as Error; }
			expect(err).to.not.be.null;
			expect(err!.message).to.match(/UNIQUE constraint failed/i);
			expect(await collect(db, `SELECT count(*) AS n FROM ncm`)).to.deep.equal([{ n: 1 }]);

			// OR REPLACE through the covering MV evicts the recovered (id=1) source row.
			await db.exec(`INSERT OR REPLACE INTO ncm VALUES (10, 'ABC')`);
			expect(await collect(db, `SELECT id, x FROM ncm ORDER BY id`)).to.deep.equal([{ id: 10, x: 'ABC' }]);
		});

		it('RTRIM UNIQUE rejects a trailing-space duplicate (generality)', async () => {
			await db.exec(`CREATE TABLE rt (id INTEGER PRIMARY KEY, x TEXT COLLATE RTRIM, UNIQUE (x)) USING store`);
			await db.exec(`INSERT INTO rt VALUES (1, 'abc')`);

			let err: Error | null = null;
			try {
				await db.exec(`INSERT INTO rt VALUES (2, 'abc   ')`);
			} catch (e) { err = e as Error; }
			expect(err).to.not.be.null;
			expect(err!.message).to.match(/UNIQUE constraint failed/i);
			expect(await collect(db, `SELECT count(*) AS n FROM rt`)).to.deep.equal([{ n: 1 }]);
		});
	});

	// A UNIQUE *index* carrying an explicit per-column COLLATE clause must be enforced
	// under the INDEX's collation, not the column's declared collation — matching the
	// memory module (checkUniqueViaIndex), the store's own buildIndexEntries dedup, and
	// SQLite (store-index-derived-unique-honors-index-collation). The DML write path now
	// resolves each constrained column's collation via StoreTable.uniqueEnforcementCollations
	// (index per-column COLLATE → declared fallback).
	describe('index-derived UNIQUE honors the index per-column collation', () => {
		async function rejects(sql: string): Promise<Error> {
			let err: Error | null = null;
			try { await db.exec(sql); } catch (e) { err = e as Error; }
			expect(err, `expected "${sql}" to be rejected`).to.not.be.null;
			expect(err!.message).to.match(/UNIQUE constraint failed/i);
			return err!;
		}

		it('FINER index (BINARY) over a NOCASE column admits both case-variants (plain scan path)', async () => {
			// Case A: the NOCASE column would unify 'Bob'/'bob', but the BINARY index
			// keeps them distinct — both must insert (was rejected under declared NOCASE).
			await db.exec(`CREATE TABLE fa (id INTEGER PRIMARY KEY, b TEXT COLLATE NOCASE) USING store`);
			await db.exec(`CREATE UNIQUE INDEX fa_b ON fa (b COLLATE BINARY)`);
			await db.exec(`INSERT INTO fa VALUES (1, 'Bob')`);
			await db.exec(`INSERT INTO fa VALUES (2, 'bob')`); // BINARY-distinct ⇒ admitted
			expect(await collect(db, `SELECT id, b FROM fa ORDER BY id`)).to.deep.equal([
				{ id: 1, b: 'Bob' }, { id: 2, b: 'bob' },
			]);
			// A genuine BINARY duplicate is still rejected (guard against under-matching).
			await rejects(`INSERT INTO fa VALUES (3, 'bob')`);
		});

		it('FINER index (BINARY) over a NOCASE column admits both case-variants through the covering MV path', async () => {
			// Same as above but with a row-time covering MV linked to the derived UNIQUE,
			// so enforcement routes through findUniqueConflictViaCoveringMv: the candidate
			// generation narrows under the declared NOCASE (a SUPERSET of the BINARY
			// matches) and the re-validation filters under the index BINARY. Store and
			// memory now AGREE here: the finer index is BINARY-floor eligible so the
			// covering MV is kept, and memory's checkUniqueViaMaterializedView re-validates
			// under the index BINARY too (covering-mv-index-derived-unique-collation).
			await db.exec(`CREATE TABLE fam (id INTEGER PRIMARY KEY, b TEXT COLLATE NOCASE) USING store`);
			await db.exec(`CREATE UNIQUE INDEX fam_b ON fam (b COLLATE BINARY)`);
			await db.exec(`CREATE MATERIALIZED VIEW fam_mv AS SELECT b, id FROM fam ORDER BY b`);
			await db.exec(`INSERT INTO fam VALUES (1, 'Bob')`);
			await db.exec(`INSERT INTO fam VALUES (2, 'bob')`); // BINARY-distinct ⇒ admitted via MV path
			expect(await collect(db, `SELECT id, b FROM fam ORDER BY id`)).to.deep.equal([
				{ id: 1, b: 'Bob' }, { id: 2, b: 'bob' },
			]);
		});

		it('COARSER index (NOCASE) over a BINARY column rejects the NOCASE-equal dup through the covering MV path', async () => {
			// A coarser index over a covering MV: the MV's candidate generation narrows
			// under the declared BINARY, so 'BOB' (NOCASE-equal but BINARY-different to
			// 'Bob') would be a SUBSET miss. The collation eligibility gate
			// (findRowTimeCoveringStructure) DECLINES the MV, so enforcement falls back to
			// the per-scan findUniqueConflict under the index NOCASE — closing the silent
			// miss on the store too (covering-mv-index-derived-unique-collation).
			await db.exec(`CREATE TABLE cbm (id INTEGER PRIMARY KEY, b TEXT) USING store`); // b is BINARY
			await db.exec(`CREATE UNIQUE INDEX cbm_b ON cbm (b COLLATE NOCASE)`);
			await db.exec(`CREATE MATERIALIZED VIEW cbm_mv AS SELECT b, id FROM cbm ORDER BY b`);
			await db.exec(`INSERT INTO cbm VALUES (1, 'Bob')`);
			await rejects(`INSERT INTO cbm VALUES (2, 'BOB')`); // NOCASE-equal ⇒ rejected via declined-MV per-scan
			expect(await collect(db, `SELECT count(*) AS n FROM cbm`)).to.deep.equal([{ n: 1 }]);
			// A genuinely different value still inserts.
			await db.exec(`INSERT INTO cbm VALUES (3, 'Carol')`);
			expect(await collect(db, `SELECT id, b FROM cbm ORDER BY id`)).to.deep.equal([
				{ id: 1, b: 'Bob' }, { id: 3, b: 'Carol' },
			]);
		});

		it('COARSER index (NOCASE) over a BINARY column unifies case-variants (plain scan path)', async () => {
			// Case B: the BINARY column would keep 'Bob'/'BOB' distinct, but the NOCASE
			// index unifies them — the second must be rejected (was admitted under declared
			// BINARY).
			await db.exec(`CREATE TABLE cb (id INTEGER PRIMARY KEY, b TEXT) USING store`); // b is BINARY
			await db.exec(`CREATE UNIQUE INDEX cb_b ON cb (b COLLATE NOCASE)`);
			await db.exec(`INSERT INTO cb VALUES (1, 'Bob')`);
			await rejects(`INSERT INTO cb VALUES (2, 'BOB')`); // NOCASE-equal ⇒ rejected
			expect(await collect(db, `SELECT count(*) AS n FROM cb`)).to.deep.equal([{ n: 1 }]);
			// A genuinely different value still inserts.
			await db.exec(`INSERT INTO cb VALUES (3, 'Carol')`);
			expect(await collect(db, `SELECT id, b FROM cb ORDER BY id`)).to.deep.equal([
				{ id: 1, b: 'Bob' }, { id: 3, b: 'Carol' },
			]);
		});

		it('build-time dedup and DML enforcement agree on the index collation (internal consistency)', async () => {
			// The headline internal inconsistency: buildIndexEntries (CREATE UNIQUE INDEX
			// over existing rows) already dedups under the index collation, but DML used to
			// compare under the declared collation. Pre-load BINARY-distinct case-variants
			// into a NOCASE column, then build a BINARY index over them — the build must
			// admit both — and a later DML insert of a third BINARY-distinct variant must
			// also be admitted, proving build and DML now agree.
			await db.exec(`CREATE TABLE ic (id INTEGER PRIMARY KEY, b TEXT COLLATE NOCASE) USING store`);
			await db.exec(`INSERT INTO ic VALUES (1, 'Bob'), (2, 'bob')`); // no constraint yet
			await db.exec(`CREATE UNIQUE INDEX ic_b ON ic (b COLLATE BINARY)`); // build dedup under BINARY ⇒ ok
			await db.exec(`INSERT INTO ic VALUES (3, 'BOB')`); // DML under BINARY ⇒ admitted
			expect(await collect(db, `SELECT id, b FROM ic ORDER BY id`)).to.deep.equal([
				{ id: 1, b: 'Bob' }, { id: 2, b: 'bob' }, { id: 3, b: 'BOB' },
			]);
		});

		it('a plain CREATE UNIQUE INDEX (no explicit COLLATE) still enforces the column collation', async () => {
			// Regression guard for the common path: with no per-column COLLATE on the index,
			// the helper falls back to the declared column collation, so a NOCASE column's
			// index still folds case (byte-for-byte unchanged behaviour).
			await db.exec(`CREATE TABLE pg (id INTEGER PRIMARY KEY, b TEXT COLLATE NOCASE) USING store`);
			await db.exec(`CREATE UNIQUE INDEX pg_b ON pg (b)`);
			await db.exec(`INSERT INTO pg VALUES (1, 'Bob')`);
			await rejects(`INSERT INTO pg VALUES (2, 'bob')`); // still NOCASE ⇒ rejected
			expect(await collect(db, `SELECT count(*) AS n FROM pg`)).to.deep.equal([{ n: 1 }]);
		});

		it('composite index resolves each column position independently (mixed collations)', async () => {
			// (a COLLATE BINARY, b COLLATE NOCASE): each position uses its own index
			// collation — the helper returns per-column collations, not one table-wide one.
			await db.exec(`CREATE TABLE comp (id INTEGER PRIMARY KEY, a TEXT, b TEXT) USING store`);
			await db.exec(`CREATE UNIQUE INDEX comp_ab ON comp (a COLLATE BINARY, b COLLATE NOCASE)`);
			await db.exec(`INSERT INTO comp VALUES (1, 'x', 'Y')`);
			// a matches under BINARY ('x'='x'), b matches under NOCASE ('Y'≈'y') ⇒ conflict.
			await rejects(`INSERT INTO comp VALUES (2, 'x', 'y')`);
			// a differs under BINARY ('X'≠'x') ⇒ distinct composite key ⇒ admitted.
			await db.exec(`INSERT INTO comp VALUES (3, 'X', 'y')`);
			expect(await collect(db, `SELECT count(*) AS n FROM comp`)).to.deep.equal([{ n: 2 }]);
		});

		it('UPDATE into a collision is enforced under the index collation (shares findUniqueConflict)', async () => {
			// UPDATE routes through the same checkUniqueConstraints → findUniqueConflict
			// path as INSERT (selfPks excludes the row being updated), so the index
			// collation governs equally. Two cases pinned in one table:
			//   - COARSER index (NOCASE over BINARY): two BINARY-distinct rows coexist,
			//     then UPDATE one to a NOCASE-equal value collides → rejected.
			//   - the same UPDATE that moves to a genuinely distinct value succeeds.
			await db.exec(`CREATE TABLE up (id INTEGER PRIMARY KEY, b TEXT) USING store`); // b is BINARY
			await db.exec(`CREATE UNIQUE INDEX up_b ON up (b COLLATE NOCASE)`);
			await db.exec(`INSERT INTO up VALUES (1, 'alpha'), (2, 'beta')`);
			// UPDATE id=2 to a NOCASE-equal of id=1's value → conflict under the index.
			await rejects(`UPDATE up SET b = 'ALPHA' WHERE id = 2`);
			// The self-row may always be "updated" to its own NOCASE-equal value (selfPks
			// excludes it) — no false conflict.
			await db.exec(`UPDATE up SET b = 'ALPHA' WHERE id = 1`);
			// And a move to a genuinely distinct value succeeds.
			await db.exec(`UPDATE up SET b = 'gamma' WHERE id = 2`);
			expect(await collect(db, `SELECT id, b FROM up ORDER BY id`)).to.deep.equal([
				{ id: 1, b: 'ALPHA' }, { id: 2, b: 'gamma' },
			]);
		});

		it('UPDATE under a FINER index keeps BINARY-distinct case-variants updatable', async () => {
			// FINER index (BINARY over NOCASE column): 'Bob'/'bob' coexist; UPDATE one to
			// another BINARY-distinct case-variant stays admitted, but UPDATE onto the
			// other's exact bytes collides under BINARY.
			await db.exec(`CREATE TABLE uf (id INTEGER PRIMARY KEY, b TEXT COLLATE NOCASE) USING store`);
			await db.exec(`CREATE UNIQUE INDEX uf_b ON uf (b COLLATE BINARY)`);
			await db.exec(`INSERT INTO uf VALUES (1, 'Bob'), (2, 'bob')`); // BINARY-distinct ⇒ both admitted
			await db.exec(`UPDATE uf SET b = 'BOB' WHERE id = 2`); // still BINARY-distinct from 'Bob'
			expect(await collect(db, `SELECT id, b FROM uf ORDER BY id`)).to.deep.equal([
				{ id: 1, b: 'Bob' }, { id: 2, b: 'BOB' },
			]);
			await rejects(`UPDATE uf SET b = 'Bob' WHERE id = 2`); // exact BINARY dup of id=1 ⇒ rejected
		});

		it('conflict resolution (OR IGNORE / OR REPLACE) acts on the index-collation conflict', async () => {
			// A NOCASE index over a BINARY column: a case-variant collides, and the OR arms
			// must resolve that index-collation conflict (REPLACE evicts the prior row).
			await db.exec(`CREATE TABLE cr (id INTEGER PRIMARY KEY, b TEXT) USING store`);
			await db.exec(`CREATE UNIQUE INDEX cr_b ON cr (b COLLATE NOCASE)`);
			await db.exec(`INSERT INTO cr VALUES (1, 'Bob')`);

			// OR IGNORE: the NOCASE-equal duplicate is silently dropped.
			await db.exec(`INSERT OR IGNORE INTO cr VALUES (2, 'BOB')`);
			expect(await collect(db, `SELECT id, b FROM cr ORDER BY id`)).to.deep.equal([{ id: 1, b: 'Bob' }]);

			// OR REPLACE: the NOCASE-equal duplicate (id=1) is evicted, the new row lands.
			await db.exec(`INSERT OR REPLACE INTO cr VALUES (3, 'BOB')`);
			expect(await collect(db, `SELECT id, b FROM cr ORDER BY id`)).to.deep.equal([{ id: 3, b: 'BOB' }]);
		});
	});

	// When a UNIQUE constraint is realized by a physical secondary index, the conflict
	// search is a bounded seek into that index rather than a full table scan
	// (store-unique-check-via-index). The index seek only narrows the CANDIDATE set —
	// the self-PK exclusion, per-column enforcement-collation compare and partial
	// predicate re-check are identical to the full-scan finder, so every behaviour
	// pinned above must survive the reroute. These tests pin the reroute's own edges.
	describe('index-backed UNIQUE point lookup', () => {
		async function rejects(sql: string): Promise<void> {
			let err: Error | null = null;
			try { await db.exec(sql); } catch (e) { err = e as Error; }
			expect(err, `expected "${sql}" to be rejected`).to.not.be.null;
			expect(err!.message).to.match(/UNIQUE constraint failed/i);
		}

		it('an index-derived UNIQUE rejects a duplicate and admits a distinct value', async () => {
			await db.exec(`CREATE TABLE ix1 (id INTEGER PRIMARY KEY, v TEXT) USING store`);
			await db.exec(`CREATE UNIQUE INDEX ix1_v ON ix1 (v)`);
			await db.exec(`INSERT INTO ix1 VALUES (1, 'aaa'), (2, 'bbb')`);
			await rejects(`INSERT INTO ix1 VALUES (3, 'aaa')`);
			await db.exec(`INSERT INTO ix1 VALUES (3, 'ccc')`);
			expect(await collect(db, `SELECT id, v FROM ix1 ORDER BY id`)).to.deep.equal([
				{ id: 1, v: 'aaa' }, { id: 2, v: 'bbb' }, { id: 3, v: 'ccc' },
			]);
		});

		it('a NON-unique index over a table-level UNIQUE still serves the check', async () => {
			// The index need not be UNIQUE — a plain index over the constrained columns
			// holds every row, so a seek narrows the candidate set soundly.
			await db.exec(`CREATE TABLE nu (id INTEGER PRIMARY KEY, v TEXT, UNIQUE (v)) USING store`);
			await db.exec(`CREATE INDEX nu_v ON nu (v)`);
			await db.exec(`INSERT INTO nu VALUES (1, 'aaa')`);
			await rejects(`INSERT INTO nu VALUES (2, 'aaa')`);
			await db.exec(`INSERT INTO nu VALUES (2, 'bbb')`);
			expect(await collect(db, `SELECT count(*) AS n FROM nu`)).to.deep.equal([{ n: 2 }]);
		});

		it('multiple NULLs insert — the seek is never reached for a NULL key', async () => {
			await db.exec(`CREATE TABLE ixn (id INTEGER PRIMARY KEY, v TEXT NULL) USING store`);
			await db.exec(`CREATE UNIQUE INDEX ixn_v ON ixn (v)`);
			await db.exec(`INSERT INTO ixn VALUES (1, null), (2, null), (3, null)`);
			await db.exec(`INSERT INTO ixn VALUES (4, 'x')`);
			await rejects(`INSERT INTO ixn VALUES (5, 'x')`);
			expect(await collect(db, `SELECT count(*) AS n FROM ixn`)).to.deep.equal([{ n: 4 }]);
		});

		it('detects an intra-transaction duplicate through the pending index merge', async () => {
			await db.exec(`CREATE TABLE ryw (id INTEGER PRIMARY KEY, v TEXT) USING store`);
			await db.exec(`CREATE UNIQUE INDEX ryw_v ON ryw (v)`);

			await db.exec(`begin`);
			await db.exec(`INSERT INTO ryw VALUES (1, 'dup')`);
			// The pending index put for row 1 must be visible to row 2's seek.
			await rejects(`INSERT INTO ryw VALUES (2, 'dup')`);
			await db.exec(`rollback`);
			expect(await collect(db, `SELECT count(*) AS n FROM ryw`)).to.deep.equal([{ n: 0 }]);
		});

		it('a delete within the transaction frees the value for re-insert', async () => {
			await db.exec(`CREATE TABLE rywd (id INTEGER PRIMARY KEY, v TEXT) USING store`);
			await db.exec(`CREATE UNIQUE INDEX rywd_v ON rywd (v)`);
			await db.exec(`INSERT INTO rywd VALUES (1, 'v')`); // committed

			await db.exec(`begin`);
			await db.exec(`DELETE FROM rywd WHERE id = 1`);
			// The pending index delete must suppress the committed entry for row 1.
			await db.exec(`INSERT INTO rywd VALUES (2, 'v')`);
			await db.exec(`commit`);
			expect(await collect(db, `SELECT id, v FROM rywd ORDER BY id`)).to.deep.equal([{ id: 2, v: 'v' }]);
		});

		it('an UPDATE that keeps the unique value is not a self-conflict', async () => {
			await db.exec(`CREATE TABLE ixu (id INTEGER PRIMARY KEY, v TEXT, w INTEGER) USING store`);
			await db.exec(`CREATE UNIQUE INDEX ixu_v ON ixu (v)`);
			await db.exec(`INSERT INTO ixu VALUES (1, 'a', 10), (2, 'b', 20)`);

			// Re-writing the row's own unique value: selfPks excludes it.
			await db.exec(`UPDATE ixu SET v = 'a', w = 11 WHERE id = 1`);
			// Moving onto another row's value conflicts.
			await rejects(`UPDATE ixu SET v = 'a' WHERE id = 2`);
			// A PK-change UPDATE passes [oldPk, newPk]; neither may self-match.
			await db.exec(`UPDATE ixu SET id = 3 WHERE id = 2`);
			expect(await collect(db, `SELECT id, v, w FROM ixu ORDER BY id`)).to.deep.equal([
				{ id: 1, v: 'a', w: 11 }, { id: 3, v: 'b', w: 20 },
			]);
		});

		it('OR REPLACE evicts the row the index seek found', async () => {
			await db.exec(`CREATE TABLE ixr (id INTEGER PRIMARY KEY, v TEXT, tag TEXT) USING store`);
			await db.exec(`CREATE UNIQUE INDEX ixr_v ON ixr (v)`);
			await db.exec(`INSERT INTO ixr VALUES (1, 'a', 'old'), (2, 'b', 'keep')`);

			await db.exec(`INSERT OR REPLACE INTO ixr VALUES (9, 'a', 'new')`);
			expect(await collect(db, `SELECT id, v, tag FROM ixr ORDER BY id`)).to.deep.equal([
				{ id: 2, v: 'b', tag: 'keep' }, { id: 9, v: 'a', tag: 'new' },
			]);
			// The evicted row's index entry is gone too: 'a' is free again.
			await db.exec(`INSERT OR REPLACE INTO ixr VALUES (10, 'a', 'newer')`);
			expect(await collect(db, `SELECT id, v FROM ixr ORDER BY id`)).to.deep.equal([
				{ id: 2, v: 'b' }, { id: 10, v: 'a' },
			]);
		});

		it('a REPLACE eviction and a re-insert of the same value in ONE statement agree', async () => {
			// Row 1 is evicted by row 9 (queueing an index delete), then row 10 collides
			// with row 9 and evicts it. Every step reads the pending index merge.
			await db.exec(`CREATE TABLE ixm (id INTEGER PRIMARY KEY, v TEXT) USING store`);
			await db.exec(`CREATE UNIQUE INDEX ixm_v ON ixm (v)`);
			await db.exec(`INSERT INTO ixm VALUES (1, 'a')`);
			await db.exec(`INSERT OR REPLACE INTO ixm VALUES (9, 'a'), (10, 'a')`);
			expect(await collect(db, `SELECT id, v FROM ixm ORDER BY id`)).to.deep.equal([{ id: 10, v: 'a' }]);
		});

		it('a composite unique index seeks on ALL its columns', async () => {
			await db.exec(`CREATE TABLE ixc (id INTEGER PRIMARY KEY, a TEXT, b INTEGER) USING store`);
			await db.exec(`CREATE UNIQUE INDEX ixc_ab ON ixc (a, b)`);
			await db.exec(`INSERT INTO ixc VALUES (1, 'x', 1), (2, 'x', 2), (3, 'y', 1)`);
			// A leading-column-only match must NOT be treated as a conflict.
			await db.exec(`INSERT INTO ixc VALUES (4, 'x', 3)`);
			await rejects(`INSERT INTO ixc VALUES (5, 'x', 1)`);
			expect(await collect(db, `SELECT count(*) AS n FROM ixc`)).to.deep.equal([{ n: 4 }]);
		});

		it('a DESC index column encodes its seek bounds inverted', async () => {
			await db.exec(`CREATE TABLE ixd (id INTEGER PRIMARY KEY, v TEXT) USING store`);
			await db.exec(`CREATE UNIQUE INDEX ixd_v ON ixd (v DESC)`);
			await db.exec(`INSERT INTO ixd VALUES (1, 'aaa'), (2, 'bbb')`);
			await rejects(`INSERT INTO ixd VALUES (3, 'bbb')`);
			await db.exec(`INSERT INTO ixd VALUES (3, 'ccc')`);
			expect(await collect(db, `SELECT count(*) AS n FROM ixd`)).to.deep.equal([{ n: 3 }]);
		});

		it('a partial unique index constrains only its in-scope rows', async () => {
			await db.exec(`CREATE TABLE ixp (id INTEGER PRIMARY KEY, v TEXT, active INTEGER) USING store`);
			await db.exec(`CREATE UNIQUE INDEX ixp_v ON ixp (v) WHERE active = 1`);
			await db.exec(`INSERT INTO ixp VALUES (1, 'dup', 1)`);
			// Out of scope (active = 0): no conflict, and no index entry is written.
			await db.exec(`INSERT INTO ixp VALUES (2, 'dup', 0)`);
			await db.exec(`INSERT INTO ixp VALUES (3, 'dup', 0)`);
			// In scope: conflicts with row 1.
			await rejects(`INSERT INTO ixp VALUES (4, 'dup', 1)`);
			expect(await collect(db, `SELECT count(*) AS n FROM ixp`)).to.deep.equal([{ n: 3 }]);
			// Moving an out-of-scope row INTO scope now collides.
			await rejects(`UPDATE ixp SET active = 1 WHERE id = 2`);
			// Moving the in-scope row OUT frees the value.
			await db.exec(`UPDATE ixp SET active = 0 WHERE id = 1`);
			await db.exec(`UPDATE ixp SET active = 1 WHERE id = 2`);
			expect(await collect(db, `SELECT id FROM ixp WHERE active = 1`)).to.deep.equal([{ id: 2 }]);
		});

		it('a non-derived UNIQUE never seeks a PARTIAL index (it omits out-of-scope rows)', async () => {
			// The table-level UNIQUE(v) covers every row; the partial index over the same
			// column holds only `active = 1` rows. Seeking it would miss the conflict with
			// row 1, so the constraint must fall back to the full scan.
			await db.exec(`CREATE TABLE ixq (id INTEGER PRIMARY KEY, v TEXT, active INTEGER, UNIQUE (v)) USING store`);
			await db.exec(`CREATE INDEX ixq_v ON ixq (v) WHERE active = 1`);
			await db.exec(`INSERT INTO ixq VALUES (1, 'dup', 0)`); // not in the partial index
			await rejects(`INSERT INTO ixq VALUES (2, 'dup', 1)`);
			expect(await collect(db, `SELECT count(*) AS n FROM ixq`)).to.deep.equal([{ n: 1 }]);
		});

		// Collation guard: index-column bytes are encoded under the TABLE KEY collation K,
		// not the constraint's enforcement collation C. A seek is a sound superset only
		// when K is coarser-or-equal to C. With K = BINARY and C = NOCASE it UNDER-fetches,
		// so the constraint must fall back to the full scan or a real duplicate is admitted.
		describe('collation guard', () => {
			it('K = BINARY over C = NOCASE falls back to the full scan (still rejects the dup)', async () => {
				await db.exec(`CREATE TABLE gb (id INTEGER PRIMARY KEY, b TEXT COLLATE NOCASE) USING store(collation = 'BINARY')`);
				await db.exec(`CREATE UNIQUE INDEX gb_b ON gb (b)`);
				await db.exec(`INSERT INTO gb VALUES (1, 'Bob')`);
				// 'BOB' is NOCASE-equal to 'Bob' but BINARY-distinct: its index bytes land in
				// a DIFFERENT seek window, so an unguarded seek would find nothing.
				await rejects(`INSERT INTO gb VALUES (2, 'BOB')`);
				expect(await collect(db, `SELECT count(*) AS n FROM gb`)).to.deep.equal([{ n: 1 }]);
				await db.exec(`INSERT INTO gb VALUES (3, 'Carol')`);
				expect(await collect(db, `SELECT count(*) AS n FROM gb`)).to.deep.equal([{ n: 2 }]);
			});

			it('K = BINARY over C = RTRIM falls back to the full scan', async () => {
				await db.exec(`CREATE TABLE gr (id INTEGER PRIMARY KEY, b TEXT COLLATE RTRIM) USING store(collation = 'BINARY')`);
				await db.exec(`CREATE UNIQUE INDEX gr_b ON gr (b)`);
				await db.exec(`INSERT INTO gr VALUES (1, 'abc')`);
				await rejects(`INSERT INTO gr VALUES (2, 'abc   ')`);
				expect(await collect(db, `SELECT count(*) AS n FROM gr`)).to.deep.equal([{ n: 1 }]);
			});

			it('K = NOCASE over C = RTRIM falls back to the full scan', async () => {
				// NOCASE is not coarser than RTRIM: 'abc' and 'abc   ' are RTRIM-equal but
				// encode to different NOCASE bytes.
				await db.exec(`CREATE TABLE gn (id INTEGER PRIMARY KEY, b TEXT COLLATE RTRIM) USING store`);
				await db.exec(`CREATE UNIQUE INDEX gn_b ON gn (b)`);
				await db.exec(`INSERT INTO gn VALUES (1, 'abc')`);
				await rejects(`INSERT INTO gn VALUES (2, 'abc   ')`);
				expect(await collect(db, `SELECT count(*) AS n FROM gn`)).to.deep.equal([{ n: 1 }]);
			});

			it('an ANY column is treated as potentially textual (K = BINARY over C = NOCASE)', async () => {
				// ANY carries no `isTextual` marker and a NULL physicalType, but its `parse`
				// is the identity — it stores text as text and keys it through the collation
				// encoder. Exempting it as "non-text" would skip the guard and admit the dup.
				await db.exec(`CREATE TABLE ga (id INTEGER PRIMARY KEY, x ANY COLLATE NOCASE) USING store(collation = 'BINARY')`);
				await db.exec(`CREATE UNIQUE INDEX ga_x ON ga (x)`);
				await db.exec(`INSERT INTO ga VALUES (1, 'Bob')`);
				await rejects(`INSERT INTO ga VALUES (2, 'BOB')`);
				expect(await collect(db, `SELECT count(*) AS n FROM ga`)).to.deep.equal([{ n: 1 }]);
			});

			it('a JSON column is treated as potentially textual (K = BINARY over C = NOCASE)', async () => {
				// JSON's physicalType is OBJECT, but its `parse` passes a JSON scalar string
				// straight through, so the column holds text and keys it through the
				// collation encoder — exactly like ANY. `'"Bob"'` stores the string `Bob`.
				await db.exec(`CREATE TABLE gj (id INTEGER PRIMARY KEY, j JSON) USING store(collation = 'BINARY')`);
				await db.exec(`CREATE UNIQUE INDEX gj_j ON gj (j COLLATE NOCASE)`);
				await db.exec(`INSERT INTO gj VALUES (1, '"Bob"')`);
				await rejects(`INSERT INTO gj VALUES (2, '"BOB"')`);
				expect(await collect(db, `SELECT count(*) AS n FROM gj`)).to.deep.equal([{ n: 1 }]);
			});

			it('K = BINARY over C = BINARY seeks the index (equal collations)', async () => {
				await db.exec(`CREATE TABLE gq (id INTEGER PRIMARY KEY, b TEXT) USING store(collation = 'BINARY')`);
				await db.exec(`CREATE UNIQUE INDEX gq_b ON gq (b)`);
				await db.exec(`INSERT INTO gq VALUES (1, 'Bob')`);
				await db.exec(`INSERT INTO gq VALUES (2, 'BOB')`); // BINARY-distinct ⇒ admitted
				await rejects(`INSERT INTO gq VALUES (3, 'Bob')`);
				expect(await collect(db, `SELECT count(*) AS n FROM gq`)).to.deep.equal([{ n: 2 }]);
			});

			it('K = NOCASE over C = BINARY seeks the index and re-validates under BINARY', async () => {
				// K strictly coarser: the seek for 'bob' also returns 'Bob''s entry, which
				// the BINARY re-validation discards.
				await db.exec(`CREATE TABLE gc (id INTEGER PRIMARY KEY, b TEXT COLLATE NOCASE) USING store`);
				await db.exec(`CREATE UNIQUE INDEX gc_b ON gc (b COLLATE BINARY)`);
				await db.exec(`INSERT INTO gc VALUES (1, 'Bob')`);
				await db.exec(`INSERT INTO gc VALUES (2, 'bob')`);
				await rejects(`INSERT INTO gc VALUES (3, 'bob')`);
				expect(await collect(db, `SELECT count(*) AS n FROM gc`)).to.deep.equal([{ n: 2 }]);
			});
		});

		// The index-backed check TRUSTS the index store to hold an entry for every live
		// row. `CREATE INDEX` populates it from the table's effective row stream, so a
		// row inserted earlier in the SAME open transaction is indexed too. Building
		// from the committed stream alone would leave that row unindexed and the seek
		// would silently accept a duplicate of it.
		describe('an index created mid-transaction indexes the pending rows', () => {
			it('a duplicate of a pending row is still rejected after CREATE UNIQUE INDEX', async () => {
				await db.exec(`CREATE TABLE mt (id INTEGER PRIMARY KEY, v TEXT) USING store`);
				await db.exec(`BEGIN`);
				await db.exec(`INSERT INTO mt VALUES (1, 'a')`);
				await db.exec(`CREATE UNIQUE INDEX mt_v ON mt (v)`);
				await rejects(`INSERT INTO mt VALUES (2, 'a')`);
				await db.exec(`INSERT INTO mt VALUES (2, 'b')`);
				await db.exec(`COMMIT`);
				expect(await collect(db, `SELECT id, v FROM mt ORDER BY id`)).to.deep.equal([
					{ id: 1, v: 'a' }, { id: 2, v: 'b' },
				]);
			});

			it('CREATE UNIQUE INDEX over pending duplicates fails its in-pass check', async () => {
				await db.exec(`CREATE TABLE mtd (id INTEGER PRIMARY KEY, v TEXT) USING store`);
				await db.exec(`BEGIN`);
				await db.exec(`INSERT INTO mtd VALUES (1, 'a'), (2, 'a')`);
				await rejects(`CREATE UNIQUE INDEX mtd_v ON mtd (v)`);
				await db.exec(`ROLLBACK`);
			});

			it('a rolled-back pending row leaves no phantom conflict behind', async () => {
				// The index store is written outside the coordinator, so a ROLLBACK leaves
				// its entries behind. Both readers resolve each entry to its live row and
				// drop it when the row is gone or no longer matches, so the stale entry can
				// never manufacture a conflict.
				await db.exec(`CREATE TABLE mtr (id INTEGER PRIMARY KEY, v TEXT) USING store`);
				await db.exec(`BEGIN`);
				await db.exec(`INSERT INTO mtr VALUES (1, 'a')`);
				await db.exec(`CREATE UNIQUE INDEX mtr_v ON mtr (v)`);
				await db.exec(`ROLLBACK`);
				await db.exec(`INSERT INTO mtr VALUES (1, 'b')`);
				await db.exec(`INSERT INTO mtr VALUES (2, 'a')`);
				expect(await collect(db, `SELECT id, v FROM mtr ORDER BY id`)).to.deep.equal([
					{ id: 1, v: 'b' }, { id: 2, v: 'a' },
				]);
				await rejects(`INSERT INTO mtr VALUES (3, 'a')`);
			});
		});

		// The point of the reroute: inserting n rows under a UNIQUE constraint must not
		// re-scan the n already-present rows. Asserted structurally (entries yielded by the
		// data store's iterators) rather than by wall-clock, so it cannot flake.
		describe('scaling', () => {
			const ROWS = 100;

			it('an index-backed UNIQUE never full-scans the data store; a bare UNIQUE does', async () => {
				const counting = createCountingProvider();
				const cdb = new Database();
				cdb.registerModule('store', new StoreModule(counting));
				try {
					await cdb.exec(`CREATE TABLE bare (id INTEGER PRIMARY KEY, v INTEGER, UNIQUE (v)) USING store`);
					await cdb.exec(`CREATE TABLE idxd (id INTEGER PRIMARY KEY, v INTEGER) USING store`);
					await cdb.exec(`CREATE UNIQUE INDEX idxd_v ON idxd (v)`);

					for (let i = 0; i < ROWS; i++) {
						await cdb.exec(`INSERT INTO bare VALUES (${i}, ${i})`);
						await cdb.exec(`INSERT INTO idxd VALUES (${i}, ${i})`);
					}

					// The bare UNIQUE re-scans every prior row: Θ(ROWS²/2) entries.
					expect(counting.dataEntriesScanned('bare')).to.be.greaterThan(ROWS * 10);
					// The index-backed UNIQUE resolves each candidate by data-store `get`,
					// never by iterating the data store.
					expect(counting.dataEntriesScanned('idxd')).to.equal(0);

					expect(await collect(cdb, `SELECT count(*) AS n FROM idxd`)).to.deep.equal([{ n: ROWS }]);
				} finally {
					await cdb.close();
					await counting.closeAll();
				}
			});
		});
	});
});
