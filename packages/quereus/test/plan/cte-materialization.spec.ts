import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { PlanNode } from '../../src/planner/nodes/plan-node.js';
import { CTENode } from '../../src/planner/nodes/cte-node.js';
import { CTEReferenceNode } from '../../src/planner/nodes/cte-reference-node.js';
import { planOps, allRows } from './_helpers.js';

/** Collect every CTEReferenceNode in an optimized plan tree (deduped by identity). */
function collectCTERefs(root: PlanNode): CTEReferenceNode[] {
	const out: CTEReferenceNode[] = [];
	const seen = new Set<PlanNode>();
	const walk = (node: PlanNode): void => {
		if (seen.has(node)) return;
		seen.add(node);
		if (node instanceof CTEReferenceNode) out.push(node);
		for (const child of node.getChildren()) walk(child);
	};
	walk(root);
	return out;
}

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

	describe('materialize mark (shared per-execution buffer)', () => {
		it('marks a 2-reference CTE materialize and keeps one shared CTENode instance', () => {
			const plan = db.getPlan(`
				WITH cte AS (SELECT id, val FROM items)
				SELECT c1.id, c2.val
				FROM cte c1 JOIN cte c2 ON c1.id = c2.id
			`);
			const refs = collectCTERefs(plan);
			expect(refs).to.have.lengthOf(2, 'expected two CTE references');
			// The runtime buffer is keyed by the CTENode's plan id — if the two
			// references ever diverge onto distinct instances, the key no longer
			// matches and the CTE silently re-executes per reference.
			expect(refs[0].source, 'both references must share ONE CTENode instance').to.equal(refs[1].source);
			expect(refs[0].source).to.be.instanceOf(CTENode);
			expect((refs[0].source as CTENode).materialize, 'multi-reference CTE must be marked materialize').to.equal(true);
		});

		it('does not mark a single-reference un-hinted CTE', () => {
			const plan = db.getPlan('WITH cte AS (SELECT id, val FROM items) SELECT * FROM cte');
			const refs = collectCTERefs(plan);
			expect(refs).to.have.lengthOf(1);
			expect((refs[0].source as CTENode).materialize, 'single-ref CTE keeps the streaming path').to.equal(false);
		});

		it('marks an explicitly MATERIALIZED single-reference CTE', () => {
			const plan = db.getPlan('WITH cte AS MATERIALIZED (SELECT id, val FROM items) SELECT * FROM cte');
			const refs = collectCTERefs(plan);
			expect(refs).to.have.lengthOf(1);
			expect((refs[0].source as CTENode).materialize, 'MATERIALIZED hint forces the mark').to.equal(true);
		});

		it('honors NOT MATERIALIZED on a 2-reference CTE', () => {
			const plan = db.getPlan(`
				WITH cte AS NOT MATERIALIZED (SELECT id, val FROM items)
				SELECT c1.id, c2.val
				FROM cte c1 JOIN cte c2 ON c1.id = c2.id
			`);
			const refs = collectCTERefs(plan);
			expect(refs).to.have.lengthOf(2);
			for (const ref of refs) {
				expect((ref.source as CTENode).materialize,
					'explicit NOT MATERIALIZED opts out of the shared buffer').to.equal(false);
			}
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

		it('never marks a recursive CTE for shared materialization, even when referenced twice', () => {
			// Recursive CTEs run through the working-table machinery
			// (RecursiveCTENode → emitRecursiveCTE), not emitCTE — the shared
			// per-execution buffer mark must not touch them.
			// NOTE: executing this double-reference query currently fails with
			// "exceeded maximum iteration limit" — a pre-existing defect present
			// before shared CTE materialization landed; see the fix ticket
			// bug-recursive-cte-double-reference-runaway. Once fixed, extend this
			// test to assert the query's results as well.
			const plan = db.getPlan(`
				WITH RECURSIVE cnt(x) AS (
					SELECT 1
					UNION ALL
					SELECT x + 1 FROM cnt WHERE x < 3
				)
				SELECT a.x AS ax, b.x AS bx
				FROM cnt a JOIN cnt b ON a.x = b.x
			`);
			const refs = collectCTERefs(plan);
			expect(refs).to.have.lengthOf(2, 'expected two references to the recursive CTE');
			for (const ref of refs) {
				expect(ref.source, 'recursive CTE must not be rewritten into a marked CTENode')
					.to.not.be.instanceOf(CTENode);
			}
		});
	});
});
