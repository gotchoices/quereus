import { expect } from 'chai';
import { Database } from '../../src/core/database.js';

interface PhysicalRow { node_type: string; op: string; detail: string; physical: string | null }

interface MonotonicOnEntry { attrId: number; strict: boolean; direction: 'asc' | 'desc' }
interface PhysicalProps { monotonicOn?: MonotonicOnEntry[] }

async function getPhysicalRows(db: Database, sql: string): Promise<PhysicalRow[]> {
	const rows: PhysicalRow[] = [];
	for await (const r of db.eval(
		"SELECT node_type, op, detail, physical FROM query_plan(?)", [sql],
	)) {
		rows.push(r as unknown as PhysicalRow);
	}
	return rows;
}

function physicalOf(rows: readonly PhysicalRow[], opPredicate: (r: PhysicalRow) => boolean): PhysicalProps | undefined {
	const row = rows.find(opPredicate);
	if (!row || !row.physical) return undefined;
	return JSON.parse(row.physical) as PhysicalProps;
}

describe('MonotonicOn characteristic propagation', () => {
	let db: Database;

	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	async function setupUnique(): Promise<void> {
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory");
		await db.exec("INSERT INTO t VALUES (1,'a'),(2,'b'),(3,'c')");
	}

	async function setupNonUnique(): Promise<void> {
		await db.exec("CREATE TABLE nu (k INTEGER PRIMARY KEY, x INTEGER) USING memory");
		await db.exec("INSERT INTO nu VALUES (1,10),(2,10),(3,20)");
	}

	it('Sort establishes strict monotonicOn when source is unique on the leading key', async () => {
		await setupUnique();
		// ORDER BY id DESC on a PK forces a Sort (the index is ascending), and the
		// input PK uniqueKey covers id alone, so strict must be true.
		const rows = await getPhysicalRows(db, "SELECT * FROM t ORDER BY id DESC");
		const sort = physicalOf(rows, r => r.op === 'SORT');
		expect(sort, 'sort node present').to.not.equal(undefined);
		expect(sort!.monotonicOn).to.be.an('array').with.lengthOf(1);
		expect(sort!.monotonicOn![0].direction).to.equal('desc');
		expect(sort!.monotonicOn![0].strict).to.equal(true);
	});

	it('Sort establishes non-strict monotonicOn when source is not unique on the leading key', async () => {
		await setupNonUnique();
		const rows = await getPhysicalRows(db, "SELECT * FROM nu ORDER BY x");
		const sort = physicalOf(rows, r => r.op === 'SORT');
		expect(sort, 'sort node present').to.not.equal(undefined);
		expect(sort!.monotonicOn).to.be.an('array').with.lengthOf(1);
		expect(sort!.monotonicOn![0].direction).to.equal('asc');
		expect(sort!.monotonicOn![0].strict).to.equal(false);
	});

	it('Distinct strengthens non-strict source monotonicOn to strict', async () => {
		await setupNonUnique();
		const rows = await getPhysicalRows(db, "SELECT DISTINCT x FROM (SELECT x FROM nu ORDER BY x) s");
		const distinct = physicalOf(rows, r => r.op === 'DISTINCT');
		expect(distinct, 'distinct node present').to.not.equal(undefined);
		expect(distinct!.monotonicOn).to.be.an('array').with.lengthOf(1);
		expect(distinct!.monotonicOn![0].strict).to.equal(true);
	});

	it('Filter preserves monotonicOn from its source', async () => {
		await setupNonUnique();
		// LIMIT inside the subquery blocks predicate pushdown so the Filter stays
		// above the Sort in the final plan.
		const rows = await getPhysicalRows(db,
			"SELECT * FROM (SELECT k, x FROM nu ORDER BY x LIMIT 100) s WHERE x > 0");
		const filter = physicalOf(rows, r => r.op === 'FILTER');
		expect(filter, 'filter node present').to.not.equal(undefined);
		expect(filter!.monotonicOn).to.be.an('array').with.lengthOf(1);
	});

	it('LimitOffset preserves monotonicOn from its source', async () => {
		await setupNonUnique();
		const rows = await getPhysicalRows(db,
			"SELECT * FROM (SELECT k, x FROM nu ORDER BY x) s LIMIT 5");
		const limit = physicalOf(rows, r => r.op === 'LIMITOFFSET');
		expect(limit, 'limit node present').to.not.equal(undefined);
		expect(limit!.monotonicOn).to.be.an('array').with.lengthOf(1);
	});

	it('Alias preserves monotonicOn unchanged', async () => {
		await setupNonUnique();
		const rows = await getPhysicalRows(db, "SELECT * FROM (SELECT * FROM nu ORDER BY x) AS aliased");
		const alias = physicalOf(rows, r => r.op === 'ALIAS');
		expect(alias, 'alias node present').to.not.equal(undefined);
		expect(alias!.monotonicOn).to.be.an('array').with.lengthOf(1);
	});

	it('Project preserves monotonicOn when the attribute survives as a trivial column reference', async () => {
		await setupNonUnique();
		// Add an extra column reference to the outer projection so the optimizer
		// keeps a Project node around (rather than collapsing into the source).
		const rows = await getPhysicalRows(db,
			"SELECT k, x, k+1 AS k1 FROM (SELECT k, x FROM nu ORDER BY x) s");
		const project = physicalOf(rows, r => r.op === 'PROJECT' && /k1/.test(String(r.detail)));
		expect(project, 'outer project node present').to.not.equal(undefined);
		expect(project!.monotonicOn).to.be.an('array').with.lengthOf(1);
	});

	it('Project drops monotonicOn when the attribute is not projected', async () => {
		await setupNonUnique();
		const rows = await getPhysicalRows(db, "SELECT k FROM (SELECT k, x FROM nu ORDER BY x) s");
		const project = physicalOf(rows, r => r.op === 'PROJECT');
		expect(project, 'project node present').to.not.equal(undefined);
		expect(project!.monotonicOn ?? []).to.deep.equal([]);
	});

	it('Project drops monotonicOn through a non-trivial expression', async () => {
		await setupNonUnique();
		const rows = await getPhysicalRows(db, "SELECT x + 1 AS xp FROM (SELECT k, x FROM nu ORDER BY x) s");
		const project = physicalOf(rows, r => r.op === 'PROJECT' && /xp/.test(String(r.detail)));
		expect(project, 'outer project node present').to.not.equal(undefined);
		expect(project!.monotonicOn ?? []).to.deep.equal([]);
	});

	it('Inner join on a monotonic equi-pair propagates monotonicOn (strict-AND of inputs)', async () => {
		await db.exec("CREATE TABLE p (id INTEGER PRIMARY KEY, x INTEGER) USING memory");
		await db.exec("CREATE TABLE q (id INTEGER PRIMARY KEY, x INTEGER) USING memory");
		await db.exec("INSERT INTO p VALUES (1,10),(2,20)");
		await db.exec("INSERT INTO q VALUES (1,10),(2,30)");

		const sql = "SELECT * FROM (SELECT x FROM p ORDER BY x) lp INNER JOIN (SELECT x FROM q ORDER BY x) lq ON lp.x = lq.x";
		const rows = await getPhysicalRows(db, sql);
		const join = physicalOf(rows, r => /JOIN/.test(r.op));
		expect(join, 'join node present').to.not.equal(undefined);
		expect(join!.monotonicOn).to.be.an('array');
		expect(join!.monotonicOn!.length).to.be.greaterThanOrEqual(1);
		// p.x and q.x are not unique on either side, so propagated entries must be non-strict.
		expect(join!.monotonicOn!.every(m => m.strict === false)).to.equal(true);
	});

	it('Cross join drops monotonicOn', async () => {
		await db.exec("CREATE TABLE ca (a INTEGER PRIMARY KEY) USING memory");
		await db.exec("CREATE TABLE cb (b INTEGER PRIMARY KEY) USING memory");
		await db.exec("INSERT INTO ca VALUES (1),(2)");
		await db.exec("INSERT INTO cb VALUES (3),(4)");

		const sql = "SELECT * FROM (SELECT a FROM ca ORDER BY a DESC) l CROSS JOIN (SELECT b FROM cb ORDER BY b DESC) r";
		const rows = await getPhysicalRows(db, sql);
		const join = physicalOf(rows, r => /JOIN/.test(r.op));
		// Even when both sides are monotonicOn, cross join drops.
		if (join) {
			expect(join.monotonicOn ?? []).to.deep.equal([]);
		}
	});

	it('Set operations drop monotonicOn (UNION ALL)', async () => {
		await db.exec("CREATE TABLE sa (id INTEGER PRIMARY KEY, x INTEGER) USING memory");
		await db.exec("CREATE TABLE sb (id INTEGER PRIMARY KEY, x INTEGER) USING memory");
		await db.exec("INSERT INTO sa VALUES (1,10),(2,20)");
		await db.exec("INSERT INTO sb VALUES (3,30),(4,40)");

		const sql = "SELECT x FROM (SELECT x FROM sa ORDER BY x) UNION ALL SELECT x FROM (SELECT x FROM sb ORDER BY x)";
		const rows = await getPhysicalRows(db, sql);
		const setOp = physicalOf(rows, r => /SETOPERATION|UNION/.test(r.op) || /UNION/.test(String(r.detail)));
		if (setOp) {
			expect(setOp.monotonicOn ?? []).to.deep.equal([]);
		}
	});

	it('Set operations drop monotonicOn (UNION)', async () => {
		await db.exec("CREATE TABLE ua (id INTEGER PRIMARY KEY, x INTEGER) USING memory");
		await db.exec("CREATE TABLE ub (id INTEGER PRIMARY KEY, x INTEGER) USING memory");
		await db.exec("INSERT INTO ua VALUES (1,10),(2,20)");
		await db.exec("INSERT INTO ub VALUES (3,20),(4,30)");

		const sql = "SELECT x FROM (SELECT x FROM ua ORDER BY x) UNION SELECT x FROM (SELECT x FROM ub ORDER BY x)";
		const rows = await getPhysicalRows(db, sql);
		const setOp = physicalOf(rows, r => /SETOPERATION|UNION/.test(r.op) || /UNION/.test(String(r.detail)));
		if (setOp) {
			expect(setOp.monotonicOn ?? []).to.deep.equal([]);
		}
	});

	it('GROUP BY drops monotonicOn', async () => {
		await db.exec("CREATE TABLE ga (id INTEGER PRIMARY KEY, k INTEGER, v INTEGER) USING memory");
		await db.exec("INSERT INTO ga VALUES (1,1,10),(2,1,20),(3,2,30)");

		const sql = "SELECT k, count(*) AS c FROM (SELECT k, v FROM ga ORDER BY k) s GROUP BY k";
		const rows = await getPhysicalRows(db, sql);
		const agg = physicalOf(rows, r => /AGGREGATE/.test(r.op));
		expect(agg, 'aggregate node present').to.not.equal(undefined);
		expect(agg!.monotonicOn ?? []).to.deep.equal([]);
	});

	it('Window function derives monotonicOn from its own ORDER BY when un-partitioned', async () => {
		await setupNonUnique();
		// Window's ORDER BY x matches source's monotonicOn(x), so it carries through
		// (output is sorted by x within the single partition).
		const sql = "SELECT k, x, row_number() OVER (ORDER BY x) AS rn FROM (SELECT k, x FROM nu ORDER BY x) s";
		const rows = await getPhysicalRows(db, sql);
		const win = physicalOf(rows, r => r.op === 'WINDOW');
		expect(win, 'window node present').to.not.equal(undefined);
		expect(win!.monotonicOn).to.be.an('array').with.lengthOf(1);
		expect(win!.monotonicOn![0].direction).to.equal('asc');
	});

	it('Window function drops monotonicOn when PARTITION BY reorders rows', async () => {
		await setupNonUnique();
		// PARTITION BY k groups rows by partition-key insertion order, breaking the
		// global monotonic-on-x ordering even though the source was sorted on x.
		const sql = "SELECT k, x, row_number() OVER (PARTITION BY k ORDER BY x) AS rn FROM (SELECT k, x FROM nu ORDER BY x) s";
		const rows = await getPhysicalRows(db, sql);
		const win = physicalOf(rows, r => r.op === 'WINDOW');
		expect(win, 'window node present').to.not.equal(undefined);
		expect(win!.monotonicOn ?? []).to.deep.equal([]);
	});

	it('EXPLAIN serializes monotonicOn in physical JSON', async () => {
		await setupNonUnique();
		const rows = await getPhysicalRows(db, "SELECT * FROM nu ORDER BY x");
		const sort = rows.find(r => r.op === 'SORT');
		expect(sort, 'sort row present').to.not.equal(undefined);
		expect(sort!.physical).to.be.a('string');
		expect(String(sort!.physical)).to.match(/"monotonicOn"/);
	});
});
