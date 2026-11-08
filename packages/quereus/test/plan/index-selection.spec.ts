import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { planOps, planRows, allRows } from './_helpers.js';

describe('Plan shape: index selection', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec(`CREATE TABLE products (
			id INTEGER PRIMARY KEY,
			name TEXT,
			category TEXT,
			price REAL
		) USING memory`);
		await db.exec(`INSERT INTO products VALUES
			(1, 'Widget', 'tools', 9.99),
			(2, 'Gadget', 'electronics', 29.99),
			(3, 'Sprocket', 'tools', 4.99),
			(4, 'Doohickey', 'electronics', 14.99),
			(5, 'Thingamajig', 'misc', 19.99)`);
		await db.exec("CREATE INDEX idx_category ON products(category)");
		await db.exec("CREATE INDEX idx_price ON products(price)");
	});

	afterEach(async () => {
		await db.close();
	});

	describe('index selected over sequential scan', () => {
		it('uses IndexSeek for equality on secondary index', async () => {
			const q = "SELECT name FROM products WHERE category = 'tools'";
			const ops = await planOps(db, q);

			const hasIndexAccess = ops.some(op =>
				op === 'INDEXSEEK' || op === 'INDEXSCAN'
			);
			expect(hasIndexAccess, 'Equality on indexed column should use index access').to.equal(true);
			expect(ops).to.not.include('SEQSCAN', 'Should not use sequential scan');
		});

		it('uses IndexSeek for PK equality', async () => {
			const q = "SELECT name FROM products WHERE id = 3";
			const ops = await planOps(db, q);

			expect(ops).to.include('INDEXSEEK', 'PK equality should use IndexSeek');
			expect(ops).to.not.include('SEQSCAN');
		});

		it('uses index access for range predicate on indexed column', async () => {
			const q = "SELECT name FROM products WHERE price > 15.0";
			const ops = await planOps(db, q);

			const hasIndexAccess = ops.some(op =>
				op === 'INDEXSEEK' || op === 'INDEXSCAN'
			);
			expect(hasIndexAccess, 'Range on indexed column should use index access').to.equal(true);
		});

		it('uses index access for bounded range', async () => {
			const q = "SELECT name FROM products WHERE price >= 10.0 AND price <= 25.0";
			const ops = await planOps(db, q);

			const hasIndexAccess = ops.some(op =>
				op === 'INDEXSEEK' || op === 'INDEXSCAN'
			);
			expect(hasIndexAccess, 'Bounded range on indexed column should use index access').to.equal(true);
		});
	});

	describe('correct results with index access', () => {
		it('returns correct rows for equality on secondary index', async () => {
			const results = await allRows<{ name: string }>(db,
				"SELECT name FROM products WHERE category = 'tools' ORDER BY name"
			);
			expect(results.map(r => r.name)).to.deep.equal(['Sprocket', 'Widget']);
		});

		it('returns correct rows for range on secondary index', async () => {
			const results = await allRows<{ name: string; price: number }>(db,
				"SELECT name, price FROM products WHERE price > 15.0 ORDER BY price"
			);
			expect(results).to.have.lengthOf(2);
			expect(results[0].name).to.equal('Thingamajig');
			expect(results[1].name).to.equal('Gadget');
		});

		it('returns correct rows for PK seek', async () => {
			const results = await allRows<{ name: string }>(db,
				"SELECT name FROM products WHERE id = 3"
			);
			expect(results).to.deep.equal([{ name: 'Sprocket' }]);
		});
	});

	describe('equality on a leading part of a compound key', () => {
		/** The seek leaf's detail, asserting no Sort or Filter is doing the seek's work above it. */
		async function seekDetail(sql: string): Promise<string> {
			const rows = await planRows(db, sql);
			const ops = rows.map(r => r.op);
			expect(ops, sql).to.not.include('FILTER');
			expect(ops, sql).to.not.include('SORT');
			const seek = rows.find(r => r.op === 'INDEXSEEK');
			expect(seek, `no INDEXSEEK for: ${sql}`).to.not.equal(undefined);
			return seek!.detail;
		}

		it('seeks a primary key prefix', async () => {
			await db.exec('create table t (k text, r integer, x integer, primary key (k, r))');
			expect(await seekDetail("select x from t where k = 'a'")).to.match(/USING primary\b/);
		});

		it('seeks a secondary index prefix', async () => {
			await db.exec('create table u (id integer primary key, k text, r integer, x integer)');
			await db.exec('create index u_kr on u (k, r)');
			expect(await seekDetail("select x from u where k = 'a'")).to.match(/USING u_kr\b/);
		});

		it('seeks a two-column prefix of a three-column index', async () => {
			await db.exec('create table v (id integer primary key, a integer, b integer, c integer)');
			await db.exec('create index v_abc on v (a, b, c)');
			expect(await seekDetail('select id from v where a = 1 and b = 2')).to.match(/USING v_abc\b/);
		});

		it('serves order by + limit from the seek, reading one row', async () => {
			// `r desc` over the ascending key is a backwards walk, which must start from the
			// END of the `k = 'a'` group rather than skipping it.
			await db.exec('create table d (k text, r integer not null, x integer, primary key (k, r))');
			await db.exec("insert into d values ('a', 1, 10), ('a', 2, 20), ('a', 3, 30), ('b', 9, 90)");
			const sql = "select x from d where k = 'a' order by r desc limit 1";

			expect(await seekDetail(sql)).to.match(/USING primary\b/);
			expect(await allRows(db, sql)).to.deep.equal([{ x: 30 }]);

			db.setOption('runtime_metrics', true);
			const stmt = db.prepare(sql);
			try {
				for await (const _ of stmt.all()) { /* drain — counts complete only once drained */ }
				expect(stmt.getWorkCounters()!.tables['main.d'].rowsScanned).to.equal(1);
			} finally {
				await stmt.finalize();
			}
		});

		it('prefers the index that also uses a range on the next column', async () => {
			await db.exec('create table rk (k text, r integer, z integer, primary key (k, r))');
			await db.exec('create index rk_kz on rk (k, z)');
			expect(await seekDetail("select z from rk where k = 'a' and r > 3")).to.match(/USING primary\b/);
		});

		it('prefers the longer prefix over one declared earlier', async () => {
			await db.exec('create table rk (k text, z integer, r integer, s integer, primary key (k, z))');
			await db.exec('create unique index rk_krs on rk (k, r, s)');
			expect(await seekDetail("select z from rk where k = 'a' and r = 3")).to.match(/USING rk_krs\b/);
		});

		it('keeps the index order under a null test on a collated column', async () => {
			// A null test compares nothing under a collation, so it is no reason to keep the Sort.
			await db.exec('create table nn (k text collate nocase not null, id integer primary key)');
			await db.exec('create index nn_k on nn (k)');
			expect(await planOps(db, 'select k from nn where k is not null order by k')).to.not.include('SORT');
		});
	});

	describe('no index available falls back to SeqScan', () => {
		it('uses SeqScan for predicate on non-indexed column', async () => {
			const q = "SELECT id FROM products WHERE name = 'Widget'";
			const ops = await planOps(db, q);

			const hasSeqScan = ops.includes('SEQSCAN');
			const hasFilter = ops.includes('FILTER');

			expect(hasSeqScan || hasFilter,
				'Non-indexed column filter should use SeqScan or FILTER above scan'
			).to.equal(true);
		});
	});
});
