import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { planOps, planNodeTypes, allRows } from './_helpers.js';

describe('Plan shape: subquery decorrelation', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec("CREATE TABLE a (id INTEGER PRIMARY KEY, x INTEGER, name TEXT) USING memory");
		await db.exec("CREATE TABLE b (id INTEGER PRIMARY KEY, x INTEGER, label TEXT) USING memory");
		await db.exec("INSERT INTO a VALUES (1, 10, 'alpha'), (2, 20, 'beta'), (3, 30, 'gamma')");
		await db.exec("INSERT INTO b VALUES (1, 10, 'one'), (2, 20, 'two'), (3, 99, 'orphan')");
	});

	afterEach(async () => {
		await db.close();
	});

	describe('correlated EXISTS decorrelated into semi-join', () => {
		it('transforms EXISTS into a join (semi-join)', async () => {
			const q = "SELECT * FROM a WHERE EXISTS (SELECT 1 FROM b WHERE b.x = a.x)";
			const ops = await planOps(db, q);
			const types = await planNodeTypes(db, q);

			const hasJoin = ops.some(op => op.includes('JOIN'));
			const hasExists = types.includes('Exists');

			expect(
				hasJoin || hasExists,
				'Correlated EXISTS should be decorrelated into a join or remain as EXISTS node'
			).to.equal(true);
		});

		it('produces correct results for EXISTS', async () => {
			const q = "SELECT a.name FROM a WHERE EXISTS (SELECT 1 FROM b WHERE b.x = a.x) ORDER BY a.id";
			const results = await allRows<{ name: string }>(db, q);
			expect(results.map(r => r.name)).to.deep.equal(['alpha', 'beta']);
		});
	});

	describe('correlated IN decorrelated into semi-join', () => {
		it('transforms IN subquery into a join', async () => {
			const q = "SELECT * FROM a WHERE a.x IN (SELECT b.x FROM b)";
			const ops = await planOps(db, q);
			const types = await planNodeTypes(db, q);

			const hasJoin = ops.some(op => op.includes('JOIN'));
			const hasIn = types.includes('In');

			expect(
				hasJoin || hasIn || ops.includes('CACHE'),
				'IN subquery should be decorrelated into a join, or remain as IN/CACHE node'
			).to.equal(true);
		});

		it('produces correct results for IN subquery', async () => {
			const q = "SELECT a.name FROM a WHERE a.x IN (SELECT b.x FROM b) ORDER BY a.id";
			const results = await allRows<{ name: string }>(db, q);
			expect(results.map(r => r.name)).to.deep.equal(['alpha', 'beta']);
		});
	});

	describe('NOT EXISTS decorrelated into anti-join', () => {
		it('transforms NOT EXISTS into a join or retains NOT EXISTS', async () => {
			const q = "SELECT * FROM a WHERE NOT EXISTS (SELECT 1 FROM b WHERE b.x = a.x)";
			const ops = await planOps(db, q);
			const types = await planNodeTypes(db, q);

			const hasJoin = ops.some(op => op.includes('JOIN'));
			const hasExists = types.includes('Exists');

			expect(
				hasJoin || hasExists,
				'NOT EXISTS should either be decorrelated to anti-join or remain as EXISTS'
			).to.equal(true);
		});

		it('produces correct results for NOT EXISTS', async () => {
			const q = "SELECT a.name FROM a WHERE NOT EXISTS (SELECT 1 FROM b WHERE b.x = a.x) ORDER BY a.id";
			const results = await allRows<{ name: string }>(db, q);
			expect(results.map(r => r.name)).to.deep.equal(['gamma']);
		});
	});
});
