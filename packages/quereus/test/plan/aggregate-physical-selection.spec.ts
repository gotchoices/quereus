import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { planOps, planRows, allRows } from './_helpers.js';

describe('ruleAggregatePhysical — branch coverage', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, grp TEXT, val INTEGER) USING memory");
		await db.exec("INSERT INTO t VALUES (1,'a',10),(2,'b',20),(3,'a',30),(4,'b',40),(5,'c',50)");

		await db.exec("CREATE TABLE comp (a INTEGER, b INTEGER, c INTEGER, PRIMARY KEY (a, b)) USING memory");
		await db.exec("INSERT INTO comp VALUES (1,1,10),(1,2,20),(2,1,30),(2,2,40),(3,1,50)");
	});

	afterEach(async () => {
		await db.close();
	});

	describe('scalar aggregate (no GROUP BY)', () => {
		it('picks StreamAggregate without Sort or Hash', async () => {
			const ops = await planOps(db, 'SELECT count(*), sum(val) FROM t');
			expect(ops).to.include('STREAMAGGREGATE');
			expect(ops).to.not.include('HASHAGGREGATE');
			expect(ops).to.not.include('SORT');
		});

		it('produces correct results', async () => {
			const rows = await allRows<{ c: number; s: number }>(db,
				'SELECT count(*) AS c, sum(val) AS s FROM t');
			expect(rows).to.deep.equal([{ c: 5, s: 150 }]);
		});
	});

	describe('already-sorted source (PK ordering)', () => {
		it('GROUP BY single PK picks StreamAggregate without Sort', async () => {
			const ops = await planOps(db, 'SELECT id, count(*) FROM t GROUP BY id');
			expect(ops).to.include('STREAMAGGREGATE');
			expect(ops).to.not.include('HASHAGGREGATE');
			expect(ops).to.not.include('SORT');
		});

		it('GROUP BY full composite PK in order picks StreamAggregate without Sort', async () => {
			const ops = await planOps(db, 'SELECT a, b, count(*) FROM comp GROUP BY a, b');
			expect(ops).to.include('STREAMAGGREGATE');
			expect(ops).to.not.include('HASHAGGREGATE');
			expect(ops).to.not.include('SORT');
		});

		it('GROUP BY prefix of composite PK picks StreamAggregate without Sort', async () => {
			const ops = await planOps(db, 'SELECT a, count(*) FROM comp GROUP BY a');
			expect(ops).to.include('STREAMAGGREGATE');
			expect(ops).to.not.include('SORT');
		});

		it('StreamAggregate on composite PK produces correct results', async () => {
			const rows = await allRows<{ a: number; b: number; c: number }>(db,
				'SELECT a, b, count(*) AS c FROM comp GROUP BY a, b ORDER BY a, b');
			expect(rows).to.deep.equal([
				{ a: 1, b: 1, c: 1 },
				{ a: 1, b: 2, c: 1 },
				{ a: 2, b: 1, c: 1 },
				{ a: 2, b: 2, c: 1 },
				{ a: 3, b: 1, c: 1 },
			]);
		});
	});

	describe('unsorted source → cost-based (HashAggregate)', () => {
		it('GROUP BY non-PK column picks HashAggregate', async () => {
			const ops = await planOps(db, 'SELECT grp, count(*) FROM t GROUP BY grp');
			expect(ops).to.include('HASHAGGREGATE');
			expect(ops).to.not.include('STREAMAGGREGATE');
		});

		it('HashAggregate produces correct results', async () => {
			const rows = await allRows<{ grp: string; cnt: number }>(db,
				'SELECT grp, count(*) AS cnt FROM t GROUP BY grp ORDER BY grp');
			expect(rows).to.deep.equal([
				{ grp: 'a', cnt: 2 },
				{ grp: 'b', cnt: 2 },
				{ grp: 'c', cnt: 1 },
			]);
		});
	});

	describe('isOrderedForGrouping edge cases', () => {
		it('GROUP BY expression (non-column-ref) picks HashAggregate', async () => {
			const ops = await planOps(db, 'SELECT id + 1 AS e, count(*) FROM t GROUP BY id + 1');
			expect(ops).to.include('HASHAGGREGATE');
		});

		it('GROUP BY reversed composite PK order picks HashAggregate (prefix mismatch)', async () => {
			const ops = await planOps(db, 'SELECT b, a, count(*) FROM comp GROUP BY b, a');
			expect(ops).to.include('HASHAGGREGATE');
		});

		it('GROUP BY a, b, c on composite PK (a, b): groupby-fd-simplification drops `c` and StreamAggregate is picked', async () => {
			// `c` is functionally determined by the PK `(a, b)`, so the GROUP-BY
			// FD simplification rule drops it and re-emits it as a MIN(c) picker.
			// The resulting GROUP BY a, b is a prefix of source ordering, so we
			// land on StreamAggregate (no Sort needed).
			const ops = await planOps(db, 'SELECT a, b, c, count(*) FROM comp GROUP BY a, b, c');
			expect(ops).to.include('STREAMAGGREGATE');
			expect(ops).to.not.include('HASHAGGREGATE');
		});

		it('GROUP BY second key only of composite PK picks HashAggregate (not prefix)', async () => {
			const ops = await planOps(db, 'SELECT b, count(*) FROM comp GROUP BY b');
			expect(ops).to.include('HASHAGGREGATE');
		});

		it('GROUP BY first PK key + non-PK column picks HashAggregate (column mismatch at position 1)', async () => {
			const ops = await planOps(db, 'SELECT a, c, count(*) FROM comp GROUP BY a, c');
			expect(ops).to.include('HASHAGGREGATE');
		});

		it('expression GROUP BY produces correct results', async () => {
			const rows = await allRows<{ e: number; cnt: number }>(db,
				'SELECT id + 1 AS e, count(*) AS cnt FROM t GROUP BY id + 1 ORDER BY id + 1');
			expect(rows).to.have.lengthOf(5);
			expect(rows[0]).to.deep.equal({ e: 2, cnt: 1 });
		});
	});

	describe('plan tree structure', () => {
		it('StreamAggregate has no Sort ancestor in pre-sorted case', async () => {
			const rows = await planRows(db, 'SELECT id, count(*) FROM t GROUP BY id');
			const aggRow = rows.find(r => r.op === 'STREAMAGGREGATE');
			expect(aggRow).to.not.be.undefined;
			const sortRow = rows.find(r => r.op === 'SORT');
			expect(sortRow).to.be.undefined;
		});

		it('HashAggregate is present and no StreamAggregate in unsorted case', async () => {
			const rows = await planRows(db, 'SELECT grp, count(*) FROM t GROUP BY grp');
			const hashRow = rows.find(r => r.op === 'HASHAGGREGATE');
			expect(hashRow).to.not.be.undefined;
			const streamRow = rows.find(r => r.op === 'STREAMAGGREGATE');
			expect(streamRow).to.be.undefined;
		});
	});
});
