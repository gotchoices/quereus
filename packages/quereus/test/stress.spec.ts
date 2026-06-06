/**
 * Stress tests for large datasets, deep queries, and concurrent access patterns.
 *
 * These are NOT benchmarks — they are correctness tests at scale.
 * The assertion is "completes without error and produces correct results",
 * with generous timeouts.
 *
 * Run: yarn test --grep "Stress tests"
 */

import { expect } from 'chai';
import { Database } from '../src/index.js';

/** Collect an async iterable into an array. */
async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of iter) out.push(item);
	return out;
}

describe('Stress tests', function () {
	this.timeout(60_000);

	// --------------------------------------------------------- Large Dataset
	describe('Large dataset', () => {
		let db: Database;

		beforeEach(() => {
			db = new Database();
		});

		afterEach(async () => {
			await db.close();
		});

		it('insert 50K rows and verify count + spot-check', async () => {
			await db.exec('create table big (id integer primary key, val integer, label text)');

			// Insert in batches of 500
			for (let batch = 0; batch < 100; batch++) {
				const values = Array.from({ length: 500 }, (_, j) => {
					const id = batch * 500 + j + 1;
					return `(${id}, ${id * 7 % 1000}, 'lbl_${id % 50}')`;
				}).join(', ');
				await db.exec(`insert into big values ${values}`);
			}

			// Verify count
			const countRow = await db.get('select count(*) as cnt from big');
			expect(countRow!.cnt).to.equal(50000);

			// Spot-check specific rows
			const row1 = await db.get('select * from big where id = 1');
			expect(row1!.val).to.equal(7);
			expect(row1!.label).to.equal('lbl_1');

			const row25000 = await db.get('select * from big where id = 25000');
			expect(row25000!.val).to.equal((25000 * 7) % 1000);

			const rowLast = await db.get('select * from big where id = 50000');
			expect(rowLast).to.exist;
		});

		it('GROUP BY on 50K rows with ~500 distinct groups', async () => {
			await db.exec('create table grp (id integer primary key, category integer)');

			for (let batch = 0; batch < 100; batch++) {
				const values = Array.from({ length: 500 }, (_, j) => {
					const id = batch * 500 + j + 1;
					return `(${id}, ${id % 500})`;
				}).join(', ');
				await db.exec(`insert into grp values ${values}`);
			}

			const rows = await collect(
				db.eval('select category, count(*) as cnt from grp group by category')
			);
			expect(rows).to.have.length(500);

			// Sum of all group counts should equal total
			const totalFromGroups = rows.reduce((sum, r) => sum + (r.cnt as number), 0);
			expect(totalFromGroups).to.equal(50000);

			// Each group should have exactly 100 rows (50000 / 500)
			for (const row of rows) {
				expect(row.cnt).to.equal(100);
			}
		});

		it('ORDER BY on 50K rows produces sorted output', async () => {
			await db.exec('create table sortme (id integer primary key, val integer)');

			for (let batch = 0; batch < 100; batch++) {
				const values = Array.from({ length: 500 }, (_, j) => {
					const id = batch * 500 + j + 1;
					return `(${id}, ${(id * 31337) % 100003})`;
				}).join(', ');
				await db.exec(`insert into sortme values ${values}`);
			}

			const rows = await collect(
				db.eval('select val from sortme order by val asc')
			);
			expect(rows).to.have.length(50000);

			// Verify sorted
			for (let i = 1; i < rows.length; i++) {
				expect(rows[i].val as number).to.be.at.least(rows[i - 1].val as number);
			}
		});

		it('full table scan with 20+ columns (wide rows)', async () => {
			const cols = Array.from({ length: 25 }, (_, i) => `c${i} integer`).join(', ');
			await db.exec(`create table wide (id integer primary key, ${cols})`);

			// Insert 5000 wide rows
			for (let batch = 0; batch < 50; batch++) {
				const values = Array.from({ length: 100 }, (_, j) => {
					const id = batch * 100 + j + 1;
					const colVals = Array.from({ length: 25 }, (_, c) => id + c).join(', ');
					return `(${id}, ${colVals})`;
				}).join(', ');
				await db.exec(`insert into wide values ${values}`);
			}

			const rows = await collect(db.eval('select * from wide'));
			expect(rows).to.have.length(5000);

			// Verify all 26 columns (id + 25 data cols) present
			const colNames = Object.keys(rows[0]);
			expect(colNames).to.have.length(26);

			// Spot-check a row
			expect(rows[0].id).to.equal(1);
			expect(rows[0].c0).to.equal(1);
			expect(rows[0].c24).to.equal(25);
		});
	});

	// --------------------------------------------------- Deep/Complex Queries
	describe('Deep/complex queries', () => {
		let db: Database;

		beforeEach(() => {
			db = new Database();
		});

		afterEach(async () => {
			await db.close();
		});

		it('5-way join chain with 200 rows each', async () => {
			// Create 5 tables, each with 200 rows
			for (const t of ['a', 'b', 'c', 'd', 'e']) {
				await db.exec(`create table t_${t} (id integer primary key, ref integer)`);
				const values = Array.from({ length: 200 }, (_, i) =>
					`(${i + 1}, ${(i % 10) + 1})`
				).join(', ');
				await db.exec(`insert into t_${t} values ${values}`);
			}

			// Join chain: a.ref = b.id, b.ref = c.id, c.ref = d.id, d.ref = e.id
			// Each ref maps to ids 1-10, so each join preserves ~200 rows matching to 10 targets
			const rows = await collect(db.eval(`
				select count(*) as cnt
				from t_a
				join t_b on t_a.ref = t_b.id
				join t_c on t_b.ref = t_c.id
				join t_d on t_c.ref = t_d.id
				join t_e on t_d.ref = t_e.id
			`));
			expect(rows).to.have.length(1);
			expect(rows[0].cnt as number).to.be.greaterThan(0);
		});

		it('deeply nested subqueries (5 levels)', async () => {
			await db.exec('create table nest (id integer primary key)');
			const values = Array.from({ length: 50 }, (_, i) => `(${i + 1})`).join(', ');
			await db.exec(`insert into nest values ${values}`);

			// Build nested: select * from nest where id in (select id from nest where id in (...))
			let query = 'select id from nest where id <= 25';
			for (let depth = 0; depth < 4; depth++) {
				query = `select id from nest where id in (${query})`;
			}
			query = `select count(*) as cnt from nest where id in (${query})`;

			const rows = await collect(db.eval(query));
			expect(rows[0].cnt).to.equal(25);
		});

		it('recursive CTE to depth 500', async () => {
			const rows = await collect(db.eval(`
				with recursive seq(n) as (
					select 1
					union all
					select n + 1 from seq where n < 500
				)
				select count(*) as cnt, min(n) as mn, max(n) as mx from seq
			`));
			expect(rows[0].cnt).to.equal(500);
			expect(rows[0].mn).to.equal(1);
			expect(rows[0].mx).to.equal(500);
		});

		it('UNION ALL of 10 SELECTs', async () => {
			await db.exec('create table compound (id integer primary key, grp integer)');
			const values = Array.from({ length: 100 }, (_, i) => `(${i + 1}, ${i % 10})`).join(', ');
			await db.exec(`insert into compound values ${values}`);

			// UNION ALL of 10 selects — should produce 100 total rows (10 per select)
			const selects = Array.from({ length: 10 }, (_, i) =>
				`select id, grp from compound where grp = ${i}`
			).join(' union all ');

			const rows = await collect(db.eval(selects));
			expect(rows).to.have.length(100);
		});

		it('UNION deduplicates identical rows', async () => {
			await db.exec('create table dup (id integer primary key, val integer)');
			const values = Array.from({ length: 50 }, (_, i) => `(${i + 1}, ${i % 5})`).join(', ');
			await db.exec(`insert into dup values ${values}`);

			// UNION of same query twice — should deduplicate
			const unionRows = await collect(db.eval(
				'select val from dup union select val from dup'
			));
			expect(unionRows).to.have.length(5); // only 5 distinct vals

			// Compare with UNION ALL
			const unionAllRows = await collect(db.eval(
				'select val from dup union all select val from dup'
			));
			expect(unionAllRows).to.have.length(100); // 50 + 50
		});
	});

	// ------------------------------------------------- Concurrent Iterators
	describe('Concurrent iterators', () => {
		let db: Database;

		beforeEach(async () => {
			db = new Database();
			await db.exec('create table iter_t (id integer primary key, val integer)');
			const values = Array.from({ length: 200 }, (_, i) => `(${i + 1}, ${i * 3})`).join(', ');
			await db.exec(`insert into iter_t values ${values}`);
		});

		afterEach(async () => {
			await db.close();
		});

		it('10 sequential iterators on the same table all return full results', async () => {
			// The engine serializes access, so run these sequentially
			for (let iter = 0; iter < 10; iter++) {
				const rows = await collect(db.eval('select * from iter_t'));
				expect(rows).to.have.length(200, `Iterator ${iter} returned wrong count`);
			}
		});

		it('interleaved reads and writes to different tables', async () => {
			await db.exec('create table write_t (id integer primary key, data text)');

			// Read from iter_t, then write to write_t, alternating
			for (let cycle = 0; cycle < 20; cycle++) {
				const rows = await collect(db.eval('select count(*) as cnt from iter_t'));
				expect(rows[0].cnt).to.equal(200);

				await db.exec(`insert into write_t values (${cycle + 1}, 'data_${cycle}')`);
			}

			// Verify write_t has all 20 rows
			const writeRows = await collect(db.eval('select count(*) as cnt from write_t'));
			expect(writeRows[0].cnt).to.equal(20);
		});

		it('rapid prepare/finalize cycles (100 statements) without leaking', async () => {
			for (let i = 0; i < 100; i++) {
				const stmt = db.prepare('select * from iter_t where id = ?');
				const row = await stmt.get([i % 200 + 1]);
				expect(row).to.exist;
				await stmt.finalize();
			}

			// Verify database still works after all those cycles
			const rows = await collect(db.eval('select count(*) as cnt from iter_t'));
			expect(rows[0].cnt).to.equal(200);
		});
	});

	// -------------------------------------------------------- Schema Scale
	describe('Schema scale', () => {
		let db: Database;

		beforeEach(() => {
			db = new Database();
		});

		afterEach(async () => {
			await db.close();
		});

		it('50 tables with indexes, then join 3 of them', async () => {
			// Create 50 tables with an index each
			for (let t = 0; t < 50; t++) {
				await db.exec(`create table s_${t} (id integer primary key, val integer, ref integer)`);
				await db.exec(`create index idx_s_${t}_val on s_${t} (val)`);
				const values = Array.from({ length: 20 }, (_, i) =>
					`(${i + 1}, ${(i + t) % 10}, ${(i % 5) + 1})`
				).join(', ');
				await db.exec(`insert into s_${t} values ${values}`);
			}

			// Join 3 of them
			const rows = await collect(db.eval(`
				select count(*) as cnt
				from s_0
				join s_25 on s_0.ref = s_25.id
				join s_49 on s_25.ref = s_49.id
			`));
			expect(rows).to.have.length(1);
			expect(rows[0].cnt as number).to.be.greaterThan(0);

			// Verify schema still consistent — query a table in the middle
			const midRows = await collect(db.eval('select count(*) as cnt from s_24'));
			expect(midRows[0].cnt).to.equal(20);
		});

		it('drop and recreate tables in a loop (20 cycles) with no stale refs', async () => {
			for (let cycle = 0; cycle < 20; cycle++) {
				await db.exec(`create table cycle_t (id integer primary key, cycle integer)`);
				await db.exec(`create index idx_cycle on cycle_t (cycle)`);

				const values = Array.from({ length: 50 }, (_, i) =>
					`(${i + 1}, ${cycle})`
				).join(', ');
				await db.exec(`insert into cycle_t values ${values}`);

				// Verify current cycle data
				const rows = await collect(db.eval('select count(*) as cnt, min(cycle) as mn, max(cycle) as mx from cycle_t'));
				expect(rows[0].cnt).to.equal(50);
				expect(rows[0].mn).to.equal(cycle);
				expect(rows[0].mx).to.equal(cycle);

				await db.exec('drop table cycle_t');
			}

			// After all cycles, the table should not exist
			let threw = false;
			try {
				await collect(db.eval('select * from cycle_t'));
			} catch {
				threw = true;
			}
			expect(threw).to.be.true;
		});
	});
});
