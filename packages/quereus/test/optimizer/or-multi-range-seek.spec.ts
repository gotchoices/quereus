import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { SqlValue } from '../../src/common/types.js';

type ResultRow = Record<string, SqlValue>;

describe('OR multi-range seek', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	async function setupProducts(): Promise<void> {
		await db.exec(`CREATE TABLE products (
			id INTEGER PRIMARY KEY,
			name TEXT,
			price REAL,
			score INTEGER
		) USING memory`);
		await db.exec(`INSERT INTO products VALUES
			(1, 'Cheap', 5.0, 15),
			(2, 'Budget', 8.0, 25),
			(3, 'Mid', 50.0, 55),
			(4, 'Premium', 200.0, 85),
			(5, 'Luxury', 1500.0, 95),
			(6, 'UltraLux', 3000.0, 100),
			(7, 'Free', 0.0, 5),
			(8, 'Moderate', 100.0, 60)`);
		await db.exec("CREATE INDEX idx_price ON products(price)");
		await db.exec("CREATE INDEX idx_score ON products(score)");
	}

	// --- Core functionality tests ---

	it('disjoint ranges: price > 1000 OR price < 10', async () => {
		await setupProducts();
		const q = "SELECT name FROM products WHERE price > 1000 OR price < 10 ORDER BY name";
		const results: ResultRow[] = [];
		for await (const r of db.eval(q)) results.push(r);
		expect(results.map(r => r.name)).to.deep.equal(['Budget', 'Cheap', 'Free', 'Luxury', 'UltraLux']);
	});

	it('bounded ranges: score BETWEEN 90 AND 100 OR score BETWEEN 0 AND 10', async () => {
		await setupProducts();
		const q = "SELECT name FROM products WHERE (score >= 90 AND score <= 100) OR (score >= 0 AND score <= 10) ORDER BY name";
		const results: ResultRow[] = [];
		for await (const r of db.eval(q)) results.push(r);
		expect(results.map(r => r.name)).to.deep.equal(['Free', 'Luxury', 'UltraLux']);
	});

	it('mixed equality + range: price = 50 OR price > 1000', async () => {
		await setupProducts();
		const q = "SELECT name FROM products WHERE price = 50 OR price > 1000 ORDER BY name";
		const results: ResultRow[] = [];
		for await (const r of db.eval(q)) results.push(r);
		expect(results.map(r => r.name)).to.deep.equal(['Luxury', 'Mid', 'UltraLux']);
	});

	it('three branches: price > 2000 OR price < 1 OR price = 100', async () => {
		await setupProducts();
		const q = "SELECT name FROM products WHERE price > 2000 OR price < 1 OR price = 100 ORDER BY name";
		const results: ResultRow[] = [];
		for await (const r of db.eval(q)) results.push(r);
		expect(results.map(r => r.name)).to.deep.equal(['Free', 'Moderate', 'UltraLux']);
	});

	// --- Plan verification tests ---

	it('uses IndexSeek (not SeqScan) for OR-range on indexed column', async () => {
		await setupProducts();
		const q = "SELECT name FROM products WHERE price > 1000 OR price < 10";
		const planRows: ResultRow[] = [];
		for await (const r of db.eval("SELECT json_group_array(op) AS ops FROM query_plan(?)", [q])) {
			planRows.push(r);
		}
		expect(planRows).to.have.lengthOf(1);
		const ops = planRows[0].ops as string;
		expect(ops).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
	});

	// --- On primary key ---

	it('OR-range on primary key column', async () => {
		await setupProducts();
		const q = "SELECT name FROM products WHERE id > 6 OR id < 3 ORDER BY name";
		const results: ResultRow[] = [];
		for await (const r of db.eval(q)) results.push(r);
		expect(results.map(r => r.name)).to.deep.equal(['Budget', 'Cheap', 'Free', 'Moderate']);
	});

	// --- Edge cases ---

	it('no matching rows in any range', async () => {
		await setupProducts();
		const q = "SELECT name FROM products WHERE price > 5000 OR price < -1 ORDER BY name";
		const results: ResultRow[] = [];
		for await (const r of db.eval(q)) results.push(r);
		expect(results).to.have.lengthOf(0);
	});

	it('single row matches in each range', async () => {
		await setupProducts();
		const q = "SELECT name FROM products WHERE price > 2500 OR price < 1 ORDER BY name";
		const results: ResultRow[] = [];
		for await (const r of db.eval(q)) results.push(r);
		expect(results.map(r => r.name)).to.deep.equal(['Free', 'UltraLux']);
	});

	// --- Regression: existing single-range still works ---

	it('single range scan still works (regression)', async () => {
		await setupProducts();
		const q = "SELECT name FROM products WHERE price > 100 ORDER BY name";
		const results: ResultRow[] = [];
		for await (const r of db.eval(q)) results.push(r);
		expect(results.map(r => r.name)).to.deep.equal(['Luxury', 'Premium', 'UltraLux']);
	});

	it('IN-list multi-seek still works (regression)', async () => {
		await setupProducts();
		const q = "SELECT name FROM products WHERE price IN (5.0, 50.0, 1500.0) ORDER BY name";
		const results: ResultRow[] = [];
		for await (const r of db.eval(q)) results.push(r);
		expect(results.map(r => r.name)).to.deep.equal(['Cheap', 'Luxury', 'Mid']);
	});
});
