import { expect } from 'chai';
import { Database } from '../../src/core/database.js';

describe('Relational constant folding', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	async function getNodeTypes(sql: string): Promise<string[]> {
		const types: string[] = [];
		for await (const r of db.eval("SELECT node_type FROM query_plan(?)", [sql])) {
			types.push((r as { node_type: string }).node_type);
		}
		return types;
	}

	it('folds all-literal VALUES into TableLiteral', async () => {
		const sql = "SELECT id FROM (VALUES (1, 'a'), (2, 'b')) AS t(id, name)";
		const types = await getNodeTypes(sql);

		expect(types).to.include('TableLiteral');
		expect(types).to.not.include('Values');
	});

	it('folds constant subquery into TableLiteral', async () => {
		const sql = "SELECT * FROM (SELECT 1 + 2 AS x, 'hello' AS y)";
		const types = await getNodeTypes(sql);

		expect(types).to.include('TableLiteral');
	});

	it('does NOT fold table references', async () => {
		await db.exec("CREATE TABLE t1 (id INTEGER PRIMARY KEY, v TEXT) USING memory");
		await db.exec("INSERT INTO t1 VALUES (1, 'a')");

		const sql = "SELECT * FROM t1";
		const types = await getNodeTypes(sql);

		expect(types).to.not.include('TableLiteral');
	});

	it('preserves attribute IDs after relational folding', async () => {
		// This query should fold the inner VALUES and the outer projection
		// should still correctly reference the folded columns
		const sql = "SELECT id, name FROM (VALUES (1, 'a'), (2, 'b')) AS t(id, name) WHERE id = 1";
		const rows = [];
		for await (const r of db.eval(sql)) {
			rows.push(r);
		}

		expect(rows).to.deep.equal([{ id: 1, name: 'a' }]);
	});

	it('folds constant VALUES with expressions', async () => {
		const sql = "SELECT x FROM (VALUES (1 + 1), (2 * 3)) AS t(x)";
		const types = await getNodeTypes(sql);

		expect(types).to.include('TableLiteral');

		const rows = [];
		for await (const r of db.eval(sql)) {
			rows.push(r);
		}
		expect(rows).to.deep.equal([{ x: 2 }, { x: 6 }]);
	});

	it('produces correct results on repeated execution', async () => {
		const sql = "SELECT a FROM (VALUES (10), (20), (30)) AS t(a)";

		for (let i = 0; i < 3; i++) {
			const rows = [];
			for await (const r of db.eval(sql)) {
				rows.push(r);
			}
			expect(rows).to.deep.equal([{ a: 10 }, { a: 20 }, { a: 30 }]);
		}
	});
});
