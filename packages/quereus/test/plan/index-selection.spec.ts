import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { planOps, allRows } from './_helpers.js';

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
