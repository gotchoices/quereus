import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { SqlValue } from '../../src/common/types.js';

type ResultRow = Record<string, SqlValue>;

describe('Projection pruning', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		try {
			await db.exec("DROP VIEW IF EXISTS v");
		} catch (_e) { /* ignore */ }
		await db.close();
	});

	async function setup(): Promise<void> {
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, email TEXT, category TEXT, value INTEGER) USING memory");
		await db.exec("INSERT INTO t VALUES (1, 'Alpha', 'a@test.com', 'A', 100), (2, 'Beta', 'b@test.com', 'B', 200), (3, 'Gamma', 'g@test.com', 'A', 150)");
		await db.exec("CREATE VIEW v AS select id, name, email, category, value FROM t");
	}

	it('prunes unused view projections when outer selects a subset', async () => {
		await setup();
		const q = "select name FROM v";

		// Verify correctness
		const results: ResultRow[] = [];
		for await (const r of db.eval(q)) results.push(r);
		expect(results).to.have.lengthOf(3);
		expect(results[0].name).to.equal('Alpha');

		// Check plan: find PROJECT nodes and inspect projection counts
		const projects: ResultRow[] = [];
		for await (const r of db.eval("select properties FROM query_plan(?) WHERE op = 'PROJECT'", [q])) {
			projects.push(r);
		}

		// The inner (view) project should have been pruned
		// We expect at least one PROJECT with projectionCount < 5
		const counts = projects.map((p) => {
			const props = typeof p.properties === 'string' ? JSON.parse(p.properties) : p.properties;
			return (props as { projectionCount: number }).projectionCount;
		});
		// At least one project should have fewer than 5 columns (the original view width)
		expect(counts.some((c: number) => c < 5)).to.be.true;
	});

	it('returns correct results after pruning', async () => {
		await setup();
		const results: ResultRow[] = [];
		for await (const r of db.eval("select name, value FROM v WHERE id = 1")) results.push(r);
		expect(results).to.have.lengthOf(1);
		expect(results[0].name).to.equal('Alpha');
		expect(results[0].value).to.equal(100);
	});

	it('preserves all columns when all are referenced', async () => {
		await setup();
		const q = "select id, name, email, category, value FROM v";
		const results: ResultRow[] = [];
		for await (const r of db.eval(q)) results.push(r);
		expect(results).to.have.lengthOf(3);
		// Verify all columns present
		expect(Object.keys(results[0]).sort()).to.deep.equal(['category', 'email', 'id', 'name', 'value']);
	});

	it('handles join with view where only some view columns are used', async () => {
		await setup();
		await db.exec("CREATE TABLE orders (oid INTEGER PRIMARY KEY, tid INTEGER, amount INTEGER) USING memory");
		await db.exec("INSERT INTO orders VALUES (10, 1, 50), (20, 2, 75)");

		const q = "select v.name, o.amount FROM v JOIN orders o ON v.id = o.tid";
		const results: ResultRow[] = [];
		for await (const r of db.eval(q)) results.push(r);

		expect(results).to.have.lengthOf(2);
		const names = results.map(r => r.name).sort();
		expect(names).to.deep.equal(['Alpha', 'Beta']);

		await db.exec("DROP TABLE orders");
	});

	it('handles count(*) from view — can prune all but one projection', async () => {
		await setup();
		const q = "select count(*) as cnt FROM v";
		const results: ResultRow[] = [];
		for await (const r of db.eval(q)) results.push(r);
		expect(results).to.have.lengthOf(1);
		expect(results[0].cnt).to.equal(3);
	});

});
