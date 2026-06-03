/**
 * Regression: the IN multi-seek (plan=5) must advertise an honest `inCount` —
 * the number of seeks the runtime actually performs — not the raw literal-list
 * length. Duplicate and NULL literals contribute no extra seeks (the runtime
 * scan-layer dedups by primary key and skips NULL-bearing seek keys), so the
 * planner now collapses duplicate literals and drops NULLs when materializing
 * the literal IN list into the IndexSeekNode.
 *
 * These assertions read the `inCount=` token straight off the chosen
 * IndexSeekNode's `filterInfo.idxStr` (the string handed to xFilter), which is
 * where the lie used to live. The companion result-correctness coverage is in
 * `test/logic/07.9-in-value-list.sqllogic` and
 * `test/optimizer/secondary-index-access.spec.ts`.
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { PlanNode } from '../../src/planner/nodes/plan-node.js';
import { IndexSeekNode, EmptyResultNode } from '../../src/planner/nodes/table-access-nodes.js';

function collectNodes<T extends PlanNode>(
	root: PlanNode,
	predicate: (n: PlanNode) => n is T,
): T[] {
	const found: T[] = [];
	const walk = (n: PlanNode): void => {
		if (predicate(n)) found.push(n);
		for (const c of n.getChildren()) walk(c as PlanNode);
	};
	walk(root);
	return found;
}

const isIndexSeek = (n: PlanNode): n is IndexSeekNode => n instanceof IndexSeekNode;
const isEmptyResult = (n: PlanNode): n is EmptyResultNode => n instanceof EmptyResultNode;

describe('IN multi-seek inCount honesty (plan=5)', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	/** Optimize `sql` and return the single IN multi-seek node's `inCount`. */
	function inCountOf(sql: string): number {
		const seeks = collectNodes(db.getPlan(sql), isIndexSeek);
		expect(seeks, `expected exactly one IndexSeek for: ${sql}`).to.have.lengthOf(1);
		const idxStr = seeks[0].filterInfo.idxStr ?? '';
		const m = idxStr.match(/inCount=(\d+)/);
		expect(m, `idxStr should carry inCount: ${idxStr}`).to.not.be.null;
		return parseInt(m![1], 10);
	}

	describe('single-column IN', () => {
		beforeEach(async () => {
			await db.exec('CREATE TABLE u (id INTEGER PRIMARY KEY, v INTEGER UNIQUE) USING memory');
			await db.exec('INSERT INTO u VALUES (1, 5), (2, 7), (3, 9)');
		});

		it('distinct non-null list keeps its length', () => {
			expect(inCountOf('SELECT id FROM u WHERE v IN (5, 7, 9)')).to.equal(3);
		});

		it('duplicate literals collapse', () => {
			expect(inCountOf('SELECT id FROM u WHERE v IN (5, 5, 9)')).to.equal(2);
		});

		it('NULL literals drop', () => {
			expect(inCountOf('SELECT id FROM u WHERE v IN (5, null, 9)')).to.equal(2);
		});

		it('duplicates and NULLs together reduce to the distinct non-null count', () => {
			expect(inCountOf('SELECT id FROM u WHERE v IN (5, null, 5, 9)')).to.equal(2);
		});

		it('an all-duplicate list reduces to a single seek', () => {
			expect(inCountOf('SELECT id FROM u WHERE v IN (5, 5, 5)')).to.equal(1);
		});

		it('an all-NULL list becomes an empty result (no degraded full scan)', async () => {
			const root = db.getPlan('SELECT id FROM u WHERE v IN (null, null)');
			expect(collectNodes(root, isIndexSeek), 'no IndexSeek should remain').to.have.lengthOf(0);
			expect(collectNodes(root, isEmptyResult), 'should be an EmptyResult').to.have.lengthOf(1);

			const rows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval('SELECT id FROM u WHERE v IN (null, null)')) {
				rows.push(r as Record<string, unknown>);
			}
			expect(rows).to.deep.equal([]);
		});
	});

	describe('composite IN (cross-product)', () => {
		beforeEach(async () => {
			await db.exec('CREATE TABLE c (id INTEGER PRIMARY KEY, a INTEGER, b INTEGER) USING memory');
			await db.exec('CREATE INDEX idx_ab ON c(a, b)');
			await db.exec('INSERT INTO c VALUES (1, 1, 10), (2, 1, 20), (3, 2, 10), (4, 2, 20)');
		});

		it('drops NULL-bearing tuples and collapses duplicate tuples', () => {
			// a∈{1,1,2} × b∈{10,null} → {(1,10),(1,null),(2,10),(2,null)};
			// the NULL-bearing tuples drop and the (1,10) duplicate collapses → 2.
			expect(inCountOf('SELECT id FROM c WHERE a IN (1, 1, 2) AND b IN (10, null)')).to.equal(2);
		});

		it('full distinct cross-product keeps every tuple', () => {
			expect(inCountOf('SELECT id FROM c WHERE a IN (1, 2) AND b IN (10, 20)')).to.equal(4);
		});
	});
});
