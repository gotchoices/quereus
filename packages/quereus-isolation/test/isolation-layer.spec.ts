import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, MemoryTableModule, asyncIterableToArray, getModuleConcurrencyMode, QuereusError, StatusCode } from '@quereus/quereus';
import type { VtabConcurrencyMode, FilterInfo, VirtualTableModule, BaseModuleConfig, DatabaseInternal, Row, SqlValue, VirtualTableConnection, SchemaChangeInfo, TableSchema, BestAccessPlanRequest, BestAccessPlanResult } from '@quereus/quereus';
import { IsolationModule, IsolatedTable } from '../src/index.js';
import type { ConnectionOverlayState } from '../src/index.js';

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

	describe('merged secondary-index key encoding (bigint / collation)', () => {
		let isolatedModule: IsolationModule;

		beforeEach(() => {
			const memoryModule = new MemoryTableModule();
			isolatedModule = new IsolationModule({
				underlying: memoryModule,
			});
			db.registerModule('isolated', isolatedModule);
		});

		it('scans a secondary index while a bigint-PK table has pending overlay changes', async () => {
			await db.exec(`
				CREATE TABLE big (
					id INTEGER PRIMARY KEY,
					tag TEXT
				) USING isolated
			`);
			await db.exec(`CREATE INDEX idx_tag ON big(tag)`);

			// A committed small-int-PK row (seeded via SQL).
			await db.exec(`INSERT INTO big VALUES (1, 'alpha')`);

			// Stage a pending overlay INSERT at a bigint PK by injecting into the overlay
			// directly, rather than via a SQL INSERT inside BEGIN. A SQL INSERT of a bigint
			// PK trips a SEPARATE, pre-existing engine defect — the transaction change-log
			// key encoder (`TransactionManager.serializeKeyTuple`) also uses JSON.stringify
			// and throws on a bigint before the isolation merge path is ever reached. That
			// core bug is out of scope for the isolation layer under test here and is tracked
			// in fix/txn-changelog-bigint-key. Direct injection isolates the merge-path
			// bug so this spec fails ONLY on the isolation-layer defect it targets.
			const BIG = 9007199254740994n; // 2^53 + 2 — a JS bigint (beyond MAX_SAFE_INTEGER)
			const underlying = isolatedModule.getUnderlyingState('main', 'big')!.underlyingTable;
			const overlay = await isolatedModule.overlayModule.create(
				db, isolatedModule.createOverlaySchema(underlying.tableSchema!));
			// Overlay rows carry a trailing tombstone column (0 = live).
			await overlay.update({ operation: 'insert', values: [BIG, 'beta', 0] });
			isolatedModule.setConnectionOverlay(db, 'main', 'big', { overlayTable: overlay, hasChanges: true });

			// Secondary-index scan hitting the committed row. The merge builds a modified-PK
			// set over the overlay (which now holds a bigint PK); pre-fix that build throws
			// "Do not know how to serialize a BigInt" via JSON.stringify.
			const alpha = await asyncIterableToArray(db.eval(`SELECT * FROM big WHERE tag = 'alpha'`));
			expect(alpha.length).to.equal(1);
			expect(alpha[0].id).to.equal(1);

			// Secondary-index scan hitting the staged bigint-PK overlay row — confirms the
			// bigint PK round-trips through the merge intact.
			const beta = await asyncIterableToArray(db.eval(`SELECT * FROM big WHERE tag = 'beta'`));
			expect(beta.length).to.equal(1);
			expect(beta[0].id).to.equal(BIG);
		});

		it('does not duplicate a NOCASE-PK row whose key changes only in case', async () => {
			await db.exec(`
				CREATE TABLE items (
					id TEXT COLLATE NOCASE PRIMARY KEY,
					tag TEXT
				) USING isolated
			`);
			await db.exec(`CREATE INDEX idx_tag ON items(tag)`);

			// Seed + commit a lowercase-keyed row.
			await db.exec(`INSERT INTO items VALUES ('abc', 'shared')`);

			await db.exec('BEGIN');
			// Rewrite the PK to differ only in case — the SAME logical key under NOCASE,
			// so the overlay row shadows the underlying 'abc'. Pre-fix the JSON key encoding
			// ignores collation ('ABC' != 'abc'), so the underlying row is not excluded and
			// the scan yields BOTH.
			await db.exec(`UPDATE items SET id = 'ABC' WHERE id = 'abc'`);

			const rows = await asyncIterableToArray(
				db.eval(`SELECT * FROM items WHERE tag = 'shared'`)
			);
			expect(rows.length).to.equal(1);
			expect(rows[0].id).to.equal('ABC');

			await db.exec('ROLLBACK');
		});

		it('enforces a non-PK UNIQUE when an insert revives a tombstoned PK in the same txn', async () => {
			await db.exec(`
				CREATE TABLE t (
					id INTEGER PRIMARY KEY,
					u TEXT UNIQUE
				) USING isolated
			`);

			// Seed + commit A (pk=1, u='x') and B (pk=2, u='y').
			await db.exec(`INSERT INTO t VALUES (1, 'x')`);
			await db.exec(`INSERT INTO t VALUES (2, 'y')`);

			await db.exec('BEGIN');
			// Tombstone A, then revive pk=1 with u='y' — collides with B on UNIQUE(u).
			// Pre-fix the revival branch early-returns without the merged UNIQUE check,
			// so the collision is missed here and later flushed with trustedWrite, yielding
			// an opaque INTERNAL error at commit instead of a clean constraint violation.
			await db.exec(`DELETE FROM t WHERE id = 1`);

			let err: unknown;
			try {
				await db.exec(`INSERT INTO t VALUES (1, 'y')`);
			} catch (e) {
				err = e;
			}
			expect(err, 'reviving a tombstoned PK into a UNIQUE collision must throw').to.be.instanceOf(QuereusError);
			expect((err as QuereusError).code).to.equal(StatusCode.CONSTRAINT);

			await db.exec('ROLLBACK');

			// B is intact after rollback.
			const b = await db.get(`SELECT * FROM t WHERE id = 2`);
			expect(b?.u).to.equal('y');
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

		/**
		 * Live underlying column count for `main.<table>`. Read via the MemoryTable's
		 * `getSchema()` — the canonical schema the underlying manager mutates in place —
		 * NOT the `underlyingTable.tableSchema` field, which is a per-instance snapshot
		 * taken at connect time and is never refreshed by the module-level `alterTable`
		 * this layer drives. Reading the stale field would report the pre-ALTER count
		 * even when the underlying HAS been mutated, making the atomicity assertion
		 * vacuous (it would pass against the pre-fix mutate-then-validate ordering too).
		 * `getSchema()` is MemoryTable-specific (not on the base `VirtualTable`), so we
		 * narrow structurally — sound because this suite pins the underlying to memory.
		 */
		function underlyingColumnCount(table: string): number {
			const underlying = isolatedModule.getUnderlyingState('main', table)!.underlyingTable as unknown as {
				getSchema(): { columns: readonly unknown[] } | undefined;
			};
			return underlying.getSchema()!.columns.length;
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

	describe('ALTER TABLE ADD COLUMN cross-connection poison semantics', () => {
		// The hybrid (B) blast radius: an ALTER no longer aborts because of ANOTHER
		// connection's uncommitted, un-backfillable overlay. The issuer's own
		// un-backfillable overlay still aborts atomically (unchanged); a foreign one is
		// POISONED — its owning connection errors on its next read/write/commit — while
		// the issuer's ALTER applies and every migratable overlay is carried forward.
		//
		// These are white-box tests: two+ Database instances share ONE IsolationModule so
		// each connection gets a distinct dbId (the module keys overlays by getDbId(db)).
		// Overlays are injected directly via setConnectionOverlay (deterministic connection
		// counts, following setupStagedOverlay) and the ALTER is driven straight through
		// iso.alterTable(dbA, ...) with a manually-built addColumn change.
		let iso: IsolationModule;
		let dbA: Database; // the ALTER issuer
		let dbB: Database; // a foreign connection (poison target)
		let dbC: Database; // a second foreign connection (migratable peer)

		beforeEach(async () => {
			iso = new IsolationModule({ underlying: new MemoryTableModule() });
			dbA = new Database();
			dbB = new Database();
			dbC = new Database();
			dbA.registerModule('isolated', iso);
			// Created through dbA → builds the shared underlying (columns: id, x).
			await dbA.exec('create table t (id integer primary key, x integer null) using isolated');
			// One committed baseline row whose own backfill always succeeds (x is non-null),
			// so the underlying's NOT NULL backfill never trips — only staged overlay rows do.
			await dbA.exec('insert into t values (5, 5)');
		});

		afterEach(async () => {
			await dbA.close();
			await dbB.close();
			await dbC.close();
		});

		/** Primary-key full-scan FilterInfo (idxStr === null). */
		function fullScan(): FilterInfo {
			return {
				idxNum: 0,
				idxStr: null,
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
					idxStr: null,
					orderByConsumed: false,
					estimatedCost: 1000000,
					estimatedRows: 1000000n,
					idxFlags: 0,
				},
			};
		}

		/**
		 * An `addColumn` change for a NOT NULL column whose per-row backfill is the staged
		 * row's `x` value (column index 1). A staged row with x = NULL therefore yields NULL
		 * and is un-backfillable; a staged row with a non-null x backfills successfully.
		 *
		 * Mirrors the engine's real `ADD COLUMN c INTEGER NOT NULL DEFAULT (new.x)` shape:
		 * the columnDef carries the non-foldable `new.x` DEFAULT expression AND a matching
		 * `backfillEvaluator`. The DEFAULT expr is what lets the underlying's
		 * `addColumn` accept a NOT NULL column on a non-empty table (it backfills per row
		 * via the evaluator instead of demanding a literal default), while
		 * `deriveAddColumnBackfill` folds the same expr to `null` and drives the overlay
		 * backfill off the evaluator — yielding the CONSTRAINT that poisons a foreign overlay.
		 */
		function addNotNullCol(colName: string): SchemaChangeInfo {
			return {
				type: 'addColumn',
				columnDef: {
					name: colName,
					dataType: 'INTEGER',
					constraints: [
						{ type: 'notNull' },
						{ type: 'default', expr: { type: 'column', name: 'x', table: 'new' } },
					],
				},
				backfillEvaluator: (row: Row) => row[1],
			};
		}

		/**
		 * An `addColumn` change whose backfill ALWAYS succeeds: a literal DEFAULT (0). The
		 * folded literal satisfies the NOT NULL column for every staged row (no per-row
		 * evaluator path), and the literal lets the underlying accept the column on a
		 * non-empty table. Used to prove a migration would proceed (and thus could clear
		 * poison) were the poisoned overlay not skipped.
		 */
		function addBackfillableCol(colName: string): SchemaChangeInfo {
			return {
				type: 'addColumn',
				columnDef: {
					name: colName,
					dataType: 'INTEGER',
					constraints: [
						{ type: 'notNull' },
						{ type: 'default', expr: { type: 'literal', value: 0 } },
					],
				},
			};
		}

		/** Injects a staged-insert overlay (rows = [id, x][]) for `forDb`, hasChanges=true. */
		async function injectOverlay(forDb: Database, rows: SqlValue[][]): Promise<void> {
			const underlying = iso.getUnderlyingState('main', 't')!.underlyingTable;
			const overlay = await iso.overlayModule.create(forDb, iso.createOverlaySchema(underlying.tableSchema!));
			for (const r of rows) {
				await overlay.update({ operation: 'insert', values: [...r, 0] }); // trailing 0 = live (not tombstone)
			}
			iso.setConnectionOverlay(forDb, 'main', 't', { overlayTable: overlay, hasChanges: true });
		}

		function overlayState(forDb: Database): ConnectionOverlayState | undefined {
			return iso.getConnectionOverlay(forDb, 'main', 't');
		}

		/**
		 * Live underlying column count via the MemoryTable's getSchema() — the canonical
		 * schema the manager mutates in place. The per-instance `.tableSchema` field is a
		 * connect-time snapshot the module-level alterTable never refreshes, so reading it
		 * would make the atomicity assertion vacuous (companion ticket's note).
		 */
		function underlyingColumnCount(): number {
			const underlying = iso.getUnderlyingState('main', 't')!.underlyingTable as unknown as {
				getSchema(): TableSchema | undefined;
			};
			return underlying.getSchema()!.columns.length;
		}

		async function reader(forDb: Database, readCommitted = false): Promise<IsolatedTable> {
			const opts = (readCommitted ? { _readCommitted: true } : {}) as unknown as BaseModuleConfig;
			return await iso.connect(forDb, undefined, 'isolated', 'main', 't', opts) as IsolatedTable;
		}

		it('applies the ALTER and poisons a foreign overlay whose staged row cannot backfill', async () => {
			await injectOverlay(dbB, [[10, null]]); // B stages an un-backfillable row (x = NULL)
			const before = underlyingColumnCount();  // id, x = 2

			const updated = await iso.alterTable(dbA, 'main', 't', addNotNullCol('c'));

			// The ALTER applied: returned schema AND the live underlying both gained 'c'.
			expect(updated.columns.some(col => col.name === 'c'), 'returned schema has new column').to.equal(true);
			expect(underlyingColumnCount(), 'underlying gained the new column').to.equal(before + 1);

			// B's overlay is poisoned (left in the pre-alter layout, not migrated).
			const bState = overlayState(dbB)!;
			expect(bState.poison, 'B overlay must be poisoned').to.not.be.undefined;
			expect(bState.poison!.message).to.match(/cannot satisfy/i);

			// A (issuer, clean) is unaffected: its read shows the backfilled new column.
			const aRows = await asyncIterableToArray((await reader(dbA)).query(fullScan()));
			expect(aRows.length).to.equal(1);
			expect(aRows[0][2], 'committed row backfilled c = x = 5').to.equal(5);
		});

		it('errors a poisoned connection at read, write, and commit; committed reads still succeed', async () => {
			await injectOverlay(dbB, [[10, null]]);
			await iso.alterTable(dbA, 'main', 't', addNotNullCol('c'));
			expect(overlayState(dbB)!.poison).to.not.be.undefined;

			const tableB = await reader(dbB);

			// Merged read throws CONSTRAINT.
			let readErr: unknown;
			try { await asyncIterableToArray(tableB.query(fullScan())); } catch (e) { readErr = e; }
			expect(readErr, 'merged read on a poisoned overlay must throw').to.be.instanceOf(QuereusError);
			expect((readErr as QuereusError).code).to.equal(StatusCode.CONSTRAINT);

			// Write throws CONSTRAINT before staging anything.
			let writeErr: unknown;
			try { await tableB.update({ operation: 'insert', values: [11, 5] }); } catch (e) { writeErr = e; }
			expect(writeErr, 'write on a poisoned overlay must throw').to.be.instanceOf(QuereusError);
			expect((writeErr as QuereusError).code).to.equal(StatusCode.CONSTRAINT);

			// Commit flush throws — this is how a connection that never touches the table
			// again still fails its commit.
			let commitErr: unknown;
			try { await tableB.onConnectionCommit(); } catch (e) { commitErr = e; }
			expect(commitErr, 'commit flush on a poisoned overlay must throw').to.be.instanceOf(QuereusError);
			expect((commitErr as QuereusError).code).to.equal(StatusCode.CONSTRAINT);

			// A committed-snapshot reader bypasses the overlay entirely and succeeds,
			// returning the (backfilled) underlying rows.
			const tableBRC = await reader(dbB, true);
			const rc = await asyncIterableToArray(tableBRC.query(fullScan()));
			expect(rc.length, 'read-committed reader returns underlying rows without throwing').to.equal(1);
			expect(rc[0][2]).to.equal(5);
		});

		it("rejects atomically when the issuer's own overlay cannot backfill", async () => {
			await injectOverlay(dbA, [[1, null]]); // A itself stages the un-backfillable row
			const before = underlyingColumnCount();

			let err: unknown;
			try { await iso.alterTable(dbA, 'main', 't', addNotNullCol('c')); } catch (e) { err = e; }
			expect(err, 'issuer-own un-backfillable overlay must abort the ALTER').to.be.instanceOf(QuereusError);
			expect((err as QuereusError).code).to.equal(StatusCode.CONSTRAINT);
			expect((err as QuereusError).message.toLowerCase()).to.include('not null');

			// Atomic: the shared underlying is untouched (no phantom column).
			expect(underlyingColumnCount(), 'underlying untouched after atomic rejection').to.equal(before);

			// A's overlay is intact and NOT poisoned (it aborted up front).
			const aState = overlayState(dbA)!;
			expect(aState.poison, 'issuer-own overlay is rejected, never poisoned').to.be.undefined;
			expect(aState.hasChanges).to.equal(true);
		});

		it('aborts on the issuer-own overlay first, poisoning no foreign overlay', async () => {
			// Both the issuer's own AND a foreign overlay are un-backfillable. The issuer-own
			// check runs first and aborts before the underlying is mutated, so the foreign
			// overlay is never reached and stays un-poisoned (full atomicity).
			await injectOverlay(dbA, [[1, null]]);
			await injectOverlay(dbB, [[10, null]]);
			const before = underlyingColumnCount();

			let err: unknown;
			try { await iso.alterTable(dbA, 'main', 't', addNotNullCol('c')); } catch (e) { err = e; }
			expect(err).to.be.instanceOf(QuereusError);
			expect(underlyingColumnCount(), 'nothing mutated').to.equal(before);
			expect(overlayState(dbB)!.poison, 'no foreign overlay poisoned on atomic abort').to.be.undefined;
		});

		it('poisons only the un-backfillable foreign overlay and migrates a healthy peer', async () => {
			await injectOverlay(dbB, [[10, null]]); // un-backfillable (x = NULL)
			await injectOverlay(dbC, [[20, 99]]);   // backfillable (x = 99)

			const updated = await iso.alterTable(dbA, 'main', 't', addNotNullCol('c'));
			expect(updated.columns.some(col => col.name === 'c')).to.equal(true);

			// B poisoned; C migrated forward (new state object, no poison).
			expect(overlayState(dbB)!.poison, 'B poisoned').to.not.be.undefined;
			const cState = overlayState(dbC)!;
			expect(cState.poison, 'C must NOT be poisoned').to.be.undefined;

			// C's staged row survives under the new layout with c backfilled from x.
			const cRows = await asyncIterableToArray(cState.overlayTable.query!(fullScan()));
			expect(cRows.length).to.equal(1);
			expect(cRows[0][0], 'id preserved').to.equal(20);   // [id, x, c, _tombstone]
			expect(cRows[0][2], 'c backfilled = x = 99').to.equal(99);
		});

		it('skips an already-poisoned foreign overlay on a second ALTER, preserving its message', async () => {
			await injectOverlay(dbB, [[10, null]]);
			await iso.alterTable(dbA, 'main', 't', addNotNullCol('c'));
			const firstMsg = overlayState(dbB)!.poison!.message;
			expect(firstMsg).to.match(/'c'/); // names the FIRST added column

			// Second ALTER: B's overlay is already poisoned → skipped (not re-read / re-validated /
			// re-migrated). The ALTER still succeeds and B's poison message is unchanged.
			const updated2 = await iso.alterTable(dbA, 'main', 't', addNotNullCol('d'));
			expect(updated2.columns.some(col => col.name === 'd')).to.equal(true);
			expect(overlayState(dbB)!.poison!.message, 'poison message stays the original').to.equal(firstMsg);
		});

		it('full rollback on a poisoned connection clears the poison', async () => {
			await injectOverlay(dbB, [[10, null]]);
			await iso.alterTable(dbA, 'main', 't', addNotNullCol('c'));
			expect(overlayState(dbB)!.poison).to.not.be.undefined;

			// Full rollback discards the overlay (and its poison) entirely.
			await (await reader(dbB)).onConnectionRollback();
			expect(overlayState(dbB), 'full rollback drops the overlay state').to.be.undefined;

			// A subsequent read takes the no-overlay fast path and does not throw.
			const rows = await asyncIterableToArray((await reader(dbB)).query(fullScan()));
			expect(rows.length, 'committed underlying still readable').to.equal(1);
		});

		it('rollback to a post-overlay savepoint leaves the poison set', async () => {
			await injectOverlay(dbB, [[10, null]]);
			await iso.alterTable(dbA, 'main', 't', addNotNullCol('c'));
			expect(overlayState(dbB)!.poison).to.not.be.undefined;

			// Index 1 is NOT in savepointsBeforeOverlay (the overlay pre-exists this savepoint),
			// so this rollback does NOT replace the ConnectionOverlayState — its poison persists.
			// The schema change is permanent and the overlay rows stay in the pre-alter layout,
			// so the connection must remain poisoned until the transaction ends.
			await (await reader(dbB)).onConnectionRollbackToSavepoint(1);
			expect(overlayState(dbB)!.poison, 'post-overlay savepoint rollback keeps poison').to.not.be.undefined;
		});

		it("a poisoned connection's own later ALTER neither clears its poison nor migrates its stale overlay", async () => {
			await injectOverlay(dbB, [[10, null]]);
			await iso.alterTable(dbA, 'main', 't', addNotNullCol('c'));
			const poisonMsg = overlayState(dbB)!.poison!.message;
			const staleOverlay = overlayState(dbB)!.overlayTable;

			// B, already poisoned, issues its OWN ALTER on the same table (e.g. mid-transaction,
			// before rolling back). A literal-default column backfills cleanly, so WITHOUT the
			// poison skip B's stale overlay would pass validation and migrate — rebuilding a
			// layout-mismatched overlay (its rows are a column short of the now-altered base)
			// AND dropping the poison, silently un-poisoning a connection that must still roll back.
			const updated = await iso.alterTable(dbB, 'main', 't', addBackfillableCol('d'));
			expect(updated.columns.some(col => col.name === 'd'), "B's ALTER still applies to the shared base").to.equal(true);

			const bState = overlayState(dbB)!;
			expect(bState.poison, 'B stays poisoned across its own ALTER').to.not.be.undefined;
			expect(bState.poison!.message, 'poison message unchanged — overlay never rebuilt').to.equal(poisonMsg);
			expect(bState.overlayTable, 'overlay object left untouched, not migrated').to.equal(staleOverlay);
		});

		it('DROP INDEX on the table neither migrates nor un-poisons a poisoned overlay', async () => {
			await dbA.exec('create index t_idx on t(x)');
			await injectOverlay(dbB, [[10, null]]);
			await iso.alterTable(dbA, 'main', 't', addNotNullCol('c'));
			const poisonMsg = overlayState(dbB)!.poison!.message;
			const staleOverlay = overlayState(dbB)!.overlayTable;

			// dropIndex rebuilds affected overlays under the post-drop schema. A poisoned overlay
			// holds rows in the narrower pre-alter layout — rebuilding would copy layout-mismatched
			// rows and drop the poison. It must be skipped, staying poisoned for its owner.
			await iso.dropIndex(dbA, 'main', 't', 't_idx');

			const bState = overlayState(dbB)!;
			expect(bState.poison, 'poison survives an unrelated DROP INDEX').to.not.be.undefined;
			expect(bState.poison!.message).to.equal(poisonMsg);
			expect(bState.overlayTable, 'poisoned overlay not rebuilt').to.equal(staleOverlay);
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

		it('mirrors createBacking presence — defined iff the underlying declares it', () => {
			// `SchemaManager.createBackingTable` does `createBacking?() ?? create()`,
			// so PRESENCE is the capability. The forward must be present iff the
			// underlying declares it — exactly like getBackingHost, with which it must
			// travel (one routes the MV backing into the durable store, the other
			// resolves its host).
			const withHook = new IsolationModule({ underlying: new (class extends MemoryTableModule {
				async createBacking(callDb: any, tableSchema: any) { return super.create(callDb, tableSchema); }
			})() });
			expect(withHook.createBacking, 'present when underlying declares it').to.be.a('function');

			const withoutHook = new IsolationModule({ underlying: { ...new MemoryTableModule(), createBacking: undefined } as any });
			expect(withoutHook.createBacking, 'absent when underlying omits it').to.be.undefined;
		});

		it('routes MV backing creation through the underlying createBacking under isolation', async () => {
			// End-to-end floor: register the wrapper as a real module and run an actual
			// CREATE MATERIALIZED VIEW. createBackingTable must prefer the (forwarded)
			// createBacking over create, and the (forwarded) getBackingHost must then
			// resolve a real host so the fill (replaceContents) succeeds. A missing
			// createBacking forward would silently fall back to the wrapper's generic
			// create — an ordinary table the forwarded getBackingHost can't back.
			const calls: string[] = [];
			class BackingModule extends MemoryTableModule {
				async createBacking(callDb: any, tableSchema: any) {
					calls.push('createBacking');
					return super.create(callDb, tableSchema);
				}
				override async create(callDb: any, tableSchema: any) {
					calls.push('create');
					return super.create(callDb, tableSchema);
				}
			}
			const isolatedModule = new IsolationModule({ underlying: new BackingModule() });
			db.registerModule('isolated', isolatedModule);

			await db.exec('create table src (id integer primary key, v text) using isolated');
			await db.exec("insert into src values (1, 'a')");
			calls.length = 0; // clear setup creates

			await db.exec('create materialized view mv using isolated as select id, v from src');

			expect(calls).to.include('createBacking');
			expect(calls).to.not.include('create');
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

	describe('suffixed primary-key index name (underlying-advertised)', () => {
		// Regression: an underlying virtual table may advertise its PK access plan under a
		// per-plan unique name — lamina-quereus appends a monotonic counter so it can recover
		// the exact plan later (`_primary_` → `_primary_1`, `_primary_2`, …). With a live
		// overlay (any buffered write), a PK point lookup then carried idxStr
		// `idx=_primary_1(...)`, which the isolation layer misclassified as a secondary index
		// and routed to the overlay MemoryTable — which has no such secondary index, so it
		// threw `QuereusError: Secondary index '_primary_1' not found.`

		/**
		 * Rewrites a suffixed PK idxStr (`idx=_primary_<n>(...)`) back to the base
		 * `_primary_`. The MemoryTable underlying only resolves `_primary_`, so its own
		 * query recovers the PK scan here exactly as lamina's private plan registry does —
		 * this is the load-bearing underlying-side behavior the isolation fix must tolerate,
		 * NOT change.
		 */
		function recoverSuffixedPk(filterInfo: FilterInfo): FilterInfo {
			const re = /(^|;)idx=_primary_\d+\(/;
			const { idxStr } = filterInfo;
			if (!idxStr || !re.test(idxStr)) return filterInfo;
			const strip = (s: string): string => s.replace(re, '$1idx=_primary_(');
			const outIdxStr = filterInfo.indexInfoOutput.idxStr;
			return {
				...filterInfo,
				idxStr: strip(idxStr),
				indexInfoOutput: { ...filterInfo.indexInfoOutput, idxStr: outIdxStr ? strip(outIdxStr) : outIdxStr },
			};
		}

		type UnderlyingTable = Awaited<ReturnType<MemoryTableModule['create']>>;

		/** Wraps a MemoryTable so its `query` recovers a suffixed PK name before delegating.
		 *  Every other member is forwarded to the real table (bound to it, so private fields
		 *  resolve). */
		function wrapUnderlying(table: UnderlyingTable): UnderlyingTable {
			return new Proxy(table, {
				get(target, prop) {
					if (prop === 'query') {
						return (filterInfo: FilterInfo) => target.query!(recoverSuffixedPk(filterInfo));
					}
					const value = Reflect.get(target, prop, target);
					return typeof value === 'function' ? value.bind(target) : value;
				},
			});
		}

		/** Underlying module that advertises its PK plan under the suffixed name `_primary_1`,
		 *  mimicking how lamina-quereus mints per-plan unique keys. Secondary index names are
		 *  advertised verbatim, so secondary routing is unaffected. */
		class SuffixedPkMemoryModule extends MemoryTableModule {
			override getBestAccessPlan(db: Database, tableInfo: TableSchema, request: BestAccessPlanRequest): BestAccessPlanResult {
				const plan = super.getBestAccessPlan(db, tableInfo, request);
				return plan.indexName === '_primary_' ? { ...plan, indexName: '_primary_1' } : plan;
			}
			override async create(...args: Parameters<MemoryTableModule['create']>): Promise<UnderlyingTable> {
				return wrapUnderlying(await super.create(...args));
			}
			override async connect(...args: Parameters<MemoryTableModule['connect']>): Promise<UnderlyingTable> {
				return wrapUnderlying(await super.connect(...args));
			}
		}

		let sdb: Database;
		beforeEach(() => {
			sdb = new Database();
			sdb.registerModule('isolated', new IsolationModule({ underlying: new SuffixedPkMemoryModule() }));
		});

		it('PK point lookup resolves through a live overlay (the original repro)', async () => {
			await sdb.exec(`CREATE TABLE Site (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);
			await sdb.exec(`INSERT INTO Site (id, name) VALUES (1, 'Scene A')`);

			await sdb.exec('BEGIN');
			// A buffered write creates the live overlay for this connection.
			await sdb.exec(`INSERT INTO Site (id, name) VALUES (2, 'Scene B')`);

			// Point lookup of the committed row: threw "Secondary index '_primary_1' not found"
			// before the fix.
			const existing = await sdb.get(`SELECT name FROM Site WHERE id = 1`);
			expect(existing?.name).to.equal('Scene A');

			// The overlay-buffered row is visible via the same suffixed-PK path.
			const buffered = await sdb.get(`SELECT name FROM Site WHERE id = 2`);
			expect(buffered?.name).to.equal('Scene B');

			await sdb.exec('COMMIT');

			const afterCommit = await asyncIterableToArray(sdb.eval(`SELECT id, name FROM Site ORDER BY id`));
			expect(afterCommit.map((r: any) => [r.id, r.name])).to.deep.equal([[1, 'Scene A'], [2, 'Scene B']]);
		});

		it('bare `_primary_` (no overlay-affecting suffix) still resolves — read without a live overlay', async () => {
			await sdb.exec(`CREATE TABLE Site (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);
			await sdb.exec(`INSERT INTO Site (id, name) VALUES (1, 'Scene A')`);
			// Autocommit read — no overlay, delegates straight to the underlying.
			const row = await sdb.get(`SELECT name FROM Site WHERE id = 1`);
			expect(row?.name).to.equal('Scene A');
		});

		it('PK range scan resolves through a live overlay with a suffixed PK name', async () => {
			await sdb.exec(`CREATE TABLE Site (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);
			await sdb.exec(`INSERT INTO Site (id, name) VALUES (1, 'A'), (2, 'B'), (3, 'C')`);

			await sdb.exec('BEGIN');
			await sdb.exec(`INSERT INTO Site (id, name) VALUES (4, 'D')`);   // creates overlay
			await sdb.exec(`UPDATE Site SET name = 'B2' WHERE id = 2`);

			const rows = await asyncIterableToArray(sdb.eval(`SELECT id, name FROM Site WHERE id >= 2 ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.name])).to.deep.equal([[2, 'B2'], [3, 'C'], [4, 'D']]);

			await sdb.exec('ROLLBACK');
		});

		it('genuine secondary index still routes to the overlay secondary scan under the suffixed module', async () => {
			// The PK-suffix rewrite must NOT disturb real secondary index names. Here the
			// underlying advertises the secondary index `idx_email` verbatim, so a lookup by
			// email with a live overlay must merge overlay + underlying secondary streams.
			await sdb.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, name TEXT) USING isolated`);
			await sdb.exec(`CREATE INDEX idx_email ON users(email)`);
			await sdb.exec(`INSERT INTO users VALUES (1, 'alice@example.com', 'Alice')`);

			await sdb.exec('BEGIN');
			await sdb.exec(`INSERT INTO users VALUES (2, 'bob@example.com', 'Bob')`); // creates overlay

			const alice = await sdb.get(`SELECT name FROM users WHERE email = 'alice@example.com'`);
			expect(alice?.name).to.equal('Alice');
			const bob = await sdb.get(`SELECT name FROM users WHERE email = 'bob@example.com'`);
			expect(bob?.name).to.equal('Bob');

			await sdb.exec('ROLLBACK');
		});
	});
});
