import { expect } from 'chai';
import { Database } from '../../src/core/database.js';

describe('Hash aggregate operator', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, grp TEXT, val INTEGER NULL) USING memory");
		await db.exec("INSERT INTO t VALUES (1,'a',10),(2,'b',20),(3,'a',30),(4,'b',40),(5,'c',50),(6,'a',null)");
	});

	afterEach(async () => {
		await db.close();
	});

	async function queryPlanOps(sql: string): Promise<string[]> {
		const ops: string[] = [];
		for await (const r of db.eval("SELECT op FROM query_plan(?)", [sql])) {
			ops.push((r as { op: string }).op);
		}
		return ops;
	}

	async function allRows<T>(sql: string): Promise<T[]> {
		const rows: T[] = [];
		for await (const r of db.eval(sql)) {
			rows.push(r as T);
		}
		return rows;
	}

	it('uses HashAggregate for unsorted GROUP BY', async () => {
		const sql = "SELECT grp, count(*) as cnt FROM t GROUP BY grp";
		const ops = await queryPlanOps(sql);
		expect(ops).to.include('HASHAGGREGATE');
		expect(ops).not.to.include('SORT');
	});

	it('uses StreamAggregate (not Hash) for scalar aggregate without GROUP BY', async () => {
		const sql = "SELECT count(*), sum(val) FROM t";
		const ops = await queryPlanOps(sql);
		expect(ops).to.include('STREAMAGGREGATE');
		expect(ops).not.to.include('HASHAGGREGATE');
	});

	it('uses StreamAggregate when input is already sorted by GROUP BY columns', async () => {
		const sql = "SELECT id, count(*) AS c FROM (SELECT * FROM t ORDER BY id LIMIT 100) s GROUP BY id";
		const ops = await queryPlanOps(sql);
		expect(ops).to.include('STREAMAGGREGATE');
		expect(ops).not.to.include('HASHAGGREGATE');
	});

	it('produces correct results with GROUP BY', async () => {
		const rows = await allRows<{ grp: string; cnt: number; total: number | null }>(
			"SELECT grp, count(*) as cnt, sum(val) as total FROM t GROUP BY grp ORDER BY grp"
		);
		expect(rows).to.deep.equal([
			{ grp: 'a', cnt: 3, total: 40 },
			{ grp: 'b', cnt: 2, total: 60 },
			{ grp: 'c', cnt: 1, total: 50 },
		]);
	});

	it('groups NULLs together per SQL standard', async () => {
		await db.exec("CREATE TABLE tn (id INTEGER PRIMARY KEY, grp TEXT NULL, val INTEGER) USING memory");
		await db.exec("INSERT INTO tn VALUES (1,'a',10),(2,null,20),(3,'a',30),(4,null,40),(5,'b',50)");

		const rows = await allRows<{ grp: string | null; cnt: number }>(
			"SELECT grp, count(*) as cnt FROM tn GROUP BY grp ORDER BY grp NULLS FIRST"
		);
		expect(rows).to.deep.equal([
			{ grp: null, cnt: 2 },
			{ grp: 'a', cnt: 2 },
			{ grp: 'b', cnt: 1 },
		]);
	});

	it('supports COUNT(DISTINCT)', async () => {
		const rows = await allRows<{ grp: string; cd: number }>(
			"SELECT grp, count(distinct val) as cd FROM t GROUP BY grp ORDER BY grp"
		);
		expect(rows).to.deep.equal([
			{ grp: 'a', cd: 2 },
			{ grp: 'b', cd: 2 },
			{ grp: 'c', cd: 1 },
		]);
	});

	it('supports HAVING clause', async () => {
		const rows = await allRows<{ grp: string; total: number }>(
			"SELECT grp, sum(val) as total FROM t GROUP BY grp HAVING total > 40 ORDER BY grp"
		);
		expect(rows).to.deep.equal([
			{ grp: 'b', total: 60 },
			{ grp: 'c', total: 50 },
		]);
	});

	it('supports multiple aggregate functions', async () => {
		const rows = await allRows<{ grp: string; cnt: number; total: number | null; mx: number | null }>(
			"SELECT grp, count(*) as cnt, sum(val) as total, max(val) as mx FROM t GROUP BY grp ORDER BY grp"
		);
		expect(rows).to.have.lengthOf(3);
		expect(rows[0]).to.deep.equal({ grp: 'a', cnt: 3, total: 40, mx: 30 });
	});

	it('returns no rows for empty table with GROUP BY', async () => {
		await db.exec("CREATE TABLE empty (id INTEGER PRIMARY KEY, grp TEXT, val INTEGER) USING memory");
		const rows = await allRows("SELECT grp, count(*) as cnt FROM empty GROUP BY grp");
		expect(rows).to.deep.equal([]);
	});

	it('supports GROUP BY on multiple columns', async () => {
		await db.exec("CREATE TABLE t2 (id INTEGER PRIMARY KEY, a TEXT, b TEXT, val INTEGER) USING memory");
		await db.exec("INSERT INTO t2 VALUES (1,'x','p',1),(2,'x','q',2),(3,'y','p',3),(4,'x','p',4)");

		const rows = await allRows<{ a: string; b: string; total: number }>(
			"SELECT a, b, sum(val) as total FROM t2 GROUP BY a, b ORDER BY a, b"
		);
		expect(rows).to.deep.equal([
			{ a: 'x', b: 'p', total: 5 },
			{ a: 'x', b: 'q', total: 2 },
			{ a: 'y', b: 'p', total: 3 },
		]);
	});

	it('respects NOCASE collation for grouping', async () => {
		await db.exec("CREATE TABLE tc (id INTEGER PRIMARY KEY, grp TEXT COLLATE NOCASE, val INTEGER) USING memory");
		await db.exec("INSERT INTO tc VALUES (1,'Foo',10),(2,'foo',20),(3,'BAR',30),(4,'bar',40)");

		const rows = await allRows<{ grp: string; total: number }>(
			"SELECT grp, sum(val) as total FROM tc GROUP BY grp ORDER BY grp"
		);
		// NOCASE should collapse Foo/foo and BAR/bar into single groups
		expect(rows).to.have.lengthOf(2);
		const totals = rows.map(r => r.total);
		expect(totals).to.include(30); // Foo+foo = 10+20
		expect(totals).to.include(70); // BAR+bar = 30+40
	});

	it('HashAggregate does not preserve ordering (no ordering property)', async () => {
		const sql = "SELECT grp, count(*) as cnt FROM t GROUP BY grp";
		const physicals: string[] = [];
		for await (const r of db.eval("SELECT physical FROM query_plan(?) WHERE op = 'HASHAGGREGATE'", [sql])) {
			physicals.push((r as { physical: string }).physical);
		}

		expect(physicals).to.have.lengthOf(1);
		const physical = JSON.parse(physicals[0]);
		// Hash aggregate should not have ordering defined
		expect(physical.ordering).to.equal(undefined);
	});
});
