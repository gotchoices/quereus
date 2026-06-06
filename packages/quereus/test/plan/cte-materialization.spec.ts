import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { planOps, allRows } from './_helpers.js';

describe('Plan shape: CTE materialization', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, val INTEGER) USING memory");
		await db.exec("INSERT INTO items VALUES (1, 10), (2, 20), (3, 30), (4, 40)");
	});

	afterEach(async () => {
		await db.close();
	});

	describe('single-reference CTE should be inlined', () => {
		it('does not produce a CACHE node for single-use CTE', async () => {
			const q = "WITH cte AS (SELECT id, val FROM items WHERE val >= 20) SELECT * FROM cte";
			const ops = await planOps(db, q);

			expect(ops).to.not.include('CACHE',
				'Single-reference CTE should be inlined, not materialized/cached');
			expect(ops).to.include('CTEREFERENCE',
				'Should still contain a CTE reference node');
		});

		it('produces correct results for inlined CTE', async () => {
			const q = "WITH cte AS (SELECT id, val FROM items WHERE val >= 20) SELECT * FROM cte ORDER BY id";
			const results = await allRows<{ id: number; val: number }>(db, q);
			expect(results).to.deep.equal([
				{ id: 2, val: 20 },
				{ id: 3, val: 30 },
				{ id: 4, val: 40 },
			]);
		});
	});

	describe('multi-reference CTE may be materialized', () => {
		it('contains multiple CTE references for multi-use CTE', async () => {
			const q = `
				WITH cte AS (SELECT id, val FROM items)
				SELECT c1.id, c2.val
				FROM cte c1 JOIN cte c2 ON c1.id = c2.id
			`;
			const ops = await planOps(db, q);

			const cteRefCount = ops.filter(op => op === 'CTEREFERENCE').length;
			expect(cteRefCount).to.equal(2, 'Should have two CTE reference nodes');
			expect(ops.some(op => op.includes('JOIN')),
				'Multi-use CTE with self-join should contain a JOIN'
			).to.equal(true);
		});

		it('produces correct results for multi-reference CTE', async () => {
			const q = `
				WITH cte AS (SELECT id, val FROM items)
				SELECT c1.id, c2.val
				FROM cte c1 JOIN cte c2 ON c1.id = c2.id
				ORDER BY c1.id
			`;
			const results = await allRows<{ id: number; val: number }>(db, q);
			expect(results).to.have.lengthOf(4);
			expect(results[0]).to.deep.equal({ id: 1, val: 10 });
			expect(results[3]).to.deep.equal({ id: 4, val: 40 });
		});
	});

	describe('recursive CTE structure', () => {
		it('produces a RECURSIVECTE plan node', async () => {
			const q = `
				WITH RECURSIVE cnt(x) AS (
					SELECT 1
					UNION ALL
					SELECT x + 1 FROM cnt WHERE x < 5
				)
				SELECT x FROM cnt ORDER BY x
			`;
			const ops = await planOps(db, q);

			expect(ops).to.include('RECURSIVECTE',
				'Recursive CTE should produce a RECURSIVECTE node');
		});

		it('produces correct sequence from recursive CTE', async () => {
			const q = `
				WITH RECURSIVE cnt(x) AS (
					SELECT 1
					UNION ALL
					SELECT x + 1 FROM cnt WHERE x < 5
				)
				SELECT x FROM cnt ORDER BY x
			`;
			const results = await allRows<{ x: number }>(db, q);
			expect(results.map(r => r.x)).to.deep.equal([1, 2, 3, 4, 5]);
		});
	});
});
