/**
 * Tests for column-level / table-level ON CONFLICT defaults in StoreTable.
 *
 * Exercises StoreModule directly (without the isolation layer overlay) so the
 * three-tier precedence `statement OR > per-constraint default > ABORT` is
 * observable inside StoreTable.update. The isolation-wrapped path is covered
 * by the engine's logic tests (29.1-column-level-conflict-clause.sqllogic).
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, type SqlValue } from '@quereus/quereus';
import {
	StoreModule,
	StoreEventEmitter,
	InMemoryKVStore,
	type KVStoreProvider,
	type SchemaChangeEvent,
} from '../src/index.js';
import { buildFullScanBounds } from '../src/common/key-builder.js';

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
	const evictIndex = (s: string, t: string, i: string) => {
		// Drop the cached handle so a subsequent getIndexStore returns a fresh
		// InMemoryKVStore — mirrors how the LevelDB provider's closeIndexStore /
		// deleteIndexStore remove their cache entry.
		stores.delete(`${s}.${t}_idx_${i}`);
	};
	return {
		async getStore(s, t) { return get(`${s}.${t}`); },
		async getIndexStore(s, t, i) { return get(`${s}.${t}_idx_${i}`); },
		async getStatsStore(s, t) { return get(`${s}.${t}.__stats__`); },
		async getCatalogStore() { return get('__catalog__'); },
		async closeStore() {},
		async closeIndexStore(s, t, i) { evictIndex(s, t, i); },
		async deleteIndexStore(s, t, i) { evictIndex(s, t, i); },
		async closeAll() {
			for (const store of stores.values()) await store.close();
			stores.clear();
		},
	};
}

describe('StoreTable column-level ON CONFLICT defaults', () => {
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

	describe('INSERT with PRIMARY KEY ON CONFLICT REPLACE', () => {
		it('silently replaces an existing row at the duplicate PK', async () => {
			await db.exec(`
				CREATE TABLE pk_replace (
					a INTEGER PRIMARY KEY ON CONFLICT REPLACE,
					b TEXT
				) USING store
			`);
			await db.exec(`INSERT INTO pk_replace VALUES (1, 'first')`);
			await db.exec(`INSERT INTO pk_replace VALUES (1, 'second')`);

			const rows = await collect(db, `SELECT a, b FROM pk_replace`);
			expect(rows).to.deep.equal([{ a: 1, b: 'second' }]);
		});
	});

	describe('INSERT with PRIMARY KEY ON CONFLICT IGNORE', () => {
		it('silently drops the duplicate INSERT', async () => {
			await db.exec(`
				CREATE TABLE pk_ignore (
					a INTEGER PRIMARY KEY ON CONFLICT IGNORE,
					b TEXT
				) USING store
			`);
			await db.exec(`INSERT INTO pk_ignore VALUES (10, 'data')`);
			await db.exec(`INSERT INTO pk_ignore VALUES (10, 'conflict')`);

			const rows = await collect(db, `SELECT a, b FROM pk_ignore`);
			expect(rows).to.deep.equal([{ a: 10, b: 'data' }]);
		});
	});

	describe('INSERT with UNIQUE ON CONFLICT REPLACE', () => {
		it('replaces the existing row that owns the duplicate UNIQUE value', async () => {
			await db.exec(`
				CREATE TABLE uniq_replace (
					id INTEGER PRIMARY KEY,
					email TEXT UNIQUE ON CONFLICT REPLACE
				) USING store
			`);
			await db.exec(`INSERT INTO uniq_replace VALUES (1, 'a@x')`);
			await db.exec(`INSERT INTO uniq_replace VALUES (2, 'a@x')`);

			const rows = await collect(db, `SELECT id, email FROM uniq_replace ORDER BY id`);
			expect(rows).to.deep.equal([{ id: 2, email: 'a@x' }]);
		});
	});

	describe('UPDATE PK-change with PRIMARY KEY ON CONFLICT REPLACE', () => {
		it('evicts the row at the colliding PK and moves the updated row in', async () => {
			await db.exec(`
				CREATE TABLE pk_upd_replace (
					id INTEGER PRIMARY KEY ON CONFLICT REPLACE,
					v TEXT
				) USING store
			`);
			await db.exec(`INSERT INTO pk_upd_replace VALUES (1, 'a')`);
			await db.exec(`INSERT INTO pk_upd_replace VALUES (2, 'b')`);

			// No statement-level OR — column-level REPLACE should apply.
			await db.exec(`UPDATE pk_upd_replace SET id = 2 WHERE id = 1`);

			const rows = await collect(db, `SELECT id, v FROM pk_upd_replace ORDER BY id`);
			expect(rows).to.deep.equal([{ id: 2, v: 'a' }]);
		});
	});

	describe('UPDATE PK-change with PRIMARY KEY ON CONFLICT IGNORE', () => {
		it('drops the UPDATE silently when the new PK is occupied', async () => {
			await db.exec(`
				CREATE TABLE pk_upd_ignore (
					id INTEGER PRIMARY KEY ON CONFLICT IGNORE,
					v TEXT
				) USING store
			`);
			await db.exec(`INSERT INTO pk_upd_ignore VALUES (1, 'a')`);
			await db.exec(`INSERT INTO pk_upd_ignore VALUES (2, 'b')`);

			await db.exec(`UPDATE pk_upd_ignore SET id = 2 WHERE id = 1`);

			const rows = await collect(db, `SELECT id, v FROM pk_upd_ignore ORDER BY id`);
			expect(rows).to.deep.equal([
				{ id: 1, v: 'a' },
				{ id: 2, v: 'b' },
			]);
		});
	});

	describe('statement-level OR overrides column-level directive', () => {
		// UPDATE OR <action> is intentionally not supported by the parser
		// (see logic/47.2 §5 and docs/sql.md §11), so the only statement-level
		// override path is INSERT OR <action>.
		it('INSERT OR ABORT defeats column-level ON CONFLICT IGNORE', async () => {
			await db.exec(`
				CREATE TABLE override_t (
					a INTEGER PRIMARY KEY ON CONFLICT IGNORE,
					b TEXT
				) USING store
			`);
			await db.exec(`INSERT INTO override_t VALUES (1, 'first')`);

			let err: Error | null = null;
			try {
				await db.exec(`INSERT OR ABORT INTO override_t VALUES (1, 'second')`);
			} catch (e) {
				err = e as Error;
			}
			expect(err).to.not.be.null;
			expect(err!.message).to.match(/UNIQUE constraint failed/i);

			const rows = await collect(db, `SELECT a, b FROM override_t`);
			expect(rows).to.deep.equal([{ a: 1, b: 'first' }]);
		});
	});

	describe('CREATE INDEX refreshes cached tableSchema', () => {
		it('maintains the new index on inserts and updates issued after CREATE INDEX', async () => {
			await db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, b INTEGER) USING store`);
			await db.exec(`INSERT INTO t VALUES (1, 100)`);
			await db.exec(`CREATE INDEX t_b ON t (b)`);

			const idxStore = await provider.getIndexStore('main', 't', 't_b');
			const countEntries = async (): Promise<number> => {
				let n = 0;
				for await (const _entry of idxStore.iterate(buildFullScanBounds())) n++;
				return n;
			};

			// Sanity: CREATE INDEX backfilled the existing row.
			expect(await countEntries()).to.equal(1);

			// New rows inserted after CREATE INDEX must be indexed too.
			await db.exec(`INSERT INTO t VALUES (2, 200)`);
			await db.exec(`INSERT INTO t VALUES (3, 300)`);
			expect(await countEntries()).to.equal(3);

			// Updates to indexed columns move the entry (delete-old + put-new),
			// so the total count stays the same.
			await db.exec(`UPDATE t SET b = 999 WHERE id = 1`);
			expect(await countEntries()).to.equal(3);

			// Deletes remove the entry.
			await db.exec(`DELETE FROM t WHERE id = 2`);
			expect(await countEntries()).to.equal(2);
		});

		it('moves the secondary index entry to the new PK on PK-change UPDATE', async () => {
			// Regression: updateSecondaryIndexes used a single pk for both the
			// delete-old and put-new index keys, so PK-change UPDATE left the
			// old entry behind at (indexvals, oldPk).
			await db.exec(`CREATE TABLE m (id INTEGER PRIMARY KEY, b INTEGER) USING store`);
			await db.exec(`CREATE INDEX m_b ON m (b)`);
			await db.exec(`INSERT INTO m VALUES (1, 100)`);

			await db.exec(`UPDATE m SET id = 5 WHERE id = 1`);

			const idxStore = await provider.getIndexStore('main', 'm', 'm_b');
			let entries = 0;
			for await (const _e of idxStore.iterate(buildFullScanBounds())) entries++;
			expect(entries, 'old (b=100, pk=1) index entry should not leak').to.equal(1);

			// And the surviving entry must point at the new PK — confirm by
			// matching the index-backed lookup against the relocated row.
			const rows = await collect(db, `SELECT id, b FROM m WHERE b = 100`);
			expect(rows).to.deep.equal([{ id: 5, b: 100 }]);
		});

		it('enforces uniqueness for a UNIQUE index created after CREATE TABLE', async () => {
			await db.exec(`CREATE TABLE u (id INTEGER PRIMARY KEY, b INTEGER) USING store`);
			await db.exec(`INSERT INTO u VALUES (1, 100)`);
			await db.exec(`CREATE UNIQUE INDEX u_b ON u (b)`);

			// Inserting a duplicate value on the newly-uniqued column must be
			// rejected. Without uniqueConstraints being refreshed on the cached
			// StoreTable schema, this insert silently succeeds.
			let threw = false;
			try {
				await db.exec(`INSERT INTO u VALUES (2, 100)`);
			} catch (e) {
				threw = true;
				expect(String(e)).to.match(/unique/i);
			}
			expect(threw, 'expected UNIQUE constraint violation').to.equal(true);

			// A non-conflicting insert still works.
			await db.exec(`INSERT INTO u VALUES (3, 200)`);
			const rows = await collect(db, `SELECT id, b FROM u ORDER BY id`);
			expect(rows).to.deep.equal([
				{ id: 1, b: 100 },
				{ id: 3, b: 200 },
			]);
		});

		it('rejects CREATE UNIQUE INDEX over duplicated data and leaves the index store empty', async () => {
			await db.exec(`CREATE TABLE u_dup (k TEXT PRIMARY KEY, x TEXT NOT NULL) USING store`);
			await db.exec(`INSERT INTO u_dup VALUES ('r1', 'dup'), ('r2', 'dup')`);

			let err: Error | null = null;
			try {
				await db.exec(`CREATE UNIQUE INDEX u_dup_x ON u_dup (x)`);
			} catch (e) {
				err = e as Error;
			}
			expect(err, 'expected CREATE UNIQUE INDEX to fail').to.not.be.null;
			expect(err!.message).to.match(/UNIQUE/i);

			// The index-store directory is allocated by getIndexStore(), but no
			// entries must have been written — the seed pass throws before
			// batch.write().
			const idxStore = await provider.getIndexStore('main', 'u_dup', 'u_dup_x');
			let entries = 0;
			for await (const _e of idxStore.iterate(buildFullScanBounds())) entries++;
			expect(entries, 'no partial index entries should be written').to.equal(0);

			// After deduplicating, the index creates fine.
			await db.exec(`DELETE FROM u_dup WHERE k = 'r2'`);
			await db.exec(`CREATE UNIQUE INDEX u_dup_x ON u_dup (x)`);
		});

		it('allows CREATE UNIQUE INDEX over multiple NULLs in composite indexed columns', async () => {
			await db.exec(`CREATE TABLE u_null (k INTEGER PRIMARY KEY, y TEXT NULL, z TEXT NULL) USING store`);
			await db.exec(`INSERT INTO u_null VALUES (1, NULL, NULL), (2, NULL, NULL)`);

			// SQL UNIQUE allows multiple NULLs — seed pass must not flag these.
			await db.exec(`CREATE UNIQUE INDEX u_null_yz ON u_null (y, z)`);

			const rows = await collect(db, `SELECT count(*) AS cnt FROM u_null`);
			expect(rows).to.deep.equal([{ cnt: 2 }]);
		});

		it('partial UNIQUE seed pass: duplicates outside the predicate scope are allowed', async () => {
			await db.exec(`CREATE TABLE u_partial_ok (k INTEGER PRIMARY KEY, x TEXT NOT NULL, active INTEGER NOT NULL) USING store`);
			// Two rows with the same x but BOTH outside the partial-predicate (active=1) scope.
			await db.exec(`INSERT INTO u_partial_ok VALUES (1, 'dup', 0), (2, 'dup', 0), (3, 'unique', 1)`);

			await db.exec(`CREATE UNIQUE INDEX u_partial_ok_idx ON u_partial_ok (x) WHERE active = 1`);

			const rows = await collect(db, `SELECT count(*) AS cnt FROM u_partial_ok`);
			expect(rows).to.deep.equal([{ cnt: 3 }]);
		});

		it('partial UNIQUE seed pass: duplicates inside the predicate scope are rejected', async () => {
			await db.exec(`CREATE TABLE u_partial_bad (k INTEGER PRIMARY KEY, x TEXT NOT NULL, active INTEGER NOT NULL) USING store`);
			// Two rows with the same x BOTH inside the partial-predicate (active=1) scope.
			await db.exec(`INSERT INTO u_partial_bad VALUES (1, 'dup', 1), (2, 'dup', 1), (3, 'dup', 0)`);

			let err: Error | null = null;
			try {
				await db.exec(`CREATE UNIQUE INDEX u_partial_bad_idx ON u_partial_bad (x) WHERE active = 1`);
			} catch (e) {
				err = e as Error;
			}
			expect(err, 'expected partial UNIQUE seed pass to fail on in-scope duplicates').to.not.be.null;
			expect(err!.message).to.match(/UNIQUE/i);
		});
	});

	describe('DROP INDEX refreshes cached tableSchema and releases index store', () => {
		it('drops the UNIQUE constraint synthesized by CREATE UNIQUE INDEX', async () => {
			await db.exec(`CREATE TABLE du (id INTEGER PRIMARY KEY, b INTEGER) USING store`);
			await db.exec(`INSERT INTO du VALUES (1, 100)`);
			await db.exec(`CREATE UNIQUE INDEX du_b ON du (b)`);

			// While the UNIQUE index exists, the duplicate is rejected.
			let threw = false;
			try {
				await db.exec(`INSERT INTO du VALUES (2, 100)`);
			} catch (e) {
				threw = true;
				expect(String(e)).to.match(/unique/i);
			}
			expect(threw, 'duplicate must violate UNIQUE while the index exists').to.equal(true);

			// After DROP INDEX, the synthesized UNIQUE constraint must be gone
			// from the cached StoreTable schema — the previously-rejected insert
			// now succeeds.
			await db.exec(`DROP INDEX du_b`);
			await db.exec(`INSERT INTO du VALUES (2, 100)`);

			const rows = await collect(db, `SELECT id, b FROM du ORDER BY id`);
			expect(rows).to.deep.equal([
				{ id: 1, b: 100 },
				{ id: 2, b: 100 },
			]);
		});

		it('stops maintaining the dropped non-UNIQUE index store on subsequent inserts', async () => {
			await db.exec(`CREATE TABLE dn (id INTEGER PRIMARY KEY, b INTEGER) USING store`);
			await db.exec(`CREATE INDEX dn_b ON dn (b)`);
			await db.exec(`INSERT INTO dn VALUES (1, 100)`);

			const countEntries = async (): Promise<number> => {
				const store = await provider.getIndexStore('main', 'dn', 'dn_b');
				let n = 0;
				for await (const _entry of store.iterate(buildFullScanBounds())) n++;
				return n;
			};

			// Sanity: the live index has one entry.
			expect(await countEntries()).to.equal(1);

			await db.exec(`DROP INDEX dn_b`);

			// After drop: any subsequent INSERT must not write into the dropped
			// index store. The fixture's closeIndexStore evicts the cached entry,
			// so getIndexStore returns a fresh empty store; if StoreTable kept
			// maintaining the index (i.e. still found it on tableSchema.indexes),
			// a new key would land here.
			await db.exec(`INSERT INTO dn VALUES (2, 200)`);
			expect(await countEntries()).to.equal(0);
		});

		it('emits a schemaChange event with type=drop, objectType=index', async () => {
			const emitter = new StoreEventEmitter();
			const localProvider = createInMemoryProvider();
			const localDb = new Database();
			try {
				localDb.registerModule('store', new StoreModule(localProvider, emitter));
				await localDb.exec(`CREATE TABLE de (id INTEGER PRIMARY KEY, b INTEGER) USING store`);
				await localDb.exec(`CREATE INDEX de_b ON de (b)`);

				const events: SchemaChangeEvent[] = [];
				const off = emitter.onSchemaChange(e => events.push(e));
				try {
					await localDb.exec(`DROP INDEX de_b`);
				} finally {
					off();
				}

				const dropEvents = events.filter(
					e => e.type === 'drop' && e.objectType === 'index' && e.objectName === 'de_b',
				);
				expect(dropEvents).to.have.lengthOf(1);
				expect(dropEvents[0].schemaName.toLowerCase()).to.equal('main');
			} finally {
				await localProvider.closeAll();
			}
		});
	});

	describe('UPDATE PK-change REPLACE cascades ON DELETE for evicted row', () => {
		it('CASCADE deletes children of the evicted row', async () => {
			// Quereus's default ON UPDATE is RESTRICT, so any child of the moved
			// row would block the update before eviction can happen. Only the
			// row that gets evicted has a child here.
			await db.exec(`
				CREATE TABLE parent_evict (
					id INTEGER PRIMARY KEY ON CONFLICT REPLACE,
					v TEXT
				) USING store
			`);
			await db.exec(`
				CREATE TABLE child_evict (
					id INTEGER PRIMARY KEY,
					parent_id INTEGER REFERENCES parent_evict(id) ON DELETE CASCADE
				) USING store
			`);
			await db.exec(`INSERT INTO parent_evict VALUES (1, 'one')`);
			await db.exec(`INSERT INTO parent_evict VALUES (2, 'two')`);
			await db.exec(`INSERT INTO child_evict VALUES (20, 2)`);

			await db.exec(`UPDATE parent_evict SET id = 2 WHERE id = 1`);

			const children = await collect(db, `SELECT id, parent_id FROM child_evict`);
			expect(children).to.deep.equal([]);

			const parents = await collect(db, `SELECT id, v FROM parent_evict ORDER BY id`);
			expect(parents).to.deep.equal([{ id: 2, v: 'one' }]);
		});
	});

});
