import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { planNodeTypes, allRows } from './_helpers.js';

describe('Plan shape: constant folding', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	describe('literal arithmetic folding', () => {
		it('folds 1 + 1 to a literal (no BinaryOp in plan)', async () => {
			const q = "SELECT 1 + 1 AS val";
			const types = await planNodeTypes(db, q);

			expect(types).to.not.include('BinaryOp',
				'Literal arithmetic should be folded away — no BinaryOp node');
		});

		it('produces correct result for folded arithmetic', async () => {
			const results = await allRows<{ val: number }>(db, "SELECT 1 + 1 AS val");
			expect(results).to.deep.equal([{ val: 2 }]);
		});

		it('folds complex literal expressions', async () => {
			const q = "SELECT (2 * 3) + (4 - 1) AS val";
			const types = await planNodeTypes(db, q);

			expect(types).to.not.include('BinaryOp',
				'Complex literal arithmetic should be fully folded');

			const results = await allRows<{ val: number }>(db, "SELECT (2 * 3) + (4 - 1) AS val");
			expect(results).to.deep.equal([{ val: 9 }]);
		});
	});

	describe('constant predicate folding', () => {
		it('folds WHERE 1 = 1 (tautology) — predicate folded to literal true', async () => {
			await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT) USING memory");
			await db.exec("INSERT INTO t VALUES (1, 'a'), (2, 'b')");

			const q = "SELECT * FROM t WHERE 1 = 1";
			const types = await planNodeTypes(db, q);

			expect(types).to.not.include('BinaryOp',
				'1 = 1 should be folded to a literal (no BinaryOp)');

			const results = await allRows<{ id: number; val: string }>(db, q);
			expect(results).to.have.lengthOf(2);
		});

		it('folds WHERE 1 = 0 (contradiction) into EmptyResult or zero rows', async () => {
			await db.exec("CREATE TABLE t2 (id INTEGER PRIMARY KEY, val TEXT) USING memory");
			await db.exec("INSERT INTO t2 VALUES (1, 'x')");

			const q = "SELECT * FROM t2 WHERE 1 = 0";
			const results = await allRows<{ id: number; val: string }>(db, q);
			expect(results).to.have.lengthOf(0);
		});
	});

	describe('constant VALUES folding', () => {
		it('folds all-literal VALUES into TableLiteral', async () => {
			const q = "SELECT id FROM (VALUES (1, 'a'), (2, 'b')) AS t(id, name)";
			const types = await planNodeTypes(db, q);

			expect(types).to.include('TableLiteral',
				'All-literal VALUES should be folded to TableLiteral');
			expect(types).to.not.include('Values',
				'Original Values node should be replaced');
		});

		it('folds VALUES with expressions', async () => {
			const q = "SELECT x FROM (VALUES (1 + 1), (2 * 3)) AS t(x)";
			const types = await planNodeTypes(db, q);

			expect(types).to.include('TableLiteral');

			const results = await allRows<{ x: number }>(db, q);
			expect(results).to.deep.equal([{ x: 2 }, { x: 6 }]);
		});
	});

	describe('function folding', () => {
		it('folds deterministic function of literals', async () => {
			const q = "SELECT abs(-5) AS val";
			const types = await planNodeTypes(db, q);

			expect(types).to.not.include('ScalarFunctionCall',
				'Deterministic function of literals should be folded');

			const results = await allRows<{ val: number }>(db, q);
			expect(results).to.deep.equal([{ val: 5 }]);
		});

		it('does NOT fold non-deterministic functions', async () => {
			const q = "SELECT random() AS val";
			const results = await allRows<{ val: unknown }>(db, q);
			expect(results).to.have.lengthOf(1);
			expect(results[0].val).to.not.be.null;
		});
	});

	describe('constant folding does not affect row-dependent expressions', () => {
		it('preserves non-constant expressions involving columns', async () => {
			await db.exec("CREATE TABLE nums (id INTEGER PRIMARY KEY, v INTEGER) USING memory");
			await db.exec("INSERT INTO nums VALUES (1, 10), (2, 20)");

			const q = "SELECT v + 1 AS inc FROM nums ORDER BY id";
			const results = await allRows<{ inc: number }>(db, q);
			expect(results).to.deep.equal([{ inc: 11 }, { inc: 21 }]);
		});
	});
});
