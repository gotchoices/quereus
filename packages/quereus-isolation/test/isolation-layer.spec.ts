import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, MemoryTableModule, asyncIterableToArray, getModuleConcurrencyMode } from '@quereus/quereus';
import type { VtabConcurrencyMode, FilterInfo, VirtualTableModule, BaseModuleConfig, DatabaseInternal, Row, SqlValue, VirtualTableConnection } from '@quereus/quereus';
import { IsolationModule, IsolatedTable } from '../src/index.js';

describe('IsolationModule', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	describe('module creation', () => {
		it('creates isolation module wrapping memory module', () => {
			const memoryModule = new MemoryTableModule();
			const isolatedModule = new IsolationModule({
				underlying: memoryModule,
			});

			expect(isolatedModule).to.be.instanceOf(IsolationModule);
		});

		it('reports correct capabilities', () => {
			const memoryModule = new MemoryTableModule();
			const isolatedModule = new IsolationModule({
				underlying: memoryModule,
			});

			const caps = isolatedModule.getCapabilities();
			expect(caps.isolation).to.be.true;
			expect(caps.savepoints).to.be.true;
		});
	});

	describe('table creation', () => {
		it('creates isolated table via CREATE TABLE', async () => {
			const memoryModule = new MemoryTableModule();
			const isolatedModule = new IsolationModule({
				underlying: memoryModule,
			});

			db.registerModule('isolated', isolatedModule);

			await db.exec(`
				CREATE TABLE test (
					id INTEGER PRIMARY KEY,
					name TEXT
				) USING isolated
			`);

			// Table should exist - use schema() function to check
			const result = await db.get(`SELECT name FROM schema() WHERE type = 'table' AND name = 'test'`);
			expect(result?.name).to.equal('test');
		});

		it('creates isolated table with custom tombstone column', async () => {
			const memoryModule = new MemoryTableModule();
			const isolatedModule = new IsolationModule({
				underlying: memoryModule,
				tombstoneColumn: '_deleted',
			});

			db.registerModule('isolated', isolatedModule);

			await db.exec(`
				CREATE TABLE test (
					id INTEGER PRIMARY KEY,
					value TEXT
				) USING isolated
			`);

			// Table should exist - use schema() function to check
			const result = await db.get(`SELECT name FROM schema() WHERE type = 'table' AND name = 'test'`);
			expect(result?.name).to.equal('test');
		});
	});

	describe('transaction lifecycle', () => {
		let isolatedModule: IsolationModule;

		beforeEach(() => {
			const memoryModule = new MemoryTableModule();
			isolatedModule = new IsolationModule({
				underlying: memoryModule,
			});
			db.registerModule('isolated', isolatedModule);
		});

		it('supports begin/commit', async () => {
			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY) USING isolated`);

			await db.exec('BEGIN');
			await db.exec('INSERT INTO test VALUES (1)');
			await db.exec('COMMIT');

			const result = await db.get('SELECT * FROM test WHERE id = 1');
			expect(result?.id).to.equal(1);
		});

		it('supports read-your-own-writes within transaction', async () => {
			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);

			await db.exec('BEGIN');
			await db.exec(`INSERT INTO test VALUES (1, 'Alice')`);

			// Should see uncommitted write
			const result = await db.get('SELECT * FROM test WHERE id = 1');
			expect(result?.name).to.equal('Alice');

			await db.exec('COMMIT');
		});

		it('supports rollback', async () => {
			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY) USING isolated`);

			// Insert and commit one row
			await db.exec('INSERT INTO test VALUES (1)');

			// Start new transaction, insert another row, then rollback
			await db.exec('BEGIN');
			await db.exec('INSERT INTO test VALUES (2)');
			await db.exec('ROLLBACK');

			// Should only see the first row
			const all = await asyncIterableToArray(db.eval('SELECT * FROM test ORDER BY id'));
			expect(all.length).to.equal(1);
			expect(all[0].id).to.equal(1);
		});

		// Note: These tests verify the transaction lifecycle wiring is in place.
		// The underlying memory module already provides isolation, so these tests
		// pass through to it. Phase 4 will implement overlay-based isolation.

		// Note: Full transaction isolation tests will be added in Phase 4.
		// The current stub implementation delegates to the underlying module,
		// which already has its own isolation. These tests verify the wiring
		// is in place for transaction lifecycle methods.
	});

	describe('isolated table internals', () => {
		it('exposes underlying and overlay tables for testing', async () => {
			const memoryModule = new MemoryTableModule();
			const isolatedModule = new IsolationModule({
				underlying: memoryModule,
			});
			db.registerModule('isolated', isolatedModule);

			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY) USING isolated`);

			// Get the table instance
			const table = db.schemaManager.getTable('main', 'test');
			expect(table).to.exist;
		});
	});

	describe('basic operations pass through', () => {
		it('supports INSERT and SELECT', async () => {
			const memoryModule = new MemoryTableModule();
			const isolatedModule = new IsolationModule({
				underlying: memoryModule,
			});
			db.registerModule('isolated', isolatedModule);

			await db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);
			await db.exec(`INSERT INTO users VALUES (1, 'Alice')`);
			await db.exec(`INSERT INTO users VALUES (2, 'Bob')`);

			const all = await asyncIterableToArray(db.eval('SELECT * FROM users ORDER BY id'));
			expect(all.length).to.equal(2);
			expect(all[0].name).to.equal('Alice');
			expect(all[1].name).to.equal('Bob');
		});

		it('supports UPDATE', async () => {
			const memoryModule = new MemoryTableModule();
			const isolatedModule = new IsolationModule({
				underlying: memoryModule,
			});
			db.registerModule('isolated', isolatedModule);

			await db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);
			await db.exec(`INSERT INTO users VALUES (1, 'Alice')`);
			await db.exec(`UPDATE users SET name = 'Alicia' WHERE id = 1`);

			const result = await db.get('SELECT name FROM users WHERE id = 1');
			expect(result?.name).to.equal('Alicia');
		});

		it('supports DELETE', async () => {
			const memoryModule = new MemoryTableModule();
			const isolatedModule = new IsolationModule({
				underlying: memoryModule,
			});
			db.registerModule('isolated', isolatedModule);

			await db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);
			await db.exec(`INSERT INTO users VALUES (1, 'Alice')`);
			await db.exec(`DELETE FROM users WHERE id = 1`);

			const result = await db.get('SELECT * FROM users WHERE id = 1');
			expect(result).to.be.undefined;
		});
	});

	describe('secondary index scans', () => {
		let isolatedModule: IsolationModule;

		beforeEach(() => {
			const memoryModule = new MemoryTableModule();
			isolatedModule = new IsolationModule({
				underlying: memoryModule,
			});
			db.registerModule('isolated', isolatedModule);
		});

		it('sees uncommitted inserts via secondary index query', async () => {
			await db.exec(`
				CREATE TABLE users (
					id INTEGER PRIMARY KEY,
					email TEXT,
					name TEXT
				) USING isolated
			`);
			await db.exec(`CREATE INDEX idx_email ON users(email)`);

			// Commit some initial data
			await db.exec(`INSERT INTO users VALUES (1, 'alice@example.com', 'Alice')`);

			// Start transaction and insert new row
			await db.exec('BEGIN');
			await db.exec(`INSERT INTO users VALUES (2, 'bob@example.com', 'Bob')`);

			// Query by secondary index should see uncommitted insert
			const result = await db.get(`SELECT * FROM users WHERE email = 'bob@example.com'`);
			expect(result?.name).to.equal('Bob');

			await db.exec('ROLLBACK');

			// After rollback, should not see the insert
			const afterRollback = await db.get(`SELECT * FROM users WHERE email = 'bob@example.com'`);
			expect(afterRollback).to.be.undefined;
		});

		it('filters out tombstoned rows via secondary index query', async () => {
			await db.exec(`
				CREATE TABLE users (
					id INTEGER PRIMARY KEY,
					email TEXT,
					name TEXT
				) USING isolated
			`);
			await db.exec(`CREATE INDEX idx_email ON users(email)`);

			// Commit initial data
			await db.exec(`INSERT INTO users VALUES (1, 'alice@example.com', 'Alice')`);
			await db.exec(`INSERT INTO users VALUES (2, 'bob@example.com', 'Bob')`);

			// Start transaction and delete via PK
			await db.exec('BEGIN');
			await db.exec(`DELETE FROM users WHERE id = 1`);

			// Query by secondary index should NOT see deleted row
			const aliceResult = await db.get(`SELECT * FROM users WHERE email = 'alice@example.com'`);
			expect(aliceResult).to.be.undefined;

			// Bob should still be visible
			const bobResult = await db.get(`SELECT * FROM users WHERE email = 'bob@example.com'`);
			expect(bobResult?.name).to.equal('Bob');

			await db.exec('ROLLBACK');

			// After rollback, Alice should be back
			const afterRollback = await db.get(`SELECT * FROM users WHERE email = 'alice@example.com'`);
			expect(afterRollback?.name).to.equal('Alice');
		});

		it('returns updated rows from overlay via secondary index query', async () => {
			await db.exec(`
				CREATE TABLE users (
					id INTEGER PRIMARY KEY,
					email TEXT,
					name TEXT
				) USING isolated
			`);
			await db.exec(`CREATE INDEX idx_email ON users(email)`);

			// Commit initial data
			await db.exec(`INSERT INTO users VALUES (1, 'alice@example.com', 'Alice')`);

			// Start transaction and update
			await db.exec('BEGIN');
			await db.exec(`UPDATE users SET name = 'Alicia' WHERE id = 1`);

			// Query by secondary index should see updated value
			const result = await db.get(`SELECT * FROM users WHERE email = 'alice@example.com'`);
			expect(result?.name).to.equal('Alicia');

			await db.exec('ROLLBACK');

			// After rollback, should see original value
			const afterRollback = await db.get(`SELECT * FROM users WHERE email = 'alice@example.com'`);
			expect(afterRollback?.name).to.equal('Alice');
		});

		it('handles multiple rows with same index key', async () => {
			await db.exec(`
				CREATE TABLE users (
					id INTEGER PRIMARY KEY,
					department TEXT,
					name TEXT
				) USING isolated
			`);
			await db.exec(`CREATE INDEX idx_dept ON users(department)`);

			// Commit initial data - multiple rows with same department
			await db.exec(`INSERT INTO users VALUES (1, 'engineering', 'Alice')`);
			await db.exec(`INSERT INTO users VALUES (2, 'engineering', 'Bob')`);
			await db.exec(`INSERT INTO users VALUES (3, 'sales', 'Charlie')`);

			// Start transaction
			await db.exec('BEGIN');

			// Insert another engineering row
			await db.exec(`INSERT INTO users VALUES (4, 'engineering', 'Diana')`);

			// Delete one existing engineering row
			await db.exec(`DELETE FROM users WHERE id = 1`);

			// Query by department should show correct rows
			const engineering = await asyncIterableToArray(
				db.eval(`SELECT * FROM users WHERE department = 'engineering' ORDER BY id`)
			);
			expect(engineering.length).to.equal(2);
			expect(engineering.map(r => r.name)).to.deep.equal(['Bob', 'Diana']);

			// Sales should be unaffected
			const sales = await asyncIterableToArray(
				db.eval(`SELECT * FROM users WHERE department = 'sales'`)
			);
			expect(sales.length).to.equal(1);
			expect(sales[0].name).to.equal('Charlie');

			await db.exec('ROLLBACK');

			// After rollback, original state restored
			const afterRollback = await asyncIterableToArray(
				db.eval(`SELECT * FROM users WHERE department = 'engineering' ORDER BY id`)
			);
			expect(afterRollback.length).to.equal(2);
			expect(afterRollback.map(r => r.name)).to.deep.equal(['Alice', 'Bob']);
		});

		it('handles range scans on secondary index with overlay changes', async () => {
			await db.exec(`
				CREATE TABLE products (
					id INTEGER PRIMARY KEY,
					price INTEGER,
					name TEXT
				) USING isolated
			`);
			await db.exec(`CREATE INDEX idx_price ON products(price)`);

			// Commit initial data
			await db.exec(`INSERT INTO products VALUES (1, 10, 'Cheap')`);
			await db.exec(`INSERT INTO products VALUES (2, 50, 'Medium')`);
			await db.exec(`INSERT INTO products VALUES (3, 100, 'Expensive')`);

			// Start transaction
			await db.exec('BEGIN');

			// Add a product in the range
			await db.exec(`INSERT INTO products VALUES (4, 30, 'Budget')`);

			// Update a product to be outside the range
			await db.exec(`UPDATE products SET price = 200 WHERE id = 2`);

			// Range query should reflect changes
			const affordable = await asyncIterableToArray(
				db.eval(`SELECT * FROM products WHERE price <= 50 ORDER BY price`)
			);

			// Should have: Cheap(10), Budget(30) - Medium(50) was updated to 200
			expect(affordable.length).to.equal(2);
			expect(affordable.map(r => r.name)).to.deep.equal(['Cheap', 'Budget']);

			await db.exec('ROLLBACK');
		});

		it('handles update that changes index key value', async () => {
			await db.exec(`
				CREATE TABLE users (
					id INTEGER PRIMARY KEY,
					email TEXT,
					name TEXT
				) USING isolated
			`);
			await db.exec(`CREATE INDEX idx_email ON users(email)`);

			// Commit initial data
			await db.exec(`INSERT INTO users VALUES (1, 'old@example.com', 'Alice')`);

			// Start transaction and update email
			await db.exec('BEGIN');
			await db.exec(`UPDATE users SET email = 'new@example.com' WHERE id = 1`);

			// Query with old email should find nothing
			const oldEmail = await db.get(`SELECT * FROM users WHERE email = 'old@example.com'`);
			expect(oldEmail).to.be.undefined;

			// Query with new email should find the row
			const newEmail = await db.get(`SELECT * FROM users WHERE email = 'new@example.com'`);
			expect(newEmail?.name).to.equal('Alice');

			await db.exec('COMMIT');

			// After commit, changes should be permanent
			const afterCommit = await db.get(`SELECT * FROM users WHERE email = 'new@example.com'`);
			expect(afterCommit?.name).to.equal('Alice');
		});
	});

	describe('per-connection isolation', () => {
		it('separate SQL statements share the same overlay within a transaction', async () => {
			// This test verifies the fix for the original architecture flaw where
			// each SQL statement got a fresh IsolatedTable instance via connect(),
			// and without per-connection overlay storage, the INSERT's overlay
			// wouldn't be visible to the subsequent SELECT.
			const memoryModule = new MemoryTableModule();
			const isolatedModule = new IsolationModule({
				underlying: memoryModule,
			});
			db.registerModule('isolated', isolatedModule);

			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);

			// Start a transaction
			await db.exec('BEGIN');

			// Each of these statements creates a new IsolatedTable via module.connect()
			// The overlay must be shared across all of them for read-your-own-writes to work
			await db.exec(`INSERT INTO test VALUES (1, 'First')`);  // Statement 1 - creates overlay
			await db.exec(`INSERT INTO test VALUES (2, 'Second')`); // Statement 2 - must use same overlay

			// Statement 3 - SELECT must see both inserts from the shared overlay
			const row1 = await db.get(`SELECT * FROM test WHERE id = 1`);
			const row2 = await db.get(`SELECT * FROM test WHERE id = 2`);

			expect(row1?.name).to.equal('First');
			expect(row2?.name).to.equal('Second');

			// Statement 4 - UPDATE must find the row in the shared overlay
			await db.exec(`UPDATE test SET name = 'Updated' WHERE id = 1`);

			// Statement 5 - SELECT must see the update from the shared overlay
			const updated = await db.get(`SELECT * FROM test WHERE id = 1`);
			expect(updated?.name).to.equal('Updated');

			// Statement 6 - DELETE must find the row in the shared overlay
			await db.exec(`DELETE FROM test WHERE id = 2`);

			// Statement 7 - SELECT must see the deletion (row gone)
			const deleted = await db.get(`SELECT * FROM test WHERE id = 2`);
			expect(deleted).to.be.undefined;

			// Verify final state before commit
			const all = await asyncIterableToArray(db.eval(`SELECT * FROM test ORDER BY id`));
			expect(all.length).to.equal(1);
			expect(all[0].name).to.equal('Updated');

			await db.exec('COMMIT');

			// After commit, changes should be in underlying
			const afterCommit = await asyncIterableToArray(db.eval(`SELECT * FROM test ORDER BY id`));
			expect(afterCommit.length).to.equal(1);
			expect(afterCommit[0].name).to.equal('Updated');
		});

		it('overlay is created lazily on first write', async () => {
			const memoryModule = new MemoryTableModule();
			const isolatedModule = new IsolationModule({
				underlying: memoryModule,
			});
			db.registerModule('isolated', isolatedModule);

			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);

			// Before any writes, overlay should not exist
			// (We can't easily test this directly, but we can verify reads work without overlay)
			const emptyResult = await asyncIterableToArray(db.eval(`SELECT * FROM test`));
			expect(emptyResult).to.deep.equal([]);

			// After write, overlay is created
			await db.exec('BEGIN');
			await db.exec(`INSERT INTO test VALUES (1, 'First')`);

			// Read should work and see uncommitted data
			const result = await db.get(`SELECT * FROM test WHERE id = 1`);
			expect(result?.name).to.equal('First');

			await db.exec('COMMIT');
		});

		it('overlay persists across multiple queries in same transaction', async () => {
			const memoryModule = new MemoryTableModule();
			const isolatedModule = new IsolationModule({
				underlying: memoryModule,
			});
			db.registerModule('isolated', isolatedModule);

			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY, value INTEGER) USING isolated`);

			await db.exec('BEGIN');

			// Multiple inserts
			await db.exec(`INSERT INTO test VALUES (1, 100)`);
			await db.exec(`INSERT INTO test VALUES (2, 200)`);
			await db.exec(`INSERT INTO test VALUES (3, 300)`);

			// Multiple reads should all see uncommitted data
			const r1 = await db.get(`SELECT * FROM test WHERE id = 1`);
			const r2 = await db.get(`SELECT * FROM test WHERE id = 2`);
			const r3 = await db.get(`SELECT * FROM test WHERE id = 3`);

			expect(r1?.value).to.equal(100);
			expect(r2?.value).to.equal(200);
			expect(r3?.value).to.equal(300);

			// Update should work on uncommitted data
			await db.exec(`UPDATE test SET value = 999 WHERE id = 2`);
			const r2Updated = await db.get(`SELECT * FROM test WHERE id = 2`);
			expect(r2Updated?.value).to.equal(999);

			await db.exec('COMMIT');

			// After commit, all changes should be permanent
			const all = await asyncIterableToArray(db.eval(`SELECT * FROM test ORDER BY id`));
			expect(all.length).to.equal(3);
			expect(all[1].value).to.equal(999);
		});

		it('overlay is cleared after rollback', async () => {
			const memoryModule = new MemoryTableModule();
			const isolatedModule = new IsolationModule({
				underlying: memoryModule,
			});
			db.registerModule('isolated', isolatedModule);

			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY) USING isolated`);

			// Commit some initial data
			await db.exec(`INSERT INTO test VALUES (1)`);

			// Start transaction and insert more
			await db.exec('BEGIN');
			await db.exec(`INSERT INTO test VALUES (2)`);
			await db.exec(`INSERT INTO test VALUES (3)`);

			// Should see all 3 rows
			const beforeRollback = await asyncIterableToArray(db.eval(`SELECT * FROM test ORDER BY id`));
			expect(beforeRollback.length).to.equal(3);

			// Rollback
			await db.exec('ROLLBACK');

			// Should only see committed row
			const afterRollback = await asyncIterableToArray(db.eval(`SELECT * FROM test ORDER BY id`));
			expect(afterRollback.length).to.equal(1);
			expect(afterRollback[0].id).to.equal(1);

			// Start a new transaction - overlay should be fresh
			await db.exec('BEGIN');
			await db.exec(`INSERT INTO test VALUES (4)`);

			const newTx = await asyncIterableToArray(db.eval(`SELECT * FROM test ORDER BY id`));
			expect(newTx.length).to.equal(2);
			expect(newTx.map((r: any) => r.id)).to.deep.equal([1, 4]);

			await db.exec('COMMIT');
		});

		it('overlay is cleared after commit', async () => {
			const memoryModule = new MemoryTableModule();
			const isolatedModule = new IsolationModule({
				underlying: memoryModule,
			});
			db.registerModule('isolated', isolatedModule);

			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY) USING isolated`);

			// First transaction
			await db.exec('BEGIN');
			await db.exec(`INSERT INTO test VALUES (1)`);
			await db.exec('COMMIT');

			// Second transaction - should start fresh
			await db.exec('BEGIN');
			await db.exec(`INSERT INTO test VALUES (2)`);

			// Should see both committed and uncommitted
			const duringTx = await asyncIterableToArray(db.eval(`SELECT * FROM test ORDER BY id`));
			expect(duringTx.length).to.equal(2);

			await db.exec('ROLLBACK');

			// After rollback, should only see first committed row
			const afterRollback = await asyncIterableToArray(db.eval(`SELECT * FROM test ORDER BY id`));
			expect(afterRollback.length).to.equal(1);
			expect(afterRollback[0].id).to.equal(1);
		});
	});

	describe('savepoints', () => {
		let isolatedModule: IsolationModule;

		beforeEach(() => {
			const memoryModule = new MemoryTableModule();
			isolatedModule = new IsolationModule({
				underlying: memoryModule,
			});
			db.registerModule('isolated', isolatedModule);
		});

		it('savepoint + release preserves changes', async () => {
			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);
			await db.exec('BEGIN');
			await db.exec(`INSERT INTO test VALUES (1, 'before')`);
			await db.exec('SAVEPOINT sp1');
			await db.exec(`INSERT INTO test VALUES (2, 'in savepoint')`);
			await db.exec('RELEASE SAVEPOINT sp1');

			// Both rows visible after release
			const rows = await asyncIterableToArray(db.eval('SELECT * FROM test ORDER BY id'));
			expect(rows.length).to.equal(2);
			expect(rows[0].name).to.equal('before');
			expect(rows[1].name).to.equal('in savepoint');

			await db.exec('COMMIT');

			// Both rows committed
			const committed = await asyncIterableToArray(db.eval('SELECT * FROM test ORDER BY id'));
			expect(committed.length).to.equal(2);
		});

		it('rollback to savepoint discards changes after savepoint', async () => {
			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);
			await db.exec('BEGIN');
			await db.exec(`INSERT INTO test VALUES (1, 'keeper')`);
			await db.exec('SAVEPOINT sp1');
			await db.exec(`INSERT INTO test VALUES (2, 'discard')`);
			await db.exec(`INSERT INTO test VALUES (3, 'also discard')`);
			await db.exec('ROLLBACK TO SAVEPOINT sp1');

			// Only the row before savepoint should remain
			const rows = await asyncIterableToArray(db.eval('SELECT * FROM test ORDER BY id'));
			expect(rows.length).to.equal(1);
			expect(rows[0].name).to.equal('keeper');

			await db.exec('COMMIT');

			const committed = await asyncIterableToArray(db.eval('SELECT * FROM test ORDER BY id'));
			expect(committed.length).to.equal(1);
			expect(committed[0].id).to.equal(1);
		});

		it('nested savepoints rollback independently', async () => {
			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY, value INTEGER) USING isolated`);
			await db.exec('BEGIN');
			await db.exec('INSERT INTO test VALUES (1, 100)');
			await db.exec('SAVEPOINT sp_outer');
			await db.exec('INSERT INTO test VALUES (2, 200)');
			await db.exec('SAVEPOINT sp_inner');
			await db.exec('INSERT INTO test VALUES (3, 300)');

			// All three visible
			let rows = await asyncIterableToArray(db.eval('SELECT * FROM test ORDER BY id'));
			expect(rows.length).to.equal(3);

			// Rollback inner savepoint - row 3 gone
			await db.exec('ROLLBACK TO SAVEPOINT sp_inner');
			rows = await asyncIterableToArray(db.eval('SELECT * FROM test ORDER BY id'));
			expect(rows.length).to.equal(2);
			expect(rows.map((r: any) => r.id)).to.deep.equal([1, 2]);

			// Rollback outer savepoint - row 2 also gone
			await db.exec('ROLLBACK TO SAVEPOINT sp_outer');
			rows = await asyncIterableToArray(db.eval('SELECT * FROM test ORDER BY id'));
			expect(rows.length).to.equal(1);
			expect(rows[0].id).to.equal(1);

			await db.exec('COMMIT');
			const committed = await asyncIterableToArray(db.eval('SELECT * FROM test ORDER BY id'));
			expect(committed.length).to.equal(1);
		});

		it('savepoint rollback then continue adding data', async () => {
			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);
			await db.exec('BEGIN');
			await db.exec(`INSERT INTO test VALUES (1, 'stays')`);
			await db.exec('SAVEPOINT sp1');
			await db.exec(`INSERT INTO test VALUES (2, 'gone')`);
			await db.exec('ROLLBACK TO SAVEPOINT sp1');

			// Can insert new data after rollback to savepoint
			await db.exec(`INSERT INTO test VALUES (3, 'new after rollback')`);

			const rows = await asyncIterableToArray(db.eval('SELECT * FROM test ORDER BY id'));
			expect(rows.length).to.equal(2);
			expect(rows.map((r: any) => r.id)).to.deep.equal([1, 3]);

			await db.exec('COMMIT');
			const committed = await asyncIterableToArray(db.eval('SELECT * FROM test ORDER BY id'));
			expect(committed.length).to.equal(2);
		});

		it('savepoint with update and delete operations', async () => {
			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);
			await db.exec(`INSERT INTO test VALUES (1, 'Alice')`);
			await db.exec(`INSERT INTO test VALUES (2, 'Bob')`);

			await db.exec('BEGIN');
			await db.exec('SAVEPOINT sp1');
			await db.exec(`UPDATE test SET name = 'ALICE' WHERE id = 1`);
			await db.exec(`DELETE FROM test WHERE id = 2`);

			// Verify changes visible
			let rows = await asyncIterableToArray(db.eval('SELECT * FROM test ORDER BY id'));
			expect(rows.length).to.equal(1);
			expect(rows[0].name).to.equal('ALICE');

			// Rollback savepoint restores original
			await db.exec('ROLLBACK TO SAVEPOINT sp1');
			rows = await asyncIterableToArray(db.eval('SELECT * FROM test ORDER BY id'));
			expect(rows.length).to.equal(2);
			expect(rows[0].name).to.equal('Alice');
			expect(rows[1].name).to.equal('Bob');

			await db.exec('COMMIT');
		});

		it('pre-overlay savepoint: rollback to savepoint created before first write clears overlay', async () => {
			// sp1 is created before any write in this transaction (so before the overlay exists).
			// After the INSERT creates the overlay, ROLLBACK TO sp1 must wipe the overlay entirely.
			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);
			await db.exec(`INSERT INTO test VALUES (1, 'committed')`);

			await db.exec('BEGIN');
			await db.exec('SAVEPOINT sp1');      // sp1 pre-dates the overlay
			await db.exec(`INSERT INTO test VALUES (2, 'will-vanish')`); // creates overlay
			await db.exec('ROLLBACK TO SAVEPOINT sp1');

			// Overlay should be wiped — only the pre-transaction committed row is visible
			const rows = await asyncIterableToArray(db.eval('SELECT * FROM test ORDER BY id'));
			expect(rows.length).to.equal(1);
			expect(rows[0].id).to.equal(1);

			await db.exec('ROLLBACK');

			// Underlying unchanged
			const afterRollback = await asyncIterableToArray(db.eval('SELECT * FROM test'));
			expect(afterRollback.length).to.equal(1);
			expect(afterRollback[0].id).to.equal(1);
		});

		it('savepoint before any access: rollback to savepoint undoes lazy-registered connection writes', async () => {
			// IsolatedConnection is registered lazily on first read/write. When
			// SAVEPOINT runs before any access to the table, the connection does
			// not yet exist, so the DB's savepoint broadcast skips it. The first
			// INSERT then registers the connection — which must inherit the
			// active savepoint stack so a subsequent ROLLBACK TO targets a real
			// entry, not an out-of-range index.
			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);

			await db.exec('BEGIN');
			await db.exec('SAVEPOINT sp');                                // no IsolatedConnection registered yet
			await db.exec(`INSERT INTO test VALUES (1, 'will-vanish')`); // registers connection NOW
			await db.exec('ROLLBACK TO SAVEPOINT sp');

			const rows = await asyncIterableToArray(db.eval('SELECT * FROM test'));
			expect(rows.length).to.equal(0);

			await db.exec('ROLLBACK');
		});

		it('mixed pre/post-overlay savepoints: rollback to post-overlay sp2 keeps first write, rollback to pre-overlay sp1 wipes all', async () => {
			// sp1 is pre-overlay, sp2 is post-overlay (created after first INSERT).
			// ROLLBACK TO sp2 should keep the INSERT before sp2.
			// ROLLBACK TO sp1 should then wipe everything from the transaction.
			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);
			await db.exec(`INSERT INTO test VALUES (1, 'committed')`);

			await db.exec('BEGIN');
			await db.exec('SAVEPOINT sp1');                               // sp1 pre-overlay
			await db.exec(`INSERT INTO test VALUES (2, 'after-sp1')`);   // creates overlay
			await db.exec('SAVEPOINT sp2');                               // sp2 post-overlay
			await db.exec(`INSERT INTO test VALUES (3, 'after-sp2')`);

			// ROLLBACK TO sp2: undo INSERT (3), keep INSERT (2)
			await db.exec('ROLLBACK TO SAVEPOINT sp2');
			let rows = await asyncIterableToArray(db.eval('SELECT * FROM test ORDER BY id'));
			expect(rows.map((r: any) => r.id)).to.deep.equal([1, 2]);

			// ROLLBACK TO sp1: wipe entire overlay (sp1 pre-dates the overlay)
			await db.exec('ROLLBACK TO SAVEPOINT sp1');
			rows = await asyncIterableToArray(db.eval('SELECT * FROM test ORDER BY id'));
			expect(rows.map((r: any) => r.id)).to.deep.equal([1]);

			await db.exec('COMMIT');

			// Only the pre-transaction row survives
			const afterCommit = await asyncIterableToArray(db.eval('SELECT * FROM test'));
			expect(afterCommit.length).to.equal(1);
			expect(afterCommit[0].id).to.equal(1);
		});
	});

	describe('compound primary keys', () => {
		let isolatedModule: IsolationModule;

		beforeEach(() => {
			const memoryModule = new MemoryTableModule();
			isolatedModule = new IsolationModule({
				underlying: memoryModule,
			});
			db.registerModule('isolated', isolatedModule);
		});

		it('supports CRUD with composite primary keys', async () => {
			await db.exec(`
				CREATE TABLE orders (
					customer_id INTEGER,
					order_id INTEGER,
					amount REAL,
					PRIMARY KEY (customer_id, order_id)
				) USING isolated
			`);

			// Insert
			await db.exec(`INSERT INTO orders VALUES (1, 100, 9.99)`);
			await db.exec(`INSERT INTO orders VALUES (1, 101, 19.99)`);
			await db.exec(`INSERT INTO orders VALUES (2, 100, 5.00)`);

			// Read
			const all = await asyncIterableToArray(
				db.eval('SELECT * FROM orders ORDER BY customer_id, order_id')
			);
			expect(all.length).to.equal(3);

			// Update
			await db.exec('UPDATE orders SET amount = 14.99 WHERE customer_id = 1 AND order_id = 100');
			const updated = await db.get('SELECT amount FROM orders WHERE customer_id = 1 AND order_id = 100');
			expect(updated?.amount).to.equal(14.99);

			// Delete
			await db.exec('DELETE FROM orders WHERE customer_id = 2 AND order_id = 100');
			const afterDelete = await asyncIterableToArray(
				db.eval('SELECT * FROM orders ORDER BY customer_id, order_id')
			);
			expect(afterDelete.length).to.equal(2);
		});

		it('composite PK isolation within transaction', async () => {
			await db.exec(`
				CREATE TABLE kv (
					ns TEXT,
					key TEXT,
					value TEXT,
					PRIMARY KEY (ns, key)
				) USING isolated
			`);

			await db.exec(`INSERT INTO kv VALUES ('a', 'k1', 'original')`);

			await db.exec('BEGIN');
			await db.exec(`INSERT INTO kv VALUES ('a', 'k2', 'new')`);
			await db.exec(`UPDATE kv SET value = 'modified' WHERE ns = 'a' AND key = 'k1'`);

			// Read-your-own-writes
			const rows = await asyncIterableToArray(
				db.eval(`SELECT * FROM kv WHERE ns = 'a' ORDER BY key`)
			);
			expect(rows.length).to.equal(2);
			expect(rows[0].value).to.equal('modified');
			expect(rows[1].value).to.equal('new');

			await db.exec('ROLLBACK');

			// After rollback, only original data
			const afterRollback = await asyncIterableToArray(
				db.eval(`SELECT * FROM kv ORDER BY ns, key`)
			);
			expect(afterRollback.length).to.equal(1);
			expect(afterRollback[0].value).to.equal('original');
		});
	});

	describe('transaction edge cases', () => {
		let isolatedModule: IsolationModule;

		beforeEach(() => {
			const memoryModule = new MemoryTableModule();
			isolatedModule = new IsolationModule({
				underlying: memoryModule,
			});
			db.registerModule('isolated', isolatedModule);
		});

		it('empty transaction commits successfully', async () => {
			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY) USING isolated`);
			await db.exec('INSERT INTO test VALUES (1)');

			await db.exec('BEGIN');
			// No writes
			await db.exec('COMMIT');

			// Data unchanged
			const rows = await asyncIterableToArray(db.eval('SELECT * FROM test'));
			expect(rows.length).to.equal(1);
		});

		it('empty transaction rolls back successfully', async () => {
			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY) USING isolated`);
			await db.exec('INSERT INTO test VALUES (1)');

			await db.exec('BEGIN');
			// No writes
			await db.exec('ROLLBACK');

			// Data unchanged
			const rows = await asyncIterableToArray(db.eval('SELECT * FROM test'));
			expect(rows.length).to.equal(1);
		});

		it('sequential transactions see each other\'s committed data', async () => {
			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT) USING isolated`);

			// Transaction 1
			await db.exec('BEGIN');
			await db.exec(`INSERT INTO test VALUES (1, 'first')`);
			await db.exec('COMMIT');

			// Transaction 2 sees transaction 1's data
			await db.exec('BEGIN');
			const row = await db.get('SELECT * FROM test WHERE id = 1');
			expect(row?.value).to.equal('first');
			await db.exec(`INSERT INTO test VALUES (2, 'second')`);
			await db.exec('COMMIT');

			// Transaction 3 sees both
			await db.exec('BEGIN');
			const all = await asyncIterableToArray(db.eval('SELECT * FROM test ORDER BY id'));
			expect(all.length).to.equal(2);
			await db.exec('COMMIT');
		});

		it('autocommit statements commit individually', async () => {
			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY) USING isolated`);

			// Each statement is its own implicit transaction
			await db.exec('INSERT INTO test VALUES (1)');
			await db.exec('INSERT INTO test VALUES (2)');
			await db.exec('INSERT INTO test VALUES (3)');

			const rows = await asyncIterableToArray(db.eval('SELECT * FROM test ORDER BY id'));
			expect(rows.length).to.equal(3);
			expect(rows.map((r: any) => r.id)).to.deep.equal([1, 2, 3]);
		});

		it('read-only queries work without overlay', async () => {
			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);
			await db.exec(`INSERT INTO test VALUES (1, 'Alice')`);

			// Multiple reads without any writes in this "transaction"
			const r1 = await db.get('SELECT * FROM test WHERE id = 1');
			expect(r1?.name).to.equal('Alice');

			const count = await db.get('SELECT count(*) as c FROM test');
			expect(count?.c).to.equal(1);
		});

		it('delete-all then re-insert works', async () => {
			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);
			await db.exec(`INSERT INTO test VALUES (1, 'Alice')`);
			await db.exec(`INSERT INTO test VALUES (2, 'Bob')`);

			await db.exec('BEGIN');
			await db.exec('DELETE FROM test WHERE id = 1');
			await db.exec('DELETE FROM test WHERE id = 2');

			// Table empty
			let rows = await asyncIterableToArray(db.eval('SELECT * FROM test'));
			expect(rows.length).to.equal(0);

			// Re-insert with same PK
			await db.exec(`INSERT INTO test VALUES (1, 'Charlie')`);
			rows = await asyncIterableToArray(db.eval('SELECT * FROM test'));
			expect(rows.length).to.equal(1);
			expect(rows[0].name).to.equal('Charlie');

			await db.exec('COMMIT');

			const committed = await asyncIterableToArray(db.eval('SELECT * FROM test ORDER BY id'));
			expect(committed.length).to.equal(1);
			expect(committed[0].name).to.equal('Charlie');
		});

		it('update followed by delete of same row', async () => {
			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);
			await db.exec(`INSERT INTO test VALUES (1, 'Alice')`);

			await db.exec('BEGIN');
			await db.exec(`UPDATE test SET name = 'Updated' WHERE id = 1`);
			await db.exec(`DELETE FROM test WHERE id = 1`);

			const rows = await asyncIterableToArray(db.eval('SELECT * FROM test'));
			expect(rows.length).to.equal(0);

			await db.exec('COMMIT');

			const committed = await asyncIterableToArray(db.eval('SELECT * FROM test'));
			expect(committed.length).to.equal(0);
		});

		it('insert then update same row within transaction', async () => {
			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);

			await db.exec('BEGIN');
			await db.exec(`INSERT INTO test VALUES (1, 'original')`);
			await db.exec(`UPDATE test SET name = 'modified' WHERE id = 1`);

			const row = await db.get('SELECT * FROM test WHERE id = 1');
			expect(row?.name).to.equal('modified');

			await db.exec('COMMIT');

			const committed = await db.get('SELECT * FROM test WHERE id = 1');
			expect(committed?.name).to.equal('modified');
		});
	});

	describe('rename table', () => {
		let isolatedModule: IsolationModule;

		beforeEach(() => {
			const memoryModule = new MemoryTableModule();
			isolatedModule = new IsolationModule({
				underlying: memoryModule,
			});
			db.registerModule('isolated', isolatedModule);
		});

		it('preserves row data through ALTER TABLE RENAME TO', async () => {
			// Regression: IsolationModule did not forward renameTable to the
			// underlying module, so rows committed under the old name were lost
			// when subsequent queries hit a fresh underlying state for the new name.
			await db.exec(`CREATE TABLE t_rename (id INTEGER PRIMARY KEY, val TEXT) USING isolated`);
			await db.exec(`INSERT INTO t_rename VALUES (1, 'a'), (2, 'b')`);
			await db.exec(`ALTER TABLE t_rename RENAME TO t_renamed`);

			const rows = await asyncIterableToArray(db.eval(`SELECT * FROM t_renamed ORDER BY id`));
			expect(rows.length).to.equal(2);
			expect(rows.map((r: any) => [r.id, r.val])).to.deep.equal([[1, 'a'], [2, 'b']]);
		});

		it('allows writes against the renamed table', async () => {
			await db.exec(`CREATE TABLE t_rename (id INTEGER PRIMARY KEY, val TEXT) USING isolated`);
			await db.exec(`INSERT INTO t_rename VALUES (1, 'a')`);
			await db.exec(`ALTER TABLE t_rename RENAME TO t_renamed`);
			await db.exec(`INSERT INTO t_renamed VALUES (2, 'b')`);

			const rows = await asyncIterableToArray(db.eval(`SELECT * FROM t_renamed ORDER BY id`));
			expect(rows.map((r: any) => r.id)).to.deep.equal([1, 2]);
		});
	});

	describe('DROP INDEX forwards through the isolation layer', () => {
		// Regression: SchemaManager.dropIndex only invokes the registered module's
		// dropIndex hook. Without IsolationModule.dropIndex, the underlying
		// module never sees the drop and any synthesized UNIQUE constraint on
		// the IsolatedTable's cached schema keeps firing on subsequent inserts.
		let isolatedModule: IsolationModule;

		beforeEach(() => {
			isolatedModule = new IsolationModule({
				underlying: new MemoryTableModule(),
			});
			db.registerModule('isolated', isolatedModule);
		});

		it('clears the synthesized UNIQUE constraint after DROP UNIQUE INDEX', async () => {
			await db.exec(`CREATE TABLE iso_du (a INTEGER PRIMARY KEY, b INTEGER) USING isolated`);
			await db.exec(`CREATE UNIQUE INDEX iso_du_b ON iso_du (b)`);
			await db.exec(`INSERT INTO iso_du VALUES (1, 100)`);

			let threwBeforeDrop = false;
			try {
				await db.exec(`INSERT INTO iso_du VALUES (2, 100)`);
			} catch (e) {
				threwBeforeDrop = true;
				expect(String(e)).to.match(/unique/i);
			}
			expect(threwBeforeDrop, 'duplicate must violate UNIQUE while the index exists').to.equal(true);

			await db.exec(`DROP INDEX iso_du_b`);
			// After drop the duplicate is allowed — the synthesized UC is gone.
			await db.exec(`INSERT INTO iso_du VALUES (2, 100)`);

			const rows = await asyncIterableToArray(db.eval(`SELECT a, b FROM iso_du ORDER BY a`));
			expect(rows.map((r: any) => [r.a, r.b])).to.deep.equal([[1, 100], [2, 100]]);
		});

		it('clears the synthesized UNIQUE constraint after DROP INDEX inside an active transaction', async () => {
			// Regression: with an open overlay (a write inside BEGIN..COMMIT), the
			// overlay's MemoryTable holds a pending TransactionLayer whose
			// tableSchemaAtCreation captured the synthesized UC. A bare
			// overlay.dropIndex() forward refreshes the manager but not that frozen
			// per-layer schema, so the next overlay write still fires UNIQUE inside
			// MemoryTable.update against `_overlay_<table>_<id>`. The fix rebuilds
			// the overlay against the post-drop schema.
			await db.exec(`CREATE TABLE iso_dut (a INTEGER PRIMARY KEY, b INTEGER) USING isolated`);
			await db.exec(`CREATE UNIQUE INDEX iso_dut_b ON iso_dut (b)`);

			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO iso_dut VALUES (1, 100)`);
			await db.exec(`DROP INDEX iso_dut_b`);
			// Should succeed now — the UC is gone from both the underlying schema
			// and the overlay's effective schema.
			await db.exec(`INSERT INTO iso_dut VALUES (2, 100)`);
			await db.exec(`COMMIT`);

			const rows = await asyncIterableToArray(db.eval(`SELECT a, b FROM iso_dut ORDER BY a`));
			expect(rows.map((r: any) => [r.a, r.b])).to.deep.equal([[1, 100], [2, 100]]);
		});

		it('preserves staged tombstones across DROP INDEX inside an active transaction', async () => {
			// Verifies the overlay rebuild copies tombstone rows verbatim, so a
			// DELETE staged before DROP INDEX still results in the row being
			// removed at COMMIT.
			await db.exec(`CREATE TABLE iso_dtb (a INTEGER PRIMARY KEY, b INTEGER) USING isolated`);
			await db.exec(`INSERT INTO iso_dtb VALUES (1, 100), (2, 200)`);
			await db.exec(`CREATE UNIQUE INDEX iso_dtb_b ON iso_dtb (b)`);

			await db.exec(`BEGIN`);
			await db.exec(`DELETE FROM iso_dtb WHERE a = 1`);
			await db.exec(`DROP INDEX iso_dtb_b`);
			await db.exec(`COMMIT`);

			const rows = await asyncIterableToArray(db.eval(`SELECT a, b FROM iso_dtb ORDER BY a`));
			expect(rows.map((r: any) => [r.a, r.b])).to.deep.equal([[2, 200]]);
		});
	});

	describe('ALTER TABLE ADD COLUMN atomic pre-validation', () => {
		// The isolation layer dry-runs every affected overlay's backfill BEFORE mutating
		// the shared underlying, so a NOT NULL / tombstone rejection leaves the underlying
		// base AND the schema catalog untouched (no base/catalog divergence). The
		// underlying-column-count assertion is the white-box check that the irreversible
		// `underlying.alterTable` never ran: before the fix it would already have appended
		// the new column when the overlay migration later threw.
		let isolatedModule: IsolationModule;

		beforeEach(() => {
			isolatedModule = new IsolationModule({ underlying: new MemoryTableModule() });
			db.registerModule('isolated', isolatedModule);
		});

		/** Pre-alter underlying column count for `main.<table>`. */
		function underlyingColumnCount(table: string): number {
			return isolatedModule.getUnderlyingState('main', table)!.underlyingTable.tableSchema!.columns.length;
		}

		it('rejects atomically when a per-row NOT NULL backfill yields NULL for a staged row', async () => {
			// `x` is explicitly nullable so the staged row can carry NULL; the committed base
			// is empty (the INSERT is staged in the overlay), so the underlying's own backfill
			// would succeed — only the overlay row is un-backfillable. Pre-validation must
			// reject before the underlying is altered.
			await db.exec(`CREATE TABLE t_nn (id INTEGER PRIMARY KEY, x INTEGER NULL) USING isolated`);
			const before = underlyingColumnCount('t_nn'); // id, x

			await db.exec('BEGIN');
			await db.exec(`INSERT INTO t_nn VALUES (1, NULL)`); // stages an overlay row with x = NULL

			let err: Error | null = null;
			try {
				await db.exec(`ALTER TABLE t_nn ADD COLUMN c INTEGER NOT NULL DEFAULT (new.x)`);
			} catch (e) { err = e as Error; }
			expect(err, 'ALTER must throw for a NULL-yielding NOT NULL backfill').to.not.be.null;
			expect(err!.message.toLowerCase()).to.include('not null');

			// White-box: the shared underlying was never mutated (no phantom `c`).
			expect(underlyingColumnCount('t_nn'), 'underlying must be untouched after atomic rejection').to.equal(before);

			await db.exec('ROLLBACK');
		});

		it('succeeds when a staged tombstone would otherwise trip the NOT NULL backfill', async () => {
			// A staged DELETE leaves a tombstone row whose data columns are NULL placeholders.
			// The per-row evaluator must NOT run against it (it would spuriously trip NOT NULL);
			// a sibling staged insert with a satisfiable value confirms the ALTER still applies.
			await db.exec(`CREATE TABLE t_ts (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);
			await db.exec(`INSERT INTO t_ts VALUES (1, 'Alice'), (2, 'Bob')`); // committed

			await db.exec('BEGIN');
			await db.exec(`DELETE FROM t_ts WHERE id = 1`);          // stages a tombstone for id=1
			await db.exec(`INSERT INTO t_ts VALUES (3, 'Carol')`);   // staged insert (new.id = 3, non-null)
			// new.id is non-null for every live row; the tombstone for id=1 must be skipped.
			await db.exec(`ALTER TABLE t_ts ADD COLUMN tag INTEGER NOT NULL DEFAULT (new.id)`);

			const inTxn = await asyncIterableToArray(db.eval('SELECT id, tag FROM t_ts ORDER BY id'));
			expect(inTxn.map((r: any) => [r.id, r.tag])).to.deep.equal([[2, 2], [3, 3]]);

			await db.exec('COMMIT');

			const afterCommit = await asyncIterableToArray(db.eval('SELECT id, tag FROM t_ts ORDER BY id'));
			expect(afterCommit.map((r: any) => [r.id, r.tag])).to.deep.equal([[2, 2], [3, 3]]);
		});

		it('rejects atomically under default_column_nullability=not_null with no explicit NOT NULL', async () => {
			// The added column carries no explicit `not null`, but the session option resolves
			// it NOT NULL. Pre-validation must derive nullability via columnDefToSchema + the
			// option (not from explicit constraints alone) and reject the un-backfillable
			// staged row, atomically.
			db.setOption('default_column_nullability', 'not_null');
			await db.exec(`CREATE TABLE t_opt (id INTEGER PRIMARY KEY, x INTEGER NULL) USING isolated`);
			const before = underlyingColumnCount('t_opt');

			await db.exec('BEGIN');
			await db.exec(`INSERT INTO t_opt VALUES (1, NULL)`);

			let err: Error | null = null;
			try {
				await db.exec(`ALTER TABLE t_opt ADD COLUMN c INTEGER DEFAULT (new.x)`); // implicitly NOT NULL
			} catch (e) { err = e as Error; }
			expect(err, 'ALTER must throw for an implicitly NOT NULL un-backfillable staged row').to.not.be.null;
			expect(err!.message.toLowerCase()).to.include('not null');
			expect(underlyingColumnCount('t_opt'), 'underlying must be untouched after atomic rejection').to.equal(before);

			await db.exec('ROLLBACK');
		});

		it('happy path: satisfiable per-row default backfills staged rows through commit', async () => {
			// Guards the deriveAddColumnBackfill refactor: a satisfiable per-row default over
			// staged inserts must still backfill each staged row from its own sibling value
			// and survive commit (read-your-writes).
			await db.exec(`CREATE TABLE t_hp (id INTEGER PRIMARY KEY, qty INTEGER) USING isolated`);

			await db.exec('BEGIN');
			await db.exec(`INSERT INTO t_hp VALUES (1, 10), (2, 25)`);
			await db.exec(`ALTER TABLE t_hp ADD COLUMN qty2 INTEGER DEFAULT (new.qty * 2)`);

			const inTxn = await asyncIterableToArray(db.eval('SELECT id, qty2 FROM t_hp ORDER BY id'));
			expect(inTxn.map((r: any) => [r.id, r.qty2])).to.deep.equal([[1, 20], [2, 50]]);

			await db.exec('COMMIT');

			const afterCommit = await asyncIterableToArray(db.eval('SELECT id, qty2 FROM t_hp ORDER BY id'));
			expect(afterCommit.map((r: any) => [r.id, r.qty2])).to.deep.equal([[1, 20], [2, 50]]);
		});
	});

	describe('capability forwarding', () => {
		// IsolationModule is a transparent wrapper: optional capability hooks that
		// decomposition/lens (and the planner) consult must reach the underlying
		// module. A missing forward is a silent-degradation footgun — e.g. a dropped
		// getMappingAdvertisements silently disables tag-derived decomposition under
		// isolation. These tests pin the forwards so a future hook is not forgotten.

		it('forwards getMappingAdvertisements to the underlying module', () => {
			const sentinel = [{ decompositionId: 'quereus.lens.decomp.test' }] as any;
			let received: { db: unknown; basis: unknown } | undefined;
			const underlying = {
				...new MemoryTableModule(),
				getMappingAdvertisements(callDb: unknown, basisSchema: unknown) {
					received = { db: callDb, basis: basisSchema };
					return sentinel;
				},
			} as any;
			const isolatedModule = new IsolationModule({ underlying });

			const basis = { name: 'main' } as any;
			const result = isolatedModule.getMappingAdvertisements(db, basis);

			expect(result).to.equal(sentinel);
			expect(received?.db).to.equal(db);
			expect(received?.basis).to.equal(basis);
		});

		it('returns [] when the underlying module does not implement the hook', () => {
			// The optional-call fallback (`?. ... ?? []`) must yield an empty list
			// rather than undefined when the underlying module omits the hook.
			const underlying = { ...new MemoryTableModule(), getMappingAdvertisements: undefined } as any;
			const isolatedModule = new IsolationModule({ underlying });
			const result = isolatedModule.getMappingAdvertisements(db, { name: 'main' } as any);
			expect(result).to.deep.equal([]);
		});

		it('forwards beginSchemaBatch/endSchemaBatch to the underlying module', async () => {
			// APPLY SCHEMA fires these hooks on the registered module (the wrapper
			// when isolated). A batching-capable underlying must receive begin/end so
			// it can fold the migration into a single substrate commit. A missing
			// forward silently degrades to per-DDL commits.
			const beginCalls: { schemaName: string }[] = [];
			const endCalls: { schemaName: string; error?: unknown }[] = [];
			const underlying = {
				...new MemoryTableModule(),
				async beginSchemaBatch(_callDb: unknown, schemaName: string) {
					beginCalls.push({ schemaName });
				},
				async endSchemaBatch(_callDb: unknown, schemaName: string, error?: unknown) {
					endCalls.push({ schemaName, error });
				},
			} as any;
			const isolatedModule = new IsolationModule({ underlying });

			await isolatedModule.beginSchemaBatch(db, 'main');
			await isolatedModule.endSchemaBatch(db, 'main', undefined);

			expect(beginCalls).to.deep.equal([{ schemaName: 'main' }]);
			expect(endCalls).to.deep.equal([{ schemaName: 'main', error: undefined }]);
		});

		it('endSchemaBatch forwards the loop error to the underlying', async () => {
			const endCalls: { error?: unknown }[] = [];
			const sentinelError = new Error('migration failed');
			const underlying = {
				...new MemoryTableModule(),
				async endSchemaBatch(_callDb: unknown, _schemaName: string, error?: unknown) {
					endCalls.push({ error });
				},
			} as any;
			const isolatedModule = new IsolationModule({ underlying });

			await isolatedModule.endSchemaBatch(db, 'main', sentinelError);
			expect(endCalls).to.deep.equal([{ error: sentinelError }]);
		});

		it('no-ops when the underlying module does not implement the batch hooks', async () => {
			// The optional-call (`?.`) must not throw when the underlying omits the
			// hooks — APPLY SCHEMA's loop guard would otherwise never reach here, but
			// the wrapper must remain safe to invoke directly.
			const underlying = {
				...new MemoryTableModule(),
				beginSchemaBatch: undefined,
				endSchemaBatch: undefined,
			} as any;
			const isolatedModule = new IsolationModule({ underlying });

			await isolatedModule.beginSchemaBatch(db, 'main');
			await isolatedModule.endSchemaBatch(db, 'main');
			// reaching here without throwing is the assertion
		});

		it('forwards notifyLensDeployment to the underlying module', async () => {
			// A logical APPLY SCHEMA fires `notifyLensDeployment` on the registered
			// module (the wrapper when a basis is isolated). The deployed snapshot is
			// isolation-transparent, so it must reach the underlying — a missing
			// forward silently strands a basis-backing module's reconcile.
			const calls: { schemaName: string; snapshot: unknown }[] = [];
			const underlying = {
				...new MemoryTableModule(),
				async notifyLensDeployment(_callDb: unknown, schemaName: string, snapshot: unknown) {
					calls.push({ schemaName, snapshot });
				},
			} as any;
			const isolatedModule = new IsolationModule({ underlying });

			const sentinel = { basisSchemaName: 'y', basisHash: 'h', tables: new Map() } as any;
			await isolatedModule.notifyLensDeployment(db, 'x', sentinel);

			expect(calls).to.have.lengthOf(1);
			expect(calls[0].schemaName).to.equal('x');
			expect(calls[0].snapshot).to.equal(sentinel);
		});

		it('notifyLensDeployment no-ops when the underlying omits the hook', async () => {
			const underlying = { ...new MemoryTableModule(), notifyLensDeployment: undefined } as any;
			const isolatedModule = new IsolationModule({ underlying });
			const sentinel = { basisSchemaName: 'y', basisHash: 'h', tables: new Map() } as any;
			await isolatedModule.notifyLensDeployment(db, 'x', sentinel);
			// reaching here without throwing is the assertion
		});

		it('reaches the underlying through a real APPLY SCHEMA under isolation', async () => {
			// End-to-end floor: register the wrapper as a real module, run an actual
			// `apply schema`, and prove (a) APPLY SCHEMA's registered-module loop
			// reaches the IsolationModule wrapper, and (b) the underlying observes an
			// active batch when its `create` callbacks fire during the loop. The
			// direct-call unit tests above prove the forward in isolation; this proves
			// the wiring the forward exists for.
			let batchActive = false;
			const beginCalls: string[] = [];
			const endCalls: { schemaName: string; error?: unknown }[] = [];
			const createsDuringBatch: { table: string; active: boolean }[] = [];
			class RecordingModule extends MemoryTableModule {
				async beginSchemaBatch(_callDb: unknown, schemaName: string) {
					beginCalls.push(schemaName);
					batchActive = true;
				}
				async endSchemaBatch(_callDb: unknown, schemaName: string, error?: unknown) {
					endCalls.push({ schemaName, error });
					batchActive = false;
				}
				override async create(callDb: any, tableSchema: any) {
					createsDuringBatch.push({ table: tableSchema.name, active: batchActive });
					return super.create(callDb, tableSchema);
				}
			}
			const isolatedModule = new IsolationModule({ underlying: new RecordingModule() });
			db.registerModule('isolated', isolatedModule);
			db.setDefaultVtabName('isolated');

			await db.exec(`
				declare schema main {
					table t1 (
						id integer primary key
					)
					table t2 (
						id integer primary key
					)
				}
			`);
			await db.exec('apply schema main;');

			// Exactly one begin/end pair reached the underlying via the wrapper.
			expect(beginCalls).to.deep.equal(['main']);
			expect(endCalls).to.deep.equal([{ schemaName: 'main', error: undefined }]);
			// Both table creates ran while the batch was open (single-commit window).
			expect(createsDuringBatch).to.deep.equal([
				{ table: 't1', active: true },
				{ table: 't2', active: true },
			]);
			// Batch closed after the loop.
			expect(batchActive).to.be.false;
		});

		it('forwards getCapabilities while layering isolation guarantees', () => {
			const underlying = {
				...new MemoryTableModule(),
				getCapabilities() {
					return { supportsPushDown: true } as any;
				},
			} as any;
			const isolatedModule = new IsolationModule({ underlying });

			const caps = isolatedModule.getCapabilities() as any;
			expect(caps.supportsPushDown).to.be.true; // underlying capability preserved
			expect(caps.isolation).to.be.true; // isolation guarantee layered on
			expect(caps.savepoints).to.be.true;
		});
	});
});

// ===========================================================================
// concurrencyMode / expectedLatencyMs forwarding + ensureConnection reentrancy
//
// IsolationModule forwards the underlying module's plan-level hints so a host
// wrapping a reentrant module (e.g. Lamina over a Memory overlay) keeps the
// `concurrencySafe` / `expectedLatencyMs` it would get registering the
// underlying directly. The forward is safe because the one lazy-init race in
// the merged-overlay read path (`IsolatedTable.ensureConnection`) is hardened
// with an in-flight memo.
// ===========================================================================
describe('IsolationModule concurrency + latency forwarding', () => {
	/**
	 * Minimal module stub exposing only the two forwarded hints. The forwarding
	 * getters read just `concurrencyMode` / `expectedLatencyMs`; no create/connect
	 * is exercised for the getter-level assertions.
	 */
	function modeStub(concurrencyMode?: VtabConcurrencyMode, expectedLatencyMs?: number): VirtualTableModule<any, any> {
		const m: Record<string, unknown> = {};
		if (concurrencyMode !== undefined) m.concurrencyMode = concurrencyMode;
		if (expectedLatencyMs !== undefined) m.expectedLatencyMs = expectedLatencyMs;
		return m as unknown as VirtualTableModule<any, any>;
	}

	/** Functional memory module declaring a non-zero latency hint
	 *  (reentrant-reads inherited from MemoryTableModule). */
	class HighLatencyMemoryModule extends MemoryTableModule {
		readonly expectedLatencyMs = 25;
	}

	describe('forwarding (getter-level)', () => {
		it('serial underlying degrades the wrapper to serial', () => {
			const iso = new IsolationModule({ underlying: modeStub('serial'), overlay: modeStub('reentrant-reads') });
			expect(getModuleConcurrencyMode(iso)).to.equal('serial');
			expect(iso.concurrencyMode).to.equal('serial');
		});

		it('reentrant underlying + default Memory overlay → reentrant-reads', () => {
			// overlay omitted → defaults to MemoryTableModule (reentrant-reads).
			const iso = new IsolationModule({ underlying: modeStub('reentrant-reads') });
			expect(getModuleConcurrencyMode(iso)).to.equal('reentrant-reads');
		});

		it('reentrant underlying + serial custom overlay → serial (weakest-of)', () => {
			const iso = new IsolationModule({ underlying: modeStub('reentrant-reads'), overlay: modeStub('serial') });
			expect(getModuleConcurrencyMode(iso)).to.equal('serial');
		});

		it('fully-reentrant underlying + fully-reentrant overlay clamps to reentrant-reads', () => {
			const iso = new IsolationModule({ underlying: modeStub('fully-reentrant'), overlay: modeStub('fully-reentrant') });
			// IsolationModule's own write path is never reentrant → cap applies.
			expect(iso.concurrencyMode).to.equal('reentrant-reads');
		});

		it('absent concurrencyMode on both sides → serial', () => {
			const iso = new IsolationModule({ underlying: modeStub(undefined), overlay: modeStub(undefined) });
			expect(getModuleConcurrencyMode(iso)).to.equal('serial');
		});

		it('expectedLatencyMs absent on underlying → 0 (no hint)', () => {
			const iso = new IsolationModule({ underlying: modeStub('reentrant-reads') });
			expect(iso.expectedLatencyMs).to.equal(0);
		});

		it('expectedLatencyMs forwarded from underlying (25)', () => {
			const iso = new IsolationModule({ underlying: modeStub('reentrant-reads', 25) });
			expect(iso.expectedLatencyMs).to.equal(25);
		});

		it('expectedLatencyMs comes from the underlying, never the overlay', () => {
			const iso = new IsolationModule({ underlying: modeStub('reentrant-reads', 25), overlay: modeStub('reentrant-reads', 999) });
			expect(iso.expectedLatencyMs).to.equal(25);
		});
	});

	describe('plan-level forwarding (physical properties)', () => {
		// PlanNode / PlanNodeType are not part of the published @quereus/quereus
		// surface, so we walk the optimized tree structurally and match the leaf
		// table reference by its node-type string ('TableReference').
		function findByType(root: any, nodeType: string): any[] {
			const out: any[] = [];
			const seen = new Set<string>();
			const stack: any[] = [root];
			while (stack.length > 0) {
				const n = stack.pop();
				if (!n || seen.has(n.id)) continue;
				seen.add(n.id);
				if (n.nodeType === nodeType) out.push(n);
				for (const c of n.getChildren()) stack.push(c);
			}
			return out;
		}

		it('reentrant + latency underlying surfaces concurrencySafe=true and the latency hint through the wrapper', async () => {
			const db = new Database();
			const iso = new IsolationModule({ underlying: new HighLatencyMemoryModule() });
			db.registerModule('isolated', iso);
			await db.exec('create table t (id integer primary key, v text) using isolated');

			const plan = db.getPlan('select * from t');
			const refs = findByType(plan, 'TableReference');
			expect(refs.length, 'expected a TableReference node in the plan').to.be.greaterThan(0);
			const phys = refs[0].physical;
			expect(phys.concurrencySafe).to.equal(true);
			expect(phys.expectedLatencyMs).to.equal(25);
			await db.close();
		});

		it('serial wrapper (serial overlay) yields concurrencySafe=false and no latency hint', async () => {
			const db = new Database();
			// Reentrant underlying, serial custom overlay → weakest-of → serial.
			// The overlay module is never instantiated during a read-only plan.
			const iso = new IsolationModule({ underlying: new MemoryTableModule(), overlay: modeStub('serial') });
			db.registerModule('isolated', iso);
			await db.exec('create table t (id integer primary key, v text) using isolated');

			const plan = db.getPlan('select * from t');
			const refs = findByType(plan, 'TableReference');
			expect(refs.length, 'expected a TableReference node in the plan').to.be.greaterThan(0);
			const phys = refs[0].physical;
			expect(phys.concurrencySafe).to.equal(false);
			expect(phys.expectedLatencyMs).to.equal(undefined);
			await db.close();
		});
	});

	describe('ensureConnection reentrancy + merged-read correctness', () => {
		let db: Database;

		beforeEach(() => {
			db = new Database();
		});

		afterEach(async () => {
			await db.close();
		});

		/** A full-scan FilterInfo. `idxStr === null` → primary-key scan; a
		 *  `idx=<name>(0);plan=2` string → a full ascending scan over that
		 *  secondary index. Mirrors `IsolatedTable.createFullScanFilterInfo`. */
		function fullScanFilter(idxStr: string | null): FilterInfo {
			return {
				idxNum: 0,
				idxStr,
				constraints: [],
				args: [],
				indexInfoOutput: {
					nConstraint: 0,
					aConstraint: [],
					nOrderBy: 0,
					aOrderBy: [],
					colUsed: 0n,
					aConstraintUsage: [],
					idxNum: 0,
					idxStr,
					orderByConsumed: false,
					estimatedCost: 1000000,
					estimatedRows: 1000000n,
					idxFlags: 0,
				},
			};
		}

		/** The merged ground truth for the staged overlay below, as [id, v]. */
		const EXPECTED: SqlValue[][] = [[1, 'a'], [3, 'C'], [4, 'd']];

		/** Normalises a merged result to sorted [id, v] tuples for multiset compare. */
		function sortRows(rows: readonly Row[]): SqlValue[][] {
			return rows.map(r => [r[0], r[1]] as SqlValue[]).sort((x, y) => Number(x[0]) - Number(y[0]));
		}

		const QUALIFIED = 'main.t';
		function dbi(): DatabaseInternal { return db as unknown as DatabaseInternal; }
		function conns(): VirtualTableConnection[] { return dbi().getConnectionsForTable(QUALIFIED); }
		function clearConns(): void { for (const c of conns()) dbi().unregisterConnection(c.connectionId); }

		async function connectReader(iso: IsolationModule, readCommitted = false): Promise<IsolatedTable> {
			const opts = (readCommitted ? { _readCommitted: true } : {}) as unknown as BaseModuleConfig;
			return await iso.connect(db, undefined, 'isolated', 'main', 't', opts) as IsolatedTable;
		}

		/**
		 * Creates `t (id, v)` over an isolation-wrapped memory module, seeds three
		 * committed rows, then injects an overlay holding a staged insert (id=4), a
		 * staged tombstone (id=2) and a staged update (id=3 → 'C') directly — no
		 * transaction. The merged view is {@link EXPECTED}.
		 *
		 * Direct overlay injection (rather than BEGIN + DML) keeps the registered-
		 * connection count deterministic: there is no open transaction to defer
		 * `unregisterConnection`, so the concurrent-read seam is exercised from a
		 * known-clean connection state.
		 */
		async function setupStagedOverlay(withSecondaryIndex: boolean): Promise<IsolationModule> {
			const iso = new IsolationModule({ underlying: new MemoryTableModule() });
			db.registerModule('isolated', iso);
			await db.exec('create table t (id integer primary key, v text) using isolated');
			if (withSecondaryIndex) await db.exec('create index t_by_v on t(v)');
			await db.exec("insert into t values (1,'a'),(2,'b'),(3,'c')");

			const underlying = iso.getUnderlyingState('main', 't')!.underlyingTable;
			const overlay = await iso.overlayModule.create(db, iso.createOverlaySchema(underlying.tableSchema!));
			// Overlay rows carry a trailing tombstone column (0 = live, 1 = tombstone).
			await overlay.update({ operation: 'insert', values: [4, 'd', 0] }); // staged insert
			await overlay.update({ operation: 'insert', values: [2, null, 1] }); // staged tombstone (id=2)
			await overlay.update({ operation: 'insert', values: [3, 'C', 0] }); // staged update (id=3)
			iso.setConnectionOverlay(db, 'main', 't', { overlayTable: overlay, hasChanges: true });
			return iso;
		}

		/** Builds the `idx=<name>(0);plan=2` string for the index over column `v`. */
		function secondaryIdxStr(iso: IsolationModule): string {
			const schema = iso.getUnderlyingState('main', 't')!.underlyingTable.tableSchema!;
			const vIdx = schema.columnIndexMap.get('v')!;
			const idx = schema.indexes!.find(i => i.columns.some(c => c.index === vIdx))!;
			return `idx=${idx.name}(0);plan=2`;
		}

		it('primary scan: concurrent first-reads on one instance register exactly one connection and match the serial baseline', async () => {
			const iso = await setupStagedOverlay(false);
			const filter = () => fullScanFilter(null);

			// Serial baseline through its own fresh instance.
			const baseline = await asyncIterableToArray((await connectReader(iso)).query(filter()));
			expect(sortRows(baseline)).to.deep.equal(EXPECTED);

			// Drop any covering connection so the concurrent pair hits the
			// no-existing-covering seam in ensureConnection.
			clearConns();
			expect(conns().length).to.equal(0);

			const inst = await connectReader(iso);
			const [a, b] = await Promise.all([
				asyncIterableToArray(inst.query(filter())),
				asyncIterableToArray(inst.query(filter())),
			]);

			expect(conns().length, 'memo must coalesce concurrent first-reads to one registration').to.equal(1);
			expect(sortRows(a)).to.deep.equal(EXPECTED);
			expect(sortRows(b)).to.deep.equal(EXPECTED);
		});

		it('secondary-index scan: concurrent first-reads register exactly one connection and match the serial baseline', async () => {
			const iso = await setupStagedOverlay(true);
			const idxStr = secondaryIdxStr(iso);
			const filter = () => fullScanFilter(idxStr);

			const baseline = await asyncIterableToArray((await connectReader(iso)).query(filter()));
			expect(sortRows(baseline)).to.deep.equal(EXPECTED);

			clearConns();
			expect(conns().length).to.equal(0);

			const inst = await connectReader(iso);
			const [a, b] = await Promise.all([
				asyncIterableToArray(inst.query(filter())),
				asyncIterableToArray(inst.query(filter())),
			]);

			expect(conns().length, 'memo must coalesce concurrent first-reads to one registration').to.equal(1);
			expect(sortRows(a)).to.deep.equal(EXPECTED);
			expect(sortRows(b)).to.deep.equal(EXPECTED);
		});

		// --- Cross-instance coalescing -----------------------------------------
		// The runtime connects a FRESH IsolatedTable per scan, so two concurrent
		// merged-overlay scans of one table land on DISTINCT wrapper instances —
		// the path the same-instance tests above never exercise. A per-instance
		// memo cannot coalesce these; only the module-level memo
		// (IsolationModule.coalesceConnectionBuild, keyed per db+table) can. Without
		// it both instances register their own covering IsolatedConnection
		// (covering.length === 2), tripping DeferredConstraintQueue.findConnection's
		// "found multiple candidate connections" throw downstream.

		it('primary scan: concurrent first-reads across SEPARATE instances coalesce onto one covering connection', async () => {
			const iso = await setupStagedOverlay(false);
			const filter = () => fullScanFilter(null);

			// Start from a clean connection set so both fresh instances hit the
			// no-existing-covering seam in ensureConnection simultaneously.
			clearConns();
			expect(conns().length).to.equal(0);

			const instA = await connectReader(iso);
			const instB = await connectReader(iso);
			const [a, b] = await Promise.all([
				asyncIterableToArray(instA.query(filter())),
				asyncIterableToArray(instB.query(filter())),
			]);

			expect(conns().filter(c => c.isCovering).length,
				'module-level memo must coalesce cross-instance first-reads to one covering connection').to.equal(1);
			expect(sortRows(a)).to.deep.equal(EXPECTED);
			expect(sortRows(b)).to.deep.equal(EXPECTED);
		});

		it('secondary-index scan: concurrent first-reads across SEPARATE instances coalesce onto one covering connection', async () => {
			const iso = await setupStagedOverlay(true);
			const idxStr = secondaryIdxStr(iso);
			const filter = () => fullScanFilter(idxStr);

			clearConns();
			expect(conns().length).to.equal(0);

			const instA = await connectReader(iso);
			const instB = await connectReader(iso);
			const [a, b] = await Promise.all([
				asyncIterableToArray(instA.query(filter())),
				asyncIterableToArray(instB.query(filter())),
			]);

			expect(conns().filter(c => c.isCovering).length,
				'module-level memo must coalesce cross-instance first-reads to one covering connection').to.equal(1);
			expect(sortRows(a)).to.deep.equal(EXPECTED);
			expect(sortRows(b)).to.deep.equal(EXPECTED);
		});

		it('reuses an existing covering connection under concurrency (no extra registration)', async () => {
			const iso = await setupStagedOverlay(false);
			// Register a covering connection via a serial first read.
			await asyncIterableToArray((await connectReader(iso)).query(fullScanFilter(null)));
			const before = conns().length;
			expect(before).to.be.greaterThan(0);

			const inst = await connectReader(iso);
			const [a, b] = await Promise.all([
				asyncIterableToArray(inst.query(fullScanFilter(null))),
				asyncIterableToArray(inst.query(fullScanFilter(null))),
			]);

			// The covering-reuse check inside the memoized body still fires — no growth.
			expect(conns().length).to.equal(before);
			expect(sortRows(a)).to.deep.equal(EXPECTED);
			expect(sortRows(b)).to.deep.equal(EXPECTED);
		});

		it('a failed connection build clears the in-flight memo so a later read retries', async () => {
			const iso = await setupStagedOverlay(false);
			clearConns();
			const inst = await connectReader(iso);

			const realRegister = dbi().registerConnection.bind(dbi());
			let calls = 0;
			(db as any).registerConnection = async (c: VirtualTableConnection) => {
				calls++;
				if (calls === 1) throw new Error('boom: simulated registration failure');
				return realRegister(c);
			};
			try {
				let threw = false;
				try {
					await asyncIterableToArray(inst.query(fullScanFilter(null)));
				} catch {
					threw = true;
				}
				expect(threw, 'first read must surface the build failure').to.equal(true);

				// Memo cleared on reject → the retry rebuilds and registers exactly once.
				const rows = await asyncIterableToArray(inst.query(fullScanFilter(null)));
				expect(sortRows(rows)).to.deep.equal(EXPECTED);
				expect(conns().length).to.equal(1);
			} finally {
				delete (db as any).registerConnection;
			}
		});

		it('read-committed scan over a reentrant underlying stays concurrency-safe and bypasses the overlay', async () => {
			const iso = await setupStagedOverlay(false);
			expect(getModuleConcurrencyMode(iso)).to.equal('reentrant-reads');
			clearConns();

			// readCommitted → fast path delegates straight to the underlying (no
			// overlay merge, no connection registration).
			const inst = await connectReader(iso, true);
			const [a, b] = await Promise.all([
				asyncIterableToArray(inst.query(fullScanFilter(null))),
				asyncIterableToArray(inst.query(fullScanFilter(null))),
			]);

			// Committed underlying only: staged insert/tombstone/update are invisible.
			const committed: SqlValue[][] = [[1, 'a'], [2, 'b'], [3, 'c']];
			expect(sortRows(a)).to.deep.equal(committed);
			expect(sortRows(b)).to.deep.equal(committed);
			expect(conns().length, 'read-committed fast path registers no connection').to.equal(0);
		});
	});
});
