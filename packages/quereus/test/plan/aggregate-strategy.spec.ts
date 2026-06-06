import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { planOps, allRows } from './_helpers.js';

describe('Plan shape: aggregate strategy selection', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, grp TEXT, val INTEGER) USING memory");
		await db.exec("INSERT INTO t VALUES (1,'a',10),(2,'b',20),(3,'a',30),(4,'b',40),(5,'c',50)");
	});

	afterEach(async () => {
		await db.close();
	});

	it('uses StreamAggregate when input is pre-sorted by GROUP BY column (PK)', async () => {
		const q = "SELECT id, count(*) AS c FROM t GROUP BY id";
		const ops = await planOps(db, q);

		expect(ops).to.include('STREAMAGGREGATE',
			'GROUP BY on PK (pre-sorted input) should use StreamAggregate');
		expect(ops).to.not.include('HASHAGGREGATE',
			'Should not use HashAggregate when input is already sorted');
	});

	it('uses HashAggregate for unsorted GROUP BY column', async () => {
		const q = "SELECT grp, count(*) AS cnt FROM t GROUP BY grp";
		const ops = await planOps(db, q);

		expect(ops).to.include('HASHAGGREGATE',
			'GROUP BY on non-sorted column should use HashAggregate');
	});

	it('uses StreamAggregate for scalar aggregate (no GROUP BY)', async () => {
		const q = "SELECT count(*), sum(val) FROM t";
		const ops = await planOps(db, q);

		expect(ops).to.include('STREAMAGGREGATE',
			'Scalar aggregate without GROUP BY should use StreamAggregate');
		expect(ops).to.not.include('HASHAGGREGATE');
	});

	it('uses StreamAggregate when subquery provides sorted input', async () => {
		const q = "SELECT id, count(*) AS c FROM (SELECT * FROM t ORDER BY id LIMIT 100) s GROUP BY id";
		const ops = await planOps(db, q);

		expect(ops).to.include('STREAMAGGREGATE',
			'GROUP BY on already-sorted subquery output should use StreamAggregate');
	});

	it('StreamAggregate on PK produces correct results', async () => {
		const q = "SELECT id, count(*) AS c FROM t GROUP BY id ORDER BY id";
		const results = await allRows<{ id: number; c: number }>(db, q);
		expect(results).to.have.lengthOf(5);
		for (const row of results) {
			expect(row.c).to.equal(1);
		}
	});

	it('HashAggregate on non-sorted column produces correct results', async () => {
		const q = "SELECT grp, count(*) AS cnt, sum(val) AS total FROM t GROUP BY grp ORDER BY grp";
		const results = await allRows<{ grp: string; cnt: number; total: number }>(db, q);
		expect(results).to.deep.equal([
			{ grp: 'a', cnt: 2, total: 40 },
			{ grp: 'b', cnt: 2, total: 60 },
			{ grp: 'c', cnt: 1, total: 50 },
		]);
	});
});
