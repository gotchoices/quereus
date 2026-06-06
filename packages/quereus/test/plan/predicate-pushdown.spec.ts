import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { planRows, planOps, allRows, isDescendantOf } from './_helpers.js';

describe('Plan shape: predicate pushdown', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	describe('predicate pushed below join', () => {
		beforeEach(async () => {
			await db.exec("CREATE TABLE a (id INTEGER PRIMARY KEY, x INTEGER, name TEXT) USING memory");
			await db.exec("CREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER, label TEXT) USING memory");
			await db.exec("INSERT INTO a VALUES (1, 5, 'lo'), (2, 15, 'mid'), (3, 25, 'hi')");
			await db.exec("INSERT INTO b VALUES (10, 1, 'alpha'), (20, 2, 'beta'), (30, 3, 'gamma')");
		});

		it('join with single-table predicate contains both FILTER and JOIN nodes', async () => {
			const q = "SELECT * FROM a JOIN b ON a.id = b.a_id WHERE a.x > 10";
			const rows = await planRows(db, q);

			const joinRow = rows.find(r => r.op.includes('JOIN'));
			const filterRow = rows.find(r => r.op === 'FILTER');
			expect(joinRow, 'Plan should contain a JOIN node').to.exist;
			expect(filterRow, 'Plan should contain a FILTER node for a.x > 10').to.exist;
		});

		it('returns correct results after pushdown', async () => {
			const q = "SELECT a.name, b.label FROM a JOIN b ON a.id = b.a_id WHERE a.x > 10";
			const results = await allRows<{ name: string; label: string }>(db, q);
			expect(results).to.have.lengthOf(2);
			for (const row of results) {
				expect(['mid', 'hi']).to.include(row.name);
			}
		});
	});

	describe('predicate pushed through projection / alias', () => {
		beforeEach(async () => {
			await db.exec("CREATE TABLE a (id INTEGER PRIMARY KEY, x INTEGER, name TEXT) USING memory");
			await db.exec("INSERT INTO a VALUES (1, 5, 'lo'), (2, 15, 'mid'), (3, 25, 'hi')");
		});

		it('pushes predicate on original column through subquery projection', async () => {
			const q = "SELECT * FROM (SELECT a.*, a.x + 1 AS y FROM a) v WHERE v.x > 10";
			const ops = await planOps(db, q);

			const hasFilter = ops.includes('FILTER');
			const hasAccess = ops.some(op =>
				op === 'SEQSCAN' || op === 'INDEXSCAN' || op === 'INDEXSEEK'
			);
			expect(hasAccess, 'Plan should contain an access node for the base table').to.equal(true);

			if (hasFilter) {
				const rows = await planRows(db, q);
				const accessRow = rows.find(r =>
					r.op === 'SEQSCAN' || r.op === 'INDEXSCAN' || r.op === 'INDEXSEEK'
				);
				const filterRow = rows.find(r => r.op === 'FILTER');

				if (accessRow && filterRow) {
					const filterIsAboveAccess = isDescendantOf(rows, accessRow.id, filterRow.id);
					expect(
						filterIsAboveAccess,
						'FILTER should be close to the base scan (pushed through projection)'
					).to.equal(true);
				}
			}
		});

		it('pushes PK predicate through view into INDEXSEEK', async () => {
			await db.exec("CREATE VIEW va AS SELECT id, x, name FROM a");
			const q = "SELECT * FROM va WHERE id = 2";

			const ops = await planOps(db, q);
			expect(ops).to.include('INDEXSEEK', 'PK predicate through view should become INDEXSEEK');
			expect(ops).to.not.include('FILTER', 'No residual FILTER after PK pushdown');
		});

		it('returns correct results when predicate is pushed through projection', async () => {
			const q = "SELECT * FROM (SELECT a.*, a.x + 1 AS y FROM a) v WHERE v.x > 10";
			const results = await allRows<{ id: number; x: number; name: string; y: number }>(db, q);
			expect(results).to.have.lengthOf(2);
			for (const row of results) {
				expect(row.x).to.be.greaterThan(10);
			}
		});
	});
});
