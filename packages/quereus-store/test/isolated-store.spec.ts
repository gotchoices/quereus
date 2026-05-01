/**
 * Tests for isolated store module - store module wrapped with isolation layer.
 *
 * These tests verify that the isolation layer properly provides:
 * - Read-your-own-writes within transactions
 * - Snapshot isolation
 * - Savepoint support
 * - Proper commit/rollback behavior
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, asyncIterableToArray } from '@quereus/quereus';
import {
	createIsolatedStoreModule,
	hasIsolation,
	StoreModule,
	InMemoryKVStore,
	type KVStoreProvider,
} from '../src/index.js';

/**
 * Creates an in-memory KVStoreProvider for testing.
 */
function createInMemoryProvider(): KVStoreProvider {
	const stores = new Map<string, InMemoryKVStore>();

	return {
		async getStore(schemaName: string, tableName: string) {
			const key = `${schemaName}.${tableName}`;
			if (!stores.has(key)) {
				stores.set(key, new InMemoryKVStore());
			}
			return stores.get(key)!;
		},
		async getIndexStore(schemaName: string, tableName: string, indexName: string) {
			const key = `${schemaName}.${tableName}_idx_${indexName}`;
			if (!stores.has(key)) {
				stores.set(key, new InMemoryKVStore());
			}
			return stores.get(key)!;
		},
		async getStatsStore(schemaName: string, tableName: string) {
			const key = `${schemaName}.${tableName}.__stats__`;
			if (!stores.has(key)) {
				stores.set(key, new InMemoryKVStore());
			}
			return stores.get(key)!;
		},
		async getCatalogStore() {
			const key = '__catalog__';
			if (!stores.has(key)) {
				stores.set(key, new InMemoryKVStore());
			}
			return stores.get(key)!;
		},
		async closeStore(_schemaName: string, _tableName: string) {
			// No-op for in-memory stores
		},
		async closeIndexStore(_schemaName: string, _tableName: string, _indexName: string) {
			// No-op for in-memory stores
		},
		async closeAll() {
			for (const store of stores.values()) {
				await store.close();
			}
			stores.clear();
		},
	};
}

describe('Store Module (non-isolated)', () => {
	let db: Database;
	let provider: KVStoreProvider;

	beforeEach(() => {
		db = new Database();
		provider = createInMemoryProvider();
	});

	afterEach(async () => {
		await provider.closeAll();
	});

	describe('basic CRUD without isolation', () => {
		beforeEach(async () => {
			const storeModule = new StoreModule(provider);
			db.registerModule('store', storeModule);
			await db.exec(`
				CREATE TABLE users (
					id INTEGER PRIMARY KEY,
					name TEXT
				) USING store
			`);
		});

		it('supports INSERT and SELECT', async () => {
			await db.exec(`INSERT INTO users VALUES (1, 'Alice')`);
			const result = await db.get('SELECT * FROM users WHERE id = 1');
			expect(result?.name).to.equal('Alice');
		});

		it('supports UPDATE', async () => {
			await db.exec(`INSERT INTO users VALUES (1, 'Alice')`);
			await db.exec(`UPDATE users SET name = 'Alicia' WHERE id = 1`);
			const result = await db.get('SELECT * FROM users WHERE id = 1');
			expect(result?.name).to.equal('Alicia');
		});

		it('supports DELETE', async () => {
			await db.exec(`INSERT INTO users VALUES (1, 'Alice')`);
			await db.exec(`DELETE FROM users WHERE id = 1`);
			const result = await db.get('SELECT * FROM users WHERE id = 1');
			expect(result).to.be.undefined;
		});
	});
});

