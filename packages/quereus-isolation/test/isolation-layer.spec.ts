import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import { Database, MemoryTableModule, asyncIterableToArray } from '@quereus/quereus';
import { IsolationModule } from '../src/index.js';

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
});
