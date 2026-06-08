import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database } from '../src/index.js';
import type { SqlValue } from '../src/common/types.js';

type ResultRow = Record<string, SqlValue>;

describe('Multi-statement execution', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	describe('exec() method', () => {
		it('should execute all statements in a multi-statement batch', async () => {
			// Create table and insert multiple rows in one exec call
			await db.exec(`
				CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT);
				INSERT INTO test VALUES (1, 'first');
				INSERT INTO test VALUES (2, 'second');
				INSERT INTO test VALUES (3, 'third');
			`);

			// Verify all three rows were inserted
			const rows: ResultRow[] = [];
			for await (const row of db.eval('SELECT * FROM test ORDER BY id')) {
				rows.push(row);
			}

			void expect(rows).to.have.length(3);
			void expect(rows[0].id).to.equal(1);
			void expect(rows[0].value).to.equal('first');
			void expect(rows[1].id).to.equal(2);
			void expect(rows[1].value).to.equal('second');
			void expect(rows[2].id).to.equal(3);
			void expect(rows[2].value).to.equal('third');
		});

		it('should execute multiple UPDATE statements', async () => {
			await db.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, value INTEGER)');
			await db.exec('INSERT INTO test VALUES (1, 10), (2, 20), (3, 30)');

			// Execute multiple updates in one batch
			await db.exec(`
				UPDATE test SET value = 100 WHERE id = 1;
				UPDATE test SET value = 200 WHERE id = 2;
				UPDATE test SET value = 300 WHERE id = 3;
			`);

			// Verify all updates were applied
			const rows: ResultRow[] = [];
			for await (const row of db.eval('SELECT * FROM test ORDER BY id')) {
				rows.push(row);
			}

			void expect(rows).to.have.length(3);
			void expect(rows[0].value).to.equal(100);
			void expect(rows[1].value).to.equal(200);
			void expect(rows[2].value).to.equal(300);
		});

		it('should execute CREATE TABLE followed by INSERT', async () => {
			await db.exec(`
				CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);
				INSERT INTO users VALUES (1, 'Alice');
			`);

			const rows: ResultRow[] = [];
			for await (const row of db.eval('SELECT * FROM users')) {
				rows.push(row);
			}

			void expect(rows).to.have.length(1);
			void expect(rows[0].name).to.equal('Alice');
		});
	});

	describe('eval() method', () => {
		it('should execute setup statements and return results from final query', async () => {
			// Multi-statement batch: setup + query
			const rows: ResultRow[] = [];
			for await (const row of db.eval(`
				CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT);
				INSERT INTO test VALUES (1, 'first');
				INSERT INTO test VALUES (2, 'second');
				SELECT * FROM test ORDER BY id;
			`)) {
				rows.push(row);
			}

			void expect(rows).to.have.length(2);
			void expect(rows[0].id).to.equal(1);
			void expect(rows[0].value).to.equal('first');
			void expect(rows[1].id).to.equal(2);
			void expect(rows[1].value).to.equal('second');
		});

		it('should execute multiple INSERTs and return results from final SELECT', async () => {
			await db.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, value INTEGER)');

			const rows: ResultRow[] = [];
			for await (const row of db.eval(`
				INSERT INTO test VALUES (1, 10);
				INSERT INTO test VALUES (2, 20);
				INSERT INTO test VALUES (3, 30);
				SELECT SUM(value) as total FROM test;
			`)) {
				rows.push(row);
			}

			void expect(rows).to.have.length(1);
			void expect(rows[0].total).to.equal(60);
		});

		it('should handle single statement queries', async () => {
			await db.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)');
			await db.exec("INSERT INTO test VALUES (1, 'single')");

			const rows: ResultRow[] = [];
			for await (const row of db.eval('SELECT * FROM test')) {
				rows.push(row);
			}

			void expect(rows).to.have.length(1);
			void expect(rows[0].value).to.equal('single');
		});

		it('should commit implicit transaction on partial consumption (break)', async () => {
			// Setup: create table with multiple rows
			await db.exec('CREATE TABLE partial_test (id INTEGER PRIMARY KEY, value INTEGER)');
			await db.exec('INSERT INTO partial_test VALUES (1, 10), (2, 20), (3, 30)');

			// Partially consume the iterator with an INSERT that creates a new row
			for await (const row of db.eval(`
				INSERT INTO partial_test VALUES (4, 40);
				SELECT * FROM partial_test ORDER BY id;
			`)) {
				// Break after first row - early termination
				if (row.id === 1) break;
			}

			// The INSERT should still be committed despite early termination
			const rows: ResultRow[] = [];
			for await (const row of db.eval('SELECT * FROM partial_test ORDER BY id')) {
				rows.push(row);
			}

			void expect(rows).to.have.length(4);
			void expect(rows[3].id).to.equal(4);
			void expect(rows[3].value).to.equal(40);
		});

		it('should commit implicit transaction when iterator.return() is called', async () => {
			await db.exec('CREATE TABLE return_test (id INTEGER PRIMARY KEY, value INTEGER)');
			await db.exec('INSERT INTO return_test VALUES (1, 10)');

			// Get the iterator directly
			const iterator = db.eval(`
				INSERT INTO return_test VALUES (2, 20);
				SELECT * FROM return_test ORDER BY id;
			`);

			// Consume one row
			await iterator.next();

			// Explicitly call return() to signal early termination
			await iterator.return!(undefined);

			// The INSERT should still be committed
			const rows: ResultRow[] = [];
			for await (const row of db.eval('SELECT * FROM return_test ORDER BY id')) {
				rows.push(row);
			}

			void expect(rows).to.have.length(2);
			void expect(rows[1].id).to.equal(2);
		});

		it('should rollback implicit transaction when iterator.throw() is called', async () => {
			await db.exec('CREATE TABLE throw_test (id INTEGER PRIMARY KEY, value INTEGER)');
			await db.exec('INSERT INTO throw_test VALUES (1, 10)');

			// Get the iterator directly
			const iterator = db.eval(`
				INSERT INTO throw_test VALUES (2, 20);
				SELECT * FROM throw_test ORDER BY id;
			`);

			// Consume one row to start the iteration
			await iterator.next();

			// Call throw() to signal an error during iteration
			try {
				await iterator.throw!(new Error('Test error'));
			} catch {
				// Expected to throw
			}

			// The INSERT should be rolled back
			const rows: ResultRow[] = [];
			for await (const row of db.eval('SELECT * FROM throw_test ORDER BY id')) {
				rows.push(row);
			}

			void expect(rows).to.have.length(1);
			void expect(rows[0].id).to.equal(1);
		});

		it('should handle multiple partial consumptions in sequence', async () => {
			await db.exec('CREATE TABLE sequence_test (id INTEGER PRIMARY KEY, value INTEGER)');

			// First partial consumption
			for await (const _row of db.eval(`
				INSERT INTO sequence_test VALUES (1, 10);
				SELECT 1;
			`)) {
				break;
			}

			// Second partial consumption - should work fine with proper cleanup
			for await (const _row of db.eval(`
				INSERT INTO sequence_test VALUES (2, 20);
				SELECT 1;
			`)) {
				break;
			}

			// Both INSERTs should be committed
			const rows: ResultRow[] = [];
			for await (const row of db.eval('SELECT * FROM sequence_test ORDER BY id')) {
				rows.push(row);
			}

			void expect(rows).to.have.length(2);
		});
	});
});

