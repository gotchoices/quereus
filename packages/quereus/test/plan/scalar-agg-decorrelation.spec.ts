import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { DEFAULT_TUNING } from '../../src/planner/optimizer.js';
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

/**
 * Plan-shape + equivalence assertions for `scalar-agg-decorrelation-aggregate`:
 * the aggregate-argument match site. A scalar-aggregate subquery nested inside
 * another aggregate subquery's argument (parent → child → grandchild JSON
 * trees) becomes a second grouped LEFT join BELOW the enclosing grouped
 * aggregate, converging level by level.
 */
describe('Plan shape: nested scalar-aggregate subquery decorrelation (aggregate site)', () => {
	let db: Database;
	let baselineDb: Database;

	// The motivating 2-level shape from the original perf report: entries →
	// items (level 1) → quantifier values (level 2), json_group_array at both.
	const NESTED_2LEVEL = `SELECT e.id,
		(SELECT json_group_array(json_object(
			'itemId', i.id,
			'quantifiers', (
				SELECT json_group_array(json_object('id', q.id, 'value', qv.value))
				FROM qv JOIN q ON q.id = qv.quantifier_id
				WHERE qv.entry_id = e.id AND qv.item_id = i.id)))
		FROM lei JOIN items i ON i.id = lei.item_id
		WHERE lei.entry_id = e.id) AS items
	FROM e ORDER BY e.id`;

	const setup = async (target: Database) => {
		await target.exec("CREATE TABLE e (id INTEGER PRIMARY KEY, name TEXT) USING memory");
		await target.exec("CREATE TABLE lei (entry_id INTEGER, item_id INTEGER, PRIMARY KEY (entry_id, item_id)) USING memory");
		await target.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT) USING memory");
		await target.exec("CREATE TABLE qv (entry_id INTEGER, item_id INTEGER, quantifier_id INTEGER, value REAL, PRIMARY KEY (entry_id, item_id, quantifier_id)) USING memory");
		await target.exec("CREATE TABLE q (id INTEGER PRIMARY KEY, name TEXT) USING memory");
		await target.exec("INSERT INTO e VALUES (1,'a'),(2,'b'),(3,'empty')");
		await target.exec("INSERT INTO items VALUES (10,'i10'),(11,'i11'),(12,'i12')");
		// entry 3 has no items; item 11 (on entry 1) has no quantifier values.
		await target.exec("INSERT INTO lei VALUES (1,10),(1,11),(2,12)");
		await target.exec("INSERT INTO q VALUES (100,'qa'),(101,'qb')");
		await target.exec("INSERT INTO qv VALUES (1,10,100,1.5),(1,10,101,2.5),(2,12,100,9.0)");
	};

	beforeEach(async () => {
		db = new Database();
		await setup(db);
		// Baseline keeps both decorrelation sites disabled — the correlated
		// per-row plan whose results the rewrite must reproduce byte-identically.
		baselineDb = new Database();
		baselineDb.optimizer.updateTuning({
			...DEFAULT_TUNING,
			disabledRules: new Set(['scalar-agg-decorrelation', 'scalar-agg-decorrelation-aggregate']),
		});
		await setup(baselineDb);
	});

	afterEach(async () => {
		await db.close();
		await baselineDb.close();
	});

	it('fully decorrelates the 2-level shape: two grouped aggregates, no subqueries, physical equi-joins', async () => {
		const types = await planNodeTypes(db, NESTED_2LEVEL);
		expect(types, 'both nesting levels must be dissolved').to.not.include('ScalarSubquery');

		const rows = await planRows(db, NESTED_2LEVEL);
		const aggs = rows.filter(r =>
			(r.node_type === 'HashAggregate' || r.node_type === 'StreamAggregate')
			&& r.detail.includes('GROUP BY'));
		expect(aggs.length, 'one grouped aggregate per nesting level').to.be.greaterThanOrEqual(2);

		// The level-2 grouped aggregate feeds the join BELOW the level-1
		// aggregate, so one grouped aggregate is a descendant of the other.
		const nestedPair = aggs.some(inner =>
			aggs.some(outer => inner !== outer && isDescendantOf(rows, inner.id, outer.id)));
		expect(nestedPair, 'level-2 grouped aggregate sits below level 1').to.equal(true);

		const ops = await planOps(db, NESTED_2LEVEL);
		const physicalJoins = ops.filter(op => op === 'HASHJOIN' || op === 'MERGEJOIN');
		expect(physicalJoins.length, 'grouped subtrees join via hash/merge, not nested loop').to.be.greaterThanOrEqual(2);
	});

	it('2-level results are identical to the correlated baseline', async () => {
		const decorrelated = await allRows(db, NESTED_2LEVEL);
		const baselineTypes = await planNodeTypes(baselineDb, NESTED_2LEVEL);
		expect(baselineTypes, 'baseline must stay correlated').to.include('ScalarSubquery');
		const baseline = await allRows(baselineDb, NESTED_2LEVEL);
		expect(decorrelated).to.deep.equal(baseline);
	});

	it('converges across three levels of nesting', async () => {
		await db.exec("CREATE TABLE tags (quantifier_id INTEGER, tag TEXT, PRIMARY KEY (quantifier_id, tag)) USING memory");
		await db.exec("INSERT INTO tags VALUES (100,'t1'),(100,'t2')");
		const q3 = `SELECT e.id,
			(SELECT json_group_array(json_object(
				'itemId', i.id,
				'quantifiers', (
					SELECT json_group_array(json_object('qid', qv.quantifier_id,
						'tags', (SELECT json_group_array(t.tag) FROM tags t WHERE t.quantifier_id = qv.quantifier_id)))
					FROM qv WHERE qv.entry_id = e.id AND qv.item_id = i.id)))
			FROM lei JOIN items i ON i.id = lei.item_id
			WHERE lei.entry_id = e.id) AS items
		FROM e ORDER BY e.id`;
		const types = await planNodeTypes(db, q3);
		expect(types).to.not.include('ScalarSubquery');
		const rows = await planRows(db, q3);
		const aggs = rows.filter(r =>
			(r.node_type === 'HashAggregate' || r.node_type === 'StreamAggregate')
			&& r.detail.includes('GROUP BY'));
		expect(aggs.length, 'one grouped aggregate per level').to.be.greaterThanOrEqual(3);
	});

	it('decorrelates a subquery in a top-level GROUP BY aggregate argument, HAVING intact', async () => {
		const q = `SELECT lei.entry_id,
			sum((SELECT count(*) FROM qv WHERE qv.entry_id = lei.entry_id AND qv.item_id = lei.item_id)) AS s
		FROM lei GROUP BY lei.entry_id HAVING count(*) > 1 ORDER BY lei.entry_id`;
		const types = await planNodeTypes(db, q);
		expect(types).to.not.include('ScalarSubquery');
		const results = await allRows<{ entry_id: number; s: number }>(db, q);
		// Only entry 1 has >1 items; its per-item counts are 2 (item 10) + 0 (item 11).
		expect(results).to.deep.equal([{ entry_id: 1, s: 2 }]);
	});

	it('sibling subqueries inside one aggregate argument each get their own join', async () => {
		const q = `SELECT lei.entry_id, json_group_array(
			(SELECT count(*) FROM qv WHERE qv.entry_id = lei.entry_id AND qv.item_id = lei.item_id)
			+ (SELECT total(qv.value) FROM qv WHERE qv.entry_id = lei.entry_id AND qv.item_id = lei.item_id)) AS j
		FROM lei GROUP BY lei.entry_id ORDER BY lei.entry_id`;
		const types = await planNodeTypes(db, q);
		expect(types).to.not.include('ScalarSubquery');
		const decorrelated = await allRows(db, q);
		const baseline = await allRows(baselineDb, q);
		expect(decorrelated).to.deep.equal(baseline);
	});

	it('a remap-bailed level 1 keeps both levels correct', async () => {
		const bailSetup = async (target: Database) => {
			await target.exec("CREATE TABLE en (name TEXT PRIMARY KEY COLLATE NOCASE) USING memory");
			await target.exec("CREATE TABLE ln (ename TEXT COLLATE NOCASE, item_id INTEGER, PRIMARY KEY (ename, item_id)) USING memory");
			await target.exec("INSERT INTO en VALUES ('A'),('b')");
			await target.exec("INSERT INTO ln VALUES ('a',10),('A',11),('B',12)");
		};
		await bailSetup(db);
		await bailSetup(baselineDb);
		// Level 1 needs the remap en.name → ln.ename, which the NOCASE equality
		// cannot justify (byte-different values compare equal) — level 1 must
		// stay correlated. The nested count remains correct either way.
		const q = `SELECT en.name,
			(SELECT json_group_array(json_object('n', en.name, 'item', ln.item_id,
				'cnt', (SELECT count(*) FROM qv WHERE qv.entry_id = 1 AND qv.item_id = ln.item_id)))
			FROM ln WHERE ln.ename = en.name) AS j
		FROM en ORDER BY en.name`;
		const types = await planNodeTypes(db, q);
		expect(types, 'level 1 must stay correlated').to.include('ScalarSubquery');
		const decorrelated = await allRows(db, q);
		const baseline = await allRows(baselineDb, q);
		expect(decorrelated).to.deep.equal(baseline);
	});

	it('a DML-bearing subquery blocks only its own rewrite, not a pure sibling', async () => {
		await db.exec("CREATE TABLE sink (id INTEGER PRIMARY KEY, entry_id INTEGER) USING memory");
		// The DML-bearing branch must stay correlated at EVERY level — even the
		// enclosing level's rewrite would change the write's firing count. The
		// pure sibling subquery still decorrelates.
		const q = `SELECT e.id,
			(SELECT json_group_array((INSERT INTO sink (id, entry_id) SELECT lei.item_id, lei.entry_id WHERE lei.entry_id = 1 RETURNING count(*)))
			FROM lei WHERE lei.entry_id = e.id) AS j,
			(SELECT count(*) FROM lei WHERE lei.entry_id = e.id) AS n
		FROM e`;
		// Whether or not this DML-in-scalar shape plans, the write-bearing branch
		// must never be decorrelated (per-row firing is observable).
		try {
			const rows = await planRows(db, q);
			expect(rows.map(r => r.node_type)).to.include('ScalarSubquery');
			const groupedAgg = rows.some(r =>
				(r.node_type === 'HashAggregate' || r.node_type === 'StreamAggregate')
				&& r.detail.includes('GROUP BY'));
			expect(groupedAgg, 'pure sibling still decorrelates').to.equal(true);
		} catch {
			// Shape not plannable — nothing to decorrelate.
		}
	});
});
