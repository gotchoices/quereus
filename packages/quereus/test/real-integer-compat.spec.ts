import { expect } from 'chai';
import { Database } from '../src/index.js';
import type { SqlValue } from '../src/common/types.js';

type ResultRow = Record<string, SqlValue>;

describe('INTEGER to REAL compatibility fix', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, value REAL)');
	});

	afterEach(async () => {
		await db.close();
	});

	it('should accept integer values for REAL parameters', async () => {
		// Prepare statement with REAL parameter
		const stmt = db.prepare('INSERT INTO test (id, value) VALUES (?, ?)', [1, 1.5]);

		// Should accept integer value 100 for REAL column
		await stmt.run([1, 100]);

		// Should accept integer value 1 for REAL column
		await stmt.run([2, 1]);

		// Should accept actual float value
		await stmt.run([3, 3.14]);

		await stmt.finalize();

		// Verify all rows were inserted
		const rows: ResultRow[] = [];
		for await (const row of db.eval('SELECT * FROM test ORDER BY id')) {
			rows.push(row);
		}
		expect(rows).to.have.length(3);
		expect(rows[0].value).to.equal(100);
		expect(rows[1].value).to.equal(1);
		expect(rows[2].value).to.equal(3.14);
	});

	it('should accept integer values in REAL parameter queries', async () => {
		await db.exec('INSERT INTO test VALUES (1, 100), (2, 50.5), (3, 25)');

		// Prepare with REAL parameter
		const stmt = db.prepare('SELECT * FROM test WHERE value > ?', [1.5]);

		// Should work with integer value 40
		const rows: ResultRow[] = [];
		for await (const row of stmt.all([40])) {
			rows.push(row);
		}

		expect(rows).to.have.length(2); // 100 and 50.5

		await stmt.finalize();
	});

	it('should still reject REAL values for INTEGER parameters', async () => {
		// Prepare with INTEGER parameter
		const stmt = db.prepare('SELECT * FROM test WHERE id = ?', [1]);

		// Should reject float value
		let error: Error | undefined;
		try {
			await stmt.get([3.14]);
		} catch (e) {
			error = e as Error;
		}

		expect(error).to.exist;
		expect(error!.message).to.include('Parameter type mismatch');
		expect(error!.message).to.include('expected INTEGER');
		expect(error!.message).to.include('REAL');

		await stmt.finalize();
	});
});
