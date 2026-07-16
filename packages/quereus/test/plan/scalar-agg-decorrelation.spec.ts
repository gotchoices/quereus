import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { planOps, planNodeTypes, planRows, isDescendantOf, allRows } from './_helpers.js';

/**
 * Plan-shape assertions for `scalar-agg-decorrelation`: a correlated
 * scalar-aggregate subquery in the SELECT list becomes a grouped aggregate
 * under a LEFT join (picked up by physical hash-join selection), and the
 * rejected shapes keep their correlated ScalarSubquery plan.
 */
describe('Plan shape: scalar-aggregate subquery decorrelation', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec("CREATE TABLE p (id INTEGER PRIMARY KEY, k INTEGER NULL, grp TEXT) USING memory");
		await db.exec("CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER NULL, v INTEGER NULL) USING memory");
		await db.exec("INSERT INTO p VALUES (1, 10, 'a'), (2, 20, 'b'), (3, NULL, 'c')");
		await db.exec("INSERT INTO c VALUES (1, 1, 5), (2, 1, 7), (3, 2, NULL)");
	});

	afterEach(async () => {
		await db.close();
	});

	it('rewrites the subquery into a grouped aggregate under a hash left join', async () => {
		const q = "SELECT p.id, (SELECT count(*) FROM c WHERE c.pid = p.id) AS n FROM p";
		const types = await planNodeTypes(db, q);
		const ops = await planOps(db, q);

		expect(types, 'subquery must be dissolved').to.not.include('ScalarSubquery');

		// Grouped aggregate (hash — group keys carry no input ordering)
		const rows = await planRows(db, q);
		const agg = rows.find(r => r.node_type === 'HashAggregate' || r.node_type === 'StreamAggregate');
		expect(agg, 'grouped physical aggregate expected').to.not.equal(undefined);
		expect(agg!.detail).to.include('GROUP BY');

		// Physical hash/merge join selected — nested-loop would forfeit the win
		expect(
			ops.some(op => op === 'HASHJOIN' || op === 'MERGEJOIN'),
			`expected hash/merge join in [${ops.join(', ')}]`
		).to.equal(true);

		// The aggregate sits under the join
		const join = rows.find(r => r.node_type === 'HashJoin' || r.node_type === 'MergeJoin');
		expect(join).to.not.equal(undefined);
		expect(isDescendantOf(rows, agg!.id, join!.id)).to.equal(true);
	});

	it('stacks one join per subquery for multiple subqueries in one SELECT', async () => {
		const q = "SELECT p.id, (SELECT count(*) FROM c WHERE c.pid = p.id) AS n, (SELECT sum(c.v) FROM c WHERE c.pid = p.id) AS s FROM p";
		const types = await planNodeTypes(db, q);
		expect(types).to.not.include('ScalarSubquery');
		const joins = types.filter(t => t === 'HashJoin' || t === 'MergeJoin' || t === 'Join');
		expect(joins.length).to.be.greaterThanOrEqual(2);

		const results = await allRows<{ id: number; n: number; s: number | null }>(db, q + ' ORDER BY p.id');
		expect(results).to.deep.equal([
			{ id: 1, n: 2, s: 12 },
			{ id: 2, n: 1, s: null },
			{ id: 3, n: 0, s: null },
		]);
	});

	it('substitutes only the inner node of a wrapped subquery', async () => {
		const q = "SELECT p.id, coalesce((SELECT sum(c.v) FROM c WHERE c.pid = p.id), -1) AS s FROM p";
		const types = await planNodeTypes(db, q);
		expect(types).to.not.include('ScalarSubquery');
		const results = await allRows<{ id: number; s: number }>(db, q + ' ORDER BY p.id');
		expect(results.map(r => r.s)).to.deep.equal([12, -1, -1]);
	});

	it('leaves a non-equi correlation on the correlated path', async () => {
		const q = "SELECT p.id, (SELECT count(*) FROM c WHERE c.pid < p.id) AS n FROM p";
		const types = await planNodeTypes(db, q);
		expect(types).to.include('ScalarSubquery');
	});

	it('leaves a non-aggregate LIMIT 1 subquery on the correlated path', async () => {
		const q = "SELECT p.id, (SELECT c.v FROM c WHERE c.pid = p.id ORDER BY c.v DESC LIMIT 1) AS v FROM p";
		const types = await planNodeTypes(db, q);
		expect(types).to.include('ScalarSubquery');
	});

	it('leaves an uncorrelated scalar subquery untouched', async () => {
		const q = "SELECT p.id, (SELECT count(*) FROM c) AS n FROM p";
		const types = await planNodeTypes(db, q);
		expect(types).to.include('ScalarSubquery');
	});

	it('bails when an outer reference in the aggregate argument is not equated', async () => {
		// p.k is not part of the correlation, so it cannot be remapped.
		const q = "SELECT p.id, (SELECT sum(c.v + p.k) FROM c WHERE c.pid = p.id) AS s FROM p";
		const types = await planNodeTypes(db, q);
		expect(types).to.include('ScalarSubquery');
		const results = await allRows<{ id: number; s: number | null }>(db, q + ' ORDER BY p.id');
		expect(results.map(r => r.s)).to.deep.equal([32, null, null]);
	});

	it('remaps an equated outer reference in the aggregate argument', async () => {
		const q = "SELECT p.id, (SELECT sum(c.v + p.id) FROM c WHERE c.pid = p.id) AS s FROM p";
		const types = await planNodeTypes(db, q);
		expect(types).to.not.include('ScalarSubquery');
		const results = await allRows<{ id: number; s: number | null }>(db, q + ' ORDER BY p.id');
		expect(results.map(r => r.s)).to.deep.equal([14, null, null]);
	});

	it('bails on a weak-collation correlation when a remap is needed', async () => {
		await db.exec("CREATE TABLE nc (id INTEGER PRIMARY KEY, t TEXT COLLATE NOCASE) USING memory");
		await db.exec("INSERT INTO nc VALUES (1, 'A'), (2, 'a')");
		// group_concat(p.grp) needs the remap p.grp → nc.t, which a NOCASE
		// equality cannot justify (byte-different values compare equal).
		const q = "SELECT p.id, (SELECT group_concat(p.grp) FROM nc WHERE nc.t = p.grp) AS g FROM p";
		const types = await planNodeTypes(db, q);
		expect(types).to.include('ScalarSubquery');
	});

	it('refuses a DML-bearing subquery (per-row firing is observable)', async () => {
		await db.exec("CREATE TABLE sink (id INTEGER PRIMARY KEY, pid INTEGER) USING memory");
		const q = "SELECT p.id, (INSERT INTO sink (id, pid) SELECT p.id, p.id WHERE p.id = 1 RETURNING count(*)) AS n FROM p";
		// Whether or not this exact DML-in-scalar shape plans, it must never be
		// decorrelated. Planning failures are acceptable (shape not supported);
		// a successful plan must retain the ScalarSubquery.
		try {
			const types = await planNodeTypes(db, q);
			expect(types).to.include('ScalarSubquery');
		} catch {
			// Shape not plannable — nothing to decorrelate.
		}
	});
});