describe('Isolated Store Module', () => {
	let db: Database;
	let provider: KVStoreProvider;

	beforeEach(() => {
		db = new Database();
		provider = createInMemoryProvider();
	});

	afterEach(async () => {
		await provider.closeAll();
	});

	describe('hasIsolation utility', () => {
		it('returns false for base StoreModule', () => {
			const storeModule = new StoreModule(provider);
			expect(hasIsolation(storeModule)).to.be.false;
		});

		it('returns true for isolated store module', () => {
			const isolatedModule = createIsolatedStoreModule({ provider });
			expect(hasIsolation(isolatedModule)).to.be.true;
		});
	});

	describe('capabilities', () => {
		it('base StoreModule reports no isolation', () => {
			const storeModule = new StoreModule(provider);
			const caps = storeModule.getCapabilities();
			expect(caps.isolation).to.be.false;
			expect(caps.savepoints).to.be.false;
			expect(caps.persistent).to.be.true;
			expect(caps.secondaryIndexes).to.be.true;
			expect(caps.rangeScans).to.be.true;
		});

		it('isolated store module reports isolation enabled', () => {
			const isolatedModule = createIsolatedStoreModule({ provider });
			const caps = isolatedModule.getCapabilities();
			expect(caps.isolation).to.be.true;
			expect(caps.savepoints).to.be.true;
			expect(caps.persistent).to.be.true;
		});
	});

	describe('table creation', () => {
		it('creates isolated store table via CREATE TABLE', async () => {
			const isolatedModule = createIsolatedStoreModule({ provider });
			db.registerModule('store', isolatedModule);

			await db.exec(`
				CREATE TABLE users (
					id INTEGER PRIMARY KEY,
					name TEXT
				) USING store
			`);

			// Table should exist
			const result = await db.get(`SELECT name FROM schema() WHERE type = 'table' AND name = 'users'`);
			expect(result?.name).to.equal('users');
		});
	});

	// Note: The following tests verify the isolation layer infrastructure when wrapping
	// the store module. Full integration requires additional work on transaction
	// coordination between the store module and the overlay memory module.
	// For now, we test the basic infrastructure and APIs.

	describe('basic operations with explicit transactions', () => {
		beforeEach(async () => {
			const isolatedModule = createIsolatedStoreModule({ provider });
			db.registerModule('store', isolatedModule);
			await db.exec(`
				CREATE TABLE users (
					id INTEGER PRIMARY KEY,
					name TEXT
				) USING store
			`);
		});

		it('supports INSERT within transaction with read-your-own-writes', async () => {
			await db.exec('BEGIN');
			await db.exec(`INSERT INTO users VALUES (1, 'Alice')`);

			// Should see uncommitted write within the same transaction
			const result = await db.get('SELECT * FROM users WHERE id = 1');
			expect(result?.name).to.equal('Alice');

			await db.exec('ROLLBACK');
		});

		it('supports multiple INSERTs within transaction', async () => {
			await db.exec('BEGIN');
			await db.exec(`INSERT INTO users VALUES (1, 'Alice')`);
			await db.exec(`INSERT INTO users VALUES (2, 'Bob')`);

			const all = await asyncIterableToArray(db.eval('SELECT * FROM users ORDER BY id'));
			expect(all.length).to.equal(2);
			expect(all[0].name).to.equal('Alice');
			expect(all[1].name).to.equal('Bob');

			await db.exec('ROLLBACK');
		});

		it('supports UPDATE within transaction with read-your-own-writes', async () => {
			// Seed committed state
			await db.exec(`INSERT INTO users VALUES (1, 'Alice')`);

			await db.exec('BEGIN');
			await db.exec(`UPDATE users SET name = 'Alicia' WHERE id = 1`);

			// In-transaction read sees the updated value (read-your-own-writes)
			const inTxn = await db.get('SELECT * FROM users WHERE id = 1');
			expect(inTxn?.name).to.equal('Alicia');

			// committed.* sees the pre-transaction value
			const committed = await db.get('SELECT * FROM committed.users WHERE id = 1');
			expect(committed?.name).to.equal('Alice');

			await db.exec('ROLLBACK');

			// After rollback, underlying retains the original value
			const afterRollback = await db.get('SELECT * FROM users WHERE id = 1');
			expect(afterRollback?.name).to.equal('Alice');
		});
	});

	describe('ALTER TABLE overlay migration', () => {
		it('INSERT then ADD COLUMN: overlay row survives with NULL in new column', async () => {
			const isolatedModule = createIsolatedStoreModule({ provider });
			db.registerModule('store', isolatedModule);
			await db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT) USING store`);

			await db.exec('BEGIN');
			await db.exec(`INSERT INTO t VALUES (1, 'Alice')`);
			await db.exec(`ALTER TABLE t ADD COLUMN score INTEGER`);

			const row = await db.get('SELECT * FROM t WHERE id = 1');
			expect(row?.id).to.equal(1);
			expect(row?.name).to.equal('Alice');
			expect(row?.score).to.be.null;

			await db.exec('ROLLBACK');
		});

		it('INSERT then DROP COLUMN: overlay row survives without dropped column', async () => {
			const isolatedModule = createIsolatedStoreModule({ provider });
			db.registerModule('store', isolatedModule);
			await db.exec(`CREATE TABLE t2 (id INTEGER PRIMARY KEY, name TEXT, extra TEXT) USING store`);

			await db.exec('BEGIN');
			await db.exec(`INSERT INTO t2 VALUES (1, 'Alice', 'x')`);
			await db.exec(`ALTER TABLE t2 DROP COLUMN extra`);

			const row = await db.get('SELECT * FROM t2 WHERE id = 1');
			expect(row?.id).to.equal(1);
			expect(row?.name).to.equal('Alice');
			expect(row).to.not.have.property('extra');

			await db.exec('ROLLBACK');
		});

		it('INSERT then RENAME COLUMN: overlay row is intact under the new column name', async () => {
			const isolatedModule = createIsolatedStoreModule({ provider });
			db.registerModule('store', isolatedModule);
			await db.exec(`CREATE TABLE t3 (id INTEGER PRIMARY KEY, old_name TEXT) USING store`);

			await db.exec('BEGIN');
			await db.exec(`INSERT INTO t3 VALUES (1, 'Alice')`);
			await db.exec(`ALTER TABLE t3 RENAME COLUMN old_name TO new_name`);

			const row = await db.get('SELECT * FROM t3 WHERE id = 1');
			expect(row?.id).to.equal(1);
			expect(row?.new_name).to.equal('Alice');
			expect(row).to.not.have.property('old_name');

			await db.exec('ROLLBACK');
		});
	});

	describe('cross-layer UNIQUE / PK conflict detection', () => {
		let isolatedModule: ReturnType<typeof createIsolatedStoreModule>;

		beforeEach(async () => {
			isolatedModule = createIsolatedStoreModule({ provider });
			db.registerModule('store', isolatedModule);
		});

		afterEach(async () => {
			try { await isolatedModule.closeAll(); } catch { /* ignore */ }
		});

		it('INSERT with PK that collides with underlying row throws constraint error', async () => {
			await db.exec(`CREATE TABLE t_pk (id INTEGER PRIMARY KEY, val TEXT) USING store`);
			await db.exec(`INSERT INTO t_pk VALUES (1, 'original')`);

			let err: Error | null = null;
			try {
				await db.exec(`INSERT INTO t_pk VALUES (1, 'duplicate')`);
			} catch (e) { err = e as Error; }
			expect(err?.message.toLowerCase()).to.include('unique constraint');

			const row = await db.get(`SELECT val FROM t_pk WHERE id = 1`);
			expect(row?.val).to.equal('original');
		});

		it('INSERT OR IGNORE on PK collision with underlying is a silent no-op', async () => {
			await db.exec(`CREATE TABLE t_ig (id INTEGER PRIMARY KEY, val TEXT) USING store`);
			await db.exec(`INSERT INTO t_ig VALUES (1, 'original')`);
			await db.exec(`INSERT OR IGNORE INTO t_ig VALUES (1, 'should-be-ignored')`);

			const row = await db.get(`SELECT val FROM t_ig WHERE id = 1`);
			expect(row?.val).to.equal('original');
		});

		it('INSERT OR REPLACE on PK collision with underlying replaces the row', async () => {
			await db.exec(`CREATE TABLE t_rep (id INTEGER PRIMARY KEY, val TEXT) USING store`);
			await db.exec(`INSERT INTO t_rep VALUES (1, 'original')`);
			await db.exec(`INSERT OR REPLACE INTO t_rep VALUES (1, 'replaced')`);

			const row = await db.get(`SELECT val FROM t_rep WHERE id = 1`);
			expect(row?.val).to.equal('replaced');
		});

		it('INSERT with non-PK UNIQUE column conflicting with underlying throws constraint error', async () => {
			await db.exec(`CREATE TABLE t_uc (id INTEGER PRIMARY KEY, email TEXT UNIQUE) USING store`);
			await db.exec(`INSERT INTO t_uc VALUES (1, 'alice@test.com')`);

			let err: Error | null = null;
			try {
				await db.exec(`INSERT INTO t_uc VALUES (2, 'alice@test.com')`);
			} catch (e) { err = e as Error; }
			expect(err?.message.toLowerCase()).to.include('unique constraint');

			const cnt = await db.get(`SELECT count(*) as cnt FROM t_uc`);
			expect(cnt?.cnt).to.equal(1);
		});

		it('INSERT OR IGNORE on non-PK UNIQUE collision with underlying is a silent no-op', async () => {
			await db.exec(`CREATE TABLE t_uig (id INTEGER PRIMARY KEY, email TEXT UNIQUE) USING store`);
			await db.exec(`INSERT INTO t_uig VALUES (1, 'alice@test.com')`);
			await db.exec(`INSERT OR IGNORE INTO t_uig VALUES (2, 'alice@test.com')`);

			const cnt = await db.get(`SELECT count(*) as cnt FROM t_uig`);
			expect(cnt?.cnt).to.equal(1);
		});

		it('INSERT OR REPLACE evicts the conflicting underlying row on non-PK UNIQUE conflict', async () => {
			await db.exec(`CREATE TABLE t_urep (id INTEGER PRIMARY KEY, email TEXT UNIQUE, name TEXT) USING store`);
			await db.exec(`INSERT INTO t_urep VALUES (1, 'alice@test.com', 'Alice')`);
			await db.exec(`INSERT OR REPLACE INTO t_urep VALUES (5, 'alice@test.com', 'Replaced')`);

			const rows = await db.get(`SELECT id, name FROM t_urep WHERE email = 'alice@test.com'`);
			expect(rows?.id).to.equal(5);
			expect(rows?.name).to.equal('Replaced');

			const old = await db.get(`SELECT id FROM t_urep WHERE id = 1`);
			expect(old).to.be.undefined;
		});

		it('UPDATE changing UNIQUE column to a conflicting underlying value throws constraint error', async () => {
			await db.exec(`CREATE TABLE t_uupd (id INTEGER PRIMARY KEY, tag TEXT UNIQUE) USING store`);
			await db.exec(`INSERT INTO t_uupd VALUES (1, 'alpha')`);
			await db.exec(`INSERT INTO t_uupd VALUES (2, 'beta')`);

			let err: Error | null = null;
			try {
				await db.exec(`UPDATE t_uupd SET tag = 'alpha' WHERE id = 2`);
			} catch (e) { err = e as Error; }
			expect(err?.message.toLowerCase()).to.include('unique constraint');

			const row = await db.get(`SELECT tag FROM t_uupd WHERE id = 2`);
			expect(row?.tag).to.equal('beta');
		});

		it('composite UNIQUE: INSERT with conflicting (a,b) from underlying throws, non-conflicting succeeds', async () => {
			await db.exec(`CREATE TABLE t_comp (id INTEGER PRIMARY KEY, a TEXT, b INTEGER, UNIQUE(a, b)) USING store`);
			await db.exec(`INSERT INTO t_comp VALUES (1, 'x', 1)`);

			let err: Error | null = null;
			try {
				await db.exec(`INSERT INTO t_comp VALUES (2, 'x', 1)`);
			} catch (e) { err = e as Error; }
			expect(err?.message.toLowerCase()).to.include('unique constraint');

			await db.exec(`INSERT INTO t_comp VALUES (3, 'x', 2)`);
			const cnt = await db.get(`SELECT count(*) as cnt FROM t_comp`);
			expect(cnt?.cnt).to.equal(2);
		});

		it('ON CONFLICT DO NOTHING skips insert when PK exists in underlying', async () => {
			await db.exec(`CREATE TABLE t_upq (id INTEGER PRIMARY KEY, val TEXT) USING store`);
			await db.exec(`INSERT INTO t_upq VALUES (1, 'original')`);
			await db.exec(`INSERT INTO t_upq (id, val) VALUES (1, 'new') ON CONFLICT DO NOTHING`);

			const row = await db.get(`SELECT val FROM t_upq WHERE id = 1`);
			expect(row?.val).to.equal('original');
		});

		it('ON CONFLICT DO UPDATE updates row when PK exists in underlying', async () => {
			await db.exec(`CREATE TABLE t_upu (id INTEGER PRIMARY KEY, val TEXT) USING store`);
			await db.exec(`INSERT INTO t_upu VALUES (1, 'original')`);
			await db.exec(`INSERT INTO t_upu (id, val) VALUES (1, 'updated') ON CONFLICT DO UPDATE SET val = NEW.val`);

			const row = await db.get(`SELECT val FROM t_upu WHERE id = 1`);
			expect(row?.val).to.equal('updated');
		});
	});

	describe('failed-commit rollback', () => {
		beforeEach(async () => {
			const isolatedModule = createIsolatedStoreModule({ provider });
			db.registerModule('store', isolatedModule);
			await db.exec(`
				CREATE TABLE accounts (
					id INTEGER PRIMARY KEY,
					balance INTEGER
				) USING store
			`);
			await db.exec(`INSERT INTO accounts VALUES (1, 100)`);
			await db.exec(`CREATE ASSERTION positive_balance CHECK (NOT EXISTS (SELECT 1 FROM accounts WHERE balance < 0))`);
		});

		it('discards staged writes when a deferred assertion rejects the commit', async () => {
			await db.exec('BEGIN');
			await db.exec(`UPDATE accounts SET balance = -50 WHERE id = 1`);

			// The violating row is visible within the transaction
			const inTxn = await db.get('SELECT balance FROM accounts WHERE id = 1');
			expect(inTxn?.balance).to.equal(-50);

			// COMMIT should fail because the assertion evaluates the pending state
			let commitError: Error | null = null;
			try {
				await db.exec('COMMIT');
			} catch (err) {
				commitError = err as Error;
			}
			expect(commitError, 'expected COMMIT to throw for deferred assertion violation').to.not.be.null;

			// Underlying KV must retain the pre-transaction value
			const afterFailedCommit = await db.get('SELECT balance FROM accounts WHERE id = 1');
			expect(afterFailedCommit?.balance).to.equal(100);
		});
	});
});
