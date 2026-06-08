import { expect } from 'chai';
import { Database } from '../../src/core/database.js';

describe('DESC index — ordering and access path selection', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it('uses DESC index for ORDER BY DESC without an explicit SORT', async () => {
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, score INTEGER) USING memory");
		await db.exec("INSERT INTO t VALUES (1, 30), (2, 10), (3, 50), (4, 20), (5, 40)");
		await db.exec("CREATE INDEX ix_t_score_desc ON t(score DESC)");

		const sql = "SELECT id, score FROM t ORDER BY score DESC";
		const sorts: Array<{ c: number }> = [];
		for await (const r of db.eval("SELECT COUNT(*) AS c FROM query_plan(?) WHERE op = 'SORT'", [sql])) {
			sorts.push(r as unknown as { c: number });
		}
		expect(sorts).to.have.lengthOf(1);
		expect(sorts[0].c, 'DESC index should satisfy ORDER BY DESC without an explicit SORT').to.equal(0);

		const rows: Array<{ id: number; score: number }> = [];
		for await (const r of db.eval(sql)) {
			rows.push(r as unknown as { id: number; score: number });
		}
		expect(rows.map(r => r.score)).to.deep.equal([50, 40, 30, 20, 10]);
	});

	it('uses DESC index for range filter combined with ORDER BY DESC', async () => {
		await db.exec("CREATE TABLE r (id INTEGER PRIMARY KEY, n INTEGER) USING memory");
		await db.exec("INSERT INTO r VALUES (1, 100), (2, 50), (3, 75), (4, 25), (5, 90)");
		await db.exec("CREATE INDEX ix_r_n_desc ON r(n DESC)");

		const sql = "SELECT n FROM r WHERE n >= 60 ORDER BY n DESC";
		const planRows: Array<{ ops: string }> = [];
		for await (const r of db.eval("SELECT json_group_array(op) AS ops FROM query_plan(?)", [sql])) {
			planRows.push(r as unknown as { ops: string });
		}
		expect(planRows).to.have.lengthOf(1);
		expect(planRows[0].ops).to.match(/INDEX(SEEK|SCAN| SEEK| SCAN)|IndexSeek|IndexScan/i);

		const rows: Array<{ n: number }> = [];
		for await (const r of db.eval(sql)) {
			rows.push(r as unknown as { n: number });
		}
		expect(rows.map(r => r.n)).to.deep.equal([100, 90, 75]);
	});

	it('inserts SORT when ORDER BY targets a multi-value IN column (unsorted IN list)', async () => {
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER) USING memory");
		await db.exec("INSERT INTO t VALUES (1, 10), (2, 20), (3, 30), (4, 40), (5, 50)");
		await db.exec("CREATE INDEX ix_t_n ON t(n)");

		const sql = "SELECT n FROM t WHERE n IN (40, 10, 30) ORDER BY n";
		const sorts: Array<{ c: number }> = [];
		for await (const r of db.eval("SELECT COUNT(*) AS c FROM query_plan(?) WHERE op = 'SORT'", [sql])) {
			sorts.push(r as unknown as { c: number });
		}
		expect(sorts).to.have.lengthOf(1);
		expect(sorts[0].c, 'multi-value IN multi-seek visits values in IN-list order; ORDER BY must be enforced by an explicit SORT').to.equal(1);

		const rows: Array<{ n: number }> = [];
		for await (const r of db.eval(sql)) {
			rows.push(r as unknown as { n: number });
		}
		expect(rows.map(r => r.n)).to.deep.equal([10, 30, 40]);
	});

	it('inserts SORT for composite multi-IN with ORDER BY on the IN column', async () => {
		await db.exec("CREATE TABLE e (id INTEGER PRIMARY KEY, category TEXT, year INTEGER) USING memory");
		await db.exec("INSERT INTO e VALUES (1, 'a', 2025), (2, 'a', 2024), (3, 'a', 2026)");
		await db.exec("CREATE INDEX ix_e ON e(category, year)");

		const sql = "SELECT year FROM e WHERE category = 'a' AND year IN (2025, 2024, 2026) ORDER BY year";
		const rows: Array<{ year: number }> = [];
		for await (const r of db.eval(sql)) {
			rows.push(r as unknown as { year: number });
		}
		expect(rows.map(r => r.year)).to.deep.equal([2024, 2025, 2026]);
	});

	it('uses composite (ASC, DESC) index for matching ORDER BY without SORT', async () => {
		await db.exec("CREATE TABLE m (id INTEGER PRIMARY KEY, category TEXT, score INTEGER) USING memory");
		await db.exec("INSERT INTO m VALUES (1, 'a', 10), (2, 'a', 30), (3, 'a', 20), (4, 'b', 5), (5, 'b', 25)");
		await db.exec("CREATE INDEX ix_m ON m(category ASC, score DESC)");

		const sql = "SELECT id, score FROM m WHERE category = 'a' ORDER BY score DESC";
		const sorts: Array<{ c: number }> = [];
		for await (const r of db.eval("SELECT COUNT(*) AS c FROM query_plan(?) WHERE op = 'SORT'", [sql])) {
			sorts.push(r as unknown as { c: number });
		}
		expect(sorts).to.have.lengthOf(1);
		expect(sorts[0].c, 'composite (ASC, DESC) index should satisfy equality on leading + DESC trailing without SORT').to.equal(0);

		const rows: Array<{ id: number; score: number }> = [];
		for await (const r of db.eval(sql)) {
			rows.push(r as unknown as { id: number; score: number });
		}
		expect(rows.map(r => r.score)).to.deep.equal([30, 20, 10]);
	});
});
