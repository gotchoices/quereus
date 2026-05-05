import { expect } from 'chai';
import { Database } from '../src/index.js';

describe('Statement Iterator Cleanup', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		// Create test table with data
		await db.exec('create table test_data (id integer primary key, value integer)');
		await db.exec('insert into test_data values (1, 100), (2, 200), (3, 300), (4, 400), (5, 500)');
	});

	afterEach(async () => {
		await db.close();
	});

	describe('Statement.all()', () => {
		it('should commit transaction on normal completion', async () => {
			const stmt = db.prepare('select * from test_data');
			const results: Record<string, unknown>[] = [];

			for await (const row of stmt.all()) {
				results.push(row);
			}

			expect(results).to.have.length(5);
			// Verify transaction was committed (no transaction should be active)
			expect(db._isImplicitTransaction()).to.be.false;
			await stmt.finalize();
		});

		it('should commit transaction on early exit', async () => {
			const stmt = db.prepare('select * from test_data');
			const results: Record<string, unknown>[] = [];

			for await (const row of stmt.all()) {
				results.push(row);
				if (results.length === 2) break; // Early exit
			}

			expect(results).to.have.length(2);
			// Verify transaction was committed despite early exit
			expect(db._isImplicitTransaction()).to.be.false;
			await stmt.finalize();
		});

		it('should rollback transaction on error during iteration', async () => {
			const stmt = db.prepare('select * from test_data');

			try {
				for await (const row of stmt.all()) {
					if (row.id === 3) {
						throw new Error('Test error');
					}
				}
				expect.fail('Should have thrown');
			} catch (err) {
				expect((err as Error).message).to.equal('Test error');
			}

			// Verify transaction was rolled back
			expect(db._isImplicitTransaction()).to.be.false;
			await stmt.finalize();
		});

		it('should allow concurrent statements after early exit releases mutex', async () => {
			const stmt1 = db.prepare('select * from test_data');
			const stmt2 = db.prepare('select count(*) as cnt from test_data');

			// Start iteration with stmt1 and exit early
			for await (const row of stmt1.all()) {
				if (row.id === 2) break;
			}

			// stmt2 should now be able to execute (mutex was released)
			const result = await stmt2.get();
			expect(result?.cnt).to.equal(5);

			await stmt1.finalize();
			await stmt2.finalize();
		});

		it('should handle multiple early exits without double-release', async () => {
			const stmt = db.prepare('select * from test_data');

			// First early exit
			for await (const row of stmt.all()) {
				if (row.id === 2) break;
			}

			await stmt.reset();

			// Second early exit
			for await (const row of stmt.all()) {
				if (row.id === 3) break;
			}

			// Should still work fine
			expect(db._isImplicitTransaction()).to.be.false;
			await stmt.finalize();
		});
	});

	describe('Statement.iterateRows()', () => {
		it('should commit transaction on normal completion', async () => {
			const stmt = db.prepare('select * from test_data');
			const results: unknown[] = [];

			for await (const row of stmt.iterateRows()) {
				results.push(row);
			}

			expect(results).to.have.length(5);
			expect(db._isImplicitTransaction()).to.be.false;
			await stmt.finalize();
		});

		it('should commit transaction on early exit', async () => {
			const stmt = db.prepare('select * from test_data');
			const results: unknown[] = [];

			for await (const row of stmt.iterateRows()) {
				results.push(row);
				if (results.length === 2) break;
			}

			expect(results).to.have.length(2);
			// Verify transaction was committed despite early exit
			expect(db._isImplicitTransaction()).to.be.false;
			await stmt.finalize();
		});

		it('should rollback transaction on error during iteration', async () => {
			const stmt = db.prepare('select * from test_data');
			let count = 0;

			try {
				for await (const row of stmt.iterateRows()) {
					count++;
					if (Array.isArray(row) && row[0] === 3) {
						throw new Error('Test error');
					}
				}
				expect.fail('Should have thrown');
			} catch (err) {
				expect((err as Error).message).to.equal('Test error');
			}

			expect(count).to.equal(3);
			expect(db._isImplicitTransaction()).to.be.false;
			await stmt.finalize();
		});
	});

	describe('Database.eval()', () => {
		it('should commit transaction on early exit', async () => {
			const results: Record<string, unknown>[] = [];

			for await (const row of db.eval('select * from test_data')) {
				results.push(row);
				if (results.length === 2) break;
			}

			expect(results).to.have.length(2);
			expect(db._isImplicitTransaction()).to.be.false;
		});

		it('should rollback transaction on error', async () => {
			try {
				for await (const row of db.eval('select * from test_data')) {
					if (row.id === 3) {
						throw new Error('Test error');
					}
				}
				expect.fail('Should have thrown');
			} catch (err) {
				expect((err as Error).message).to.equal('Test error');
			}

			expect(db._isImplicitTransaction()).to.be.false;
		});
	});

	describe('Transaction behavior with mutations', () => {
		it('should commit mutations on normal completion', async () => {
			const stmt = db.prepare('insert into test_data values (?, ?)');
			await stmt.run([10, 1000]);

			// Verify mutation was committed
			const result = await db.get('select count(*) as cnt from test_data');
			expect(result?.cnt).to.equal(6);
			await stmt.finalize();
		});

		it('should commit read-only query on early exit', async () => {
			// Verify that a SELECT query with early exit still commits
			// (important for implicit transactions started by reads)
			const stmt = db.prepare('select * from test_data');
			const results: Record<string, unknown>[] = [];

			for await (const row of stmt.all()) {
				results.push(row);
				if (results.length === 2) break;
			}

			expect(results).to.have.length(2);
			expect(db._isImplicitTransaction()).to.be.false;
			await stmt.finalize();
		});

		it('should rollback implicit transaction on error during iteration', async () => {
			const initialCount = await db.get('select count(*) as cnt from test_data');
			expect(initialCount?.cnt).to.equal(5);

			// Use eval() which handles transaction + mutex together
			// An error during iteration should rollback
			try {
				for await (const row of db.eval('select * from test_data')) {
					if (row.id === 3) {
						throw new Error('Test error');
					}
				}
				expect.fail('Should have thrown');
			} catch (err) {
				expect((err as Error).message).to.equal('Test error');
			}

			// Implicit transaction was rolled back, data should be unaffected
			expect(db._isImplicitTransaction()).to.be.false;
			const finalCount = await db.get('select count(*) as cnt from test_data');
			expect(finalCount?.cnt).to.equal(5);
		});
	});

	describe('Edge cases', () => {
		it('should handle empty result set', async () => {
			const stmt = db.prepare('select * from test_data where id > 1000');
			const results: Record<string, unknown>[] = [];

			for await (const row of stmt.all()) {
				results.push(row);
			}

			expect(results).to.have.length(0);
			expect(db._isImplicitTransaction()).to.be.false;
			await stmt.finalize();
		});

		it('should handle immediate break', async () => {
			const stmt = db.prepare('select * from test_data');

			// Break immediately without consuming any rows
			for await (const _row of stmt.all()) {
				break;
			}

			expect(db._isImplicitTransaction()).to.be.false;
			await stmt.finalize();
		});

		it('should handle iterator return() directly', async () => {
			const stmt = db.prepare('select * from test_data');
			const iterator = stmt.all();

			// Consume one value
			const first = await iterator.next();
			expect(first.done).to.be.false;

			// Call return() explicitly
			const returnResult = await iterator.return();
			expect(returnResult.done).to.be.true;

			// Transaction should be committed
			expect(db._isImplicitTransaction()).to.be.false;
			await stmt.finalize();
		});

		it('should handle iterator throw() directly', async () => {
			const stmt = db.prepare('select * from test_data');
			const iterator = stmt.all();

			// Consume one value
			const first = await iterator.next();
			expect(first.done).to.be.false;

			// Call throw() explicitly
			try {
				await iterator.throw(new Error('Direct throw'));
				expect.fail('Should have thrown');
			} catch (err) {
				expect((err as Error).message).to.equal('Direct throw');
			}

			// Transaction should be rolled back
			expect(db._isImplicitTransaction()).to.be.false;
			await stmt.finalize();
		});
	});
});
