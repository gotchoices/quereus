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
			// matches) and the re-validation filters under the index BINARY. NOTE: this is
			// a store-only assertion — memory's checkUniqueViaMaterializedView re-validates
			// under the declared collation, so the MV-backed path is one place store and
			// memory still differ for a finer-index derived UNIQUE (see review handoff).
			await db.exec(`CREATE TABLE fam (id INTEGER PRIMARY KEY, b TEXT COLLATE NOCASE) USING store`);
			await db.exec(`CREATE UNIQUE INDEX fam_b ON fam (b COLLATE BINARY)`);
			await db.exec(`CREATE MATERIALIZED VIEW fam_mv AS SELECT b, id FROM fam ORDER BY b`);
			await db.exec(`INSERT INTO fam VALUES (1, 'Bob')`);
			await db.exec(`INSERT INTO fam VALUES (2, 'bob')`); // BINARY-distinct ⇒ admitted via MV path
			expect(await collect(db, `SELECT id, b FROM fam ORDER BY id`)).to.deep.equal([
				{ id: 1, b: 'Bob' }, { id: 2, b: 'bob' },
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
});
