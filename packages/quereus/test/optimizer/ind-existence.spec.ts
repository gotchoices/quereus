import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { SqlValue } from '../../src/common/types.js';

type ResultRow = Record<string, SqlValue>;

interface PlanRow {
	node_type: string;
	op: string;
	detail: string;
	properties: string | null;
	physical: string | null;
}

const JOIN_OPS = new Set([
	'JOIN',
	'HASHJOIN',
	'MERGEJOIN',
	'NESTEDLOOPJOIN',
	'BLOOMJOIN',
	'ASOFSCAN',
]);

async function planRows(db: Database, sql: string): Promise<PlanRow[]> {
	const rows: PlanRow[] = [];
	for await (const r of db.eval(
		'SELECT node_type, op, detail, properties, physical FROM query_plan(?)',
		[sql],
	)) {
		rows.push(r as unknown as PlanRow);
	}
	return rows;
}

function joinCount(rows: readonly PlanRow[]): number {
	return rows.filter(r => JOIN_OPS.has(r.op)).length;
}

function referencesParent(rows: readonly PlanRow[], parentName: string): boolean {
	// Inspect only the rows that actually access tables (TableReference / scan
	// nodes). Substring-matching `detail` of every node would false-positive on
	// columns like `parent_id` that contain the parent table's name.
	const wantedTable = parentName.toLowerCase();
	for (const r of rows) {
		const detail = (r.detail ?? '').toLowerCase();
		if (r.op === 'TABLEREFERENCE' && detail.endsWith('.' + wantedTable)) return true;
		if ((r.op === 'INDEXSCAN' || r.op === 'INDEXSEEK' || r.op === 'SEQSCAN') &&
			new RegExp(`\\b${wantedTable}\\b`).test(detail)) {
			return true;
		}
	}
	return false;
}

async function results(db: Database, sql: string): Promise<ResultRow[]> {
	const rows: ResultRow[] = [];
	for await (const r of db.eval(sql)) rows.push(r);
	return rows;
}

describe('IND-driven existence folding', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	async function setupSchema(): Promise<void> {
		await db.exec(
			"CREATE TABLE parent (id INTEGER PRIMARY KEY, label TEXT) USING memory",
		);
		await db.exec(
			"CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id), payload TEXT) USING memory",
		);
		await db.exec(
			"CREATE TABLE child_nullable (id INTEGER PRIMARY KEY, parent_id INTEGER NULL REFERENCES parent(id), payload TEXT) USING memory",
		);
		await db.exec("INSERT INTO parent VALUES (1, 'p1'), (2, 'p2')");
		await db.exec("INSERT INTO child VALUES (10, 1, 'a'), (11, 2, 'b'), (12, 1, 'c')");
		await db.exec(
			"INSERT INTO child_nullable VALUES (20, 1, 'a'), (21, NULL, 'orphan'), (22, 2, 'c')",
		);
	}

	it('folds NOT EXISTS over a non-null FK to an empty result', async () => {
		await setupSchema();
		const q = 'SELECT id FROM child c WHERE NOT EXISTS (SELECT 1 FROM parent p WHERE p.id = c.parent_id)';

		const plan = await planRows(db, q);
		expect(joinCount(plan), `plan ops=${plan.map(r => r.op).join(',')}`).to.equal(0);
		expect(referencesParent(plan, 'parent'), 'parent must not be referenced in the plan').to.equal(false);
		// Canonical shape: anti-join-fk-empty emits EmptyRelationNode; the
		// const-fold pass cascades through Project so the final plan contains
		// an EMPTYRELATION op (no SeqScan of child either).
		expect(plan.some(r => r.op === 'EMPTYRELATION'), `plan ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
		expect(plan.some(r => r.op === 'SEQSCAN'), `plan ops=${plan.map(r => r.op).join(',')}`).to.equal(false);

		const out = await results(db, q);
		expect(out).to.have.lengthOf(0);
	});

	it('folds EXISTS over a non-null FK to the child rows (no parent access)', async () => {
		await setupSchema();
		const q = 'SELECT id FROM child c WHERE EXISTS (SELECT 1 FROM parent p WHERE p.id = c.parent_id)';

		const plan = await planRows(db, q);
		expect(joinCount(plan), `plan ops=${plan.map(r => r.op).join(',')}`).to.equal(0);
		expect(referencesParent(plan, 'parent'), 'parent must not be referenced in the plan').to.equal(false);

		const out = await results(db, q + ' ORDER BY id');
		expect(out.map(r => r.id)).to.deep.equal([10, 11, 12]);
	});

	it('folds EXISTS over a nullable FK to a NOT NULL guard (no parent access)', async () => {
		await setupSchema();
		const q = 'SELECT id FROM child_nullable c WHERE EXISTS (SELECT 1 FROM parent p WHERE p.id = c.parent_id)';

		const plan = await planRows(db, q);
		expect(joinCount(plan), `plan ops=${plan.map(r => r.op).join(',')}`).to.equal(0);
		expect(referencesParent(plan, 'parent'), 'parent must not be referenced in the plan').to.equal(false);

		const out = await results(db, q + ' ORDER BY id');
		// Only rows with non-null parent_id survive: rows 20 and 22 (21 has NULL).
		expect(out.map(r => r.id)).to.deep.equal([20, 22]);
	});

	it('NOT EXISTS with nullable FK keeps the antijoin but result is correct', async () => {
		await setupSchema();
		// child_nullable has one orphan row (parent_id = NULL); its NOT EXISTS must
		// return the orphan (no parent matches NULL fk).
		const q = 'SELECT id FROM child_nullable c WHERE NOT EXISTS (SELECT 1 FROM parent p WHERE p.id = c.parent_id)';

		const out = await results(db, q + ' ORDER BY id');
		expect(out.map(r => r.id)).to.deep.equal([21]);
	});

	it('folds count(*) over an inner FK join (count == child rowcount)', async () => {
		await setupSchema();
		const q = 'SELECT count(*) AS cnt FROM child c JOIN parent p ON p.id = c.parent_id';

		const plan = await planRows(db, q);
		expect(joinCount(plan), `plan ops=${plan.map(r => r.op).join(',')}`).to.equal(0);
		expect(referencesParent(plan, 'parent'), 'parent must not be referenced in the plan').to.equal(false);

		const out = await results(db, q);
		expect(out).to.have.lengthOf(1);
		expect(out[0].cnt).to.equal(3);
	});

	it('count(*) over an inner FK join with nullable FK matches count(child WHERE fk IS NOT NULL)', async () => {
		await setupSchema();
		const q = 'SELECT count(*) AS cnt FROM child_nullable c JOIN parent p ON p.id = c.parent_id';

		const out = await results(db, q);
		expect(out).to.have.lengthOf(1);
		// child_nullable has 3 rows; one has NULL parent_id and would not survive
		// an inner join. So count is 2.
		expect(out[0].cnt).to.equal(2);
	});

	it('does NOT fold EXISTS when the FK is undeclared', async () => {
		await db.exec(
			"CREATE TABLE parents (id INTEGER PRIMARY KEY, label TEXT) USING memory",
		);
		await db.exec(
			// No REFERENCES clause: there is no declared IND, so the rule must abstain.
			"CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL, payload TEXT) USING memory",
		);
		await db.exec("INSERT INTO parents VALUES (1, 'p1')");
		await db.exec("INSERT INTO children VALUES (10, 1, 'a'), (11, 99, 'orphan')");

		const q = 'SELECT id FROM children c WHERE NOT EXISTS (SELECT 1 FROM parents p WHERE p.id = c.parent_id)';
		const plan = await planRows(db, q);
		// Without an FK the IND rule must abstain — decorrelation's anti-join
		// must survive in the plan.
		expect(joinCount(plan), `plan ops=${plan.map(r => r.op).join(',')}`).to.be.greaterThan(0);
		const out = await results(db, q + ' ORDER BY id');
		expect(out.map(r => r.id)).to.deep.equal([11]);
	});

	it('folds composite-FK EXISTS regardless of equi-pair declaration order', async () => {
		await db.exec(
			"CREATE TABLE pcomp (a INTEGER NOT NULL, b INTEGER NOT NULL, label TEXT, PRIMARY KEY (a, b)) USING memory",
		);
		await db.exec(
			"CREATE TABLE ccomp (id INTEGER PRIMARY KEY, fa INTEGER NOT NULL, fb INTEGER NOT NULL, FOREIGN KEY (fa, fb) REFERENCES pcomp(a, b)) USING memory",
		);
		await db.exec("INSERT INTO pcomp VALUES (1, 10, 'p1'), (2, 20, 'p2')");
		await db.exec("INSERT INTO ccomp VALUES (100, 1, 10), (101, 2, 20), (102, 1, 10)");

		// Equi pairs in the order parent-first
		const q1 = 'SELECT id FROM ccomp c WHERE EXISTS (SELECT 1 FROM pcomp p WHERE p.a = c.fa AND p.b = c.fb)';
		const plan1 = await planRows(db, q1);
		expect(joinCount(plan1), `q1 ops=${plan1.map(r => r.op).join(',')}`).to.equal(0);
		expect(referencesParent(plan1, 'pcomp')).to.equal(false);

		// Equi pairs in the opposite order — same FK alignment in permutation.
		const q2 = 'SELECT id FROM ccomp c WHERE EXISTS (SELECT 1 FROM pcomp p WHERE c.fb = p.b AND c.fa = p.a)';
		const plan2 = await planRows(db, q2);
		expect(joinCount(plan2), `q2 ops=${plan2.map(r => r.op).join(',')}`).to.equal(0);
		expect(referencesParent(plan2, 'pcomp')).to.equal(false);

		const out1 = await results(db, q1 + ' ORDER BY id');
		expect(out1.map(r => r.id)).to.deep.equal([100, 101, 102]);

		const out2 = await results(db, q2 + ' ORDER BY id');
		expect(out2.map(r => r.id)).to.deep.equal([100, 101, 102]);
	});

	it('does NOT fold composite-FK EXISTS when equi-pairs are misaligned with the FK pairing', async () => {
		await db.exec(
			"CREATE TABLE pcomp (a INTEGER NOT NULL, b INTEGER NOT NULL, label TEXT, PRIMARY KEY (a, b)) USING memory",
		);
		await db.exec(
			"CREATE TABLE ccomp (id INTEGER PRIMARY KEY, fa INTEGER NOT NULL, fb INTEGER NOT NULL, FOREIGN KEY (fa, fb) REFERENCES pcomp(a, b)) USING memory",
		);
		await db.exec("INSERT INTO pcomp VALUES (1, 10, 'p1'), (2, 20, 'p2')");
		await db.exec("INSERT INTO ccomp VALUES (100, 1, 10), (101, 2, 20)");

		// Predicate pairs fa with b and fb with a — a permuted set NOT covered by
		// the FK declaration (fa, fb) REFERENCES pcomp(a, b). No pcomp row has
		// (a, b) = (10, 1) or (20, 2), so the correct answer is empty.
		const q = 'SELECT id FROM ccomp c WHERE EXISTS (SELECT 1 FROM pcomp p WHERE p.a = c.fb AND p.b = c.fa)';

		const plan = await planRows(db, q);
		expect(joinCount(plan), `plan ops=${plan.map(r => r.op).join(',')}`).to.be.greaterThan(0);

		const out = await results(db, q + ' ORDER BY id');
		expect(out.map(r => r.id)).to.deep.equal([]);
	});

	it('does NOT fold composite-FK NOT EXISTS when equi-pairs are misaligned with the FK pairing', async () => {
		await db.exec(
			"CREATE TABLE pcomp (a INTEGER NOT NULL, b INTEGER NOT NULL, label TEXT, PRIMARY KEY (a, b)) USING memory",
		);
		await db.exec(
			"CREATE TABLE ccomp (id INTEGER PRIMARY KEY, fa INTEGER NOT NULL, fb INTEGER NOT NULL, FOREIGN KEY (fa, fb) REFERENCES pcomp(a, b)) USING memory",
		);
		await db.exec("INSERT INTO pcomp VALUES (1, 10, 'p1'), (2, 20, 'p2')");
		await db.exec("INSERT INTO ccomp VALUES (100, 1, 10), (101, 2, 20)");

		// Permuted equi-pair set — the FK does NOT guarantee this inclusion, so
		// NOT EXISTS must return every child row.
		const q = 'SELECT id FROM ccomp c WHERE NOT EXISTS (SELECT 1 FROM pcomp p WHERE p.a = c.fb AND p.b = c.fa)';

		const out = await results(db, q + ' ORDER BY id');
		expect(out.map(r => r.id)).to.deep.equal([100, 101]);
	});

	it('three-column composite FK: only the canonical pairing folds; all 5 permutations abstain', async () => {
		await db.exec(
			"CREATE TABLE p3 (a INTEGER NOT NULL, b INTEGER NOT NULL, c INTEGER NOT NULL, label TEXT, PRIMARY KEY (a, b, c)) USING memory",
		);
		await db.exec(
			"CREATE TABLE c3 (id INTEGER PRIMARY KEY, fa INTEGER NOT NULL, fb INTEGER NOT NULL, fc INTEGER NOT NULL, FOREIGN KEY (fa, fb, fc) REFERENCES p3(a, b, c)) USING memory",
		);
		await db.exec("INSERT INTO p3 VALUES (1, 10, 100, 'p1'), (2, 20, 200, 'p2')");
		await db.exec("INSERT INTO c3 VALUES (1000, 1, 10, 100), (1001, 2, 20, 200)");

		// Canonical pairing fa→a, fb→b, fc→c: must fold, returns all child rows.
		const qCanon =
			'SELECT id FROM c3 c WHERE EXISTS (SELECT 1 FROM p3 p WHERE p.a = c.fa AND p.b = c.fb AND p.c = c.fc)';
		const planCanon = await planRows(db, qCanon);
		expect(joinCount(planCanon), `canon ops=${planCanon.map(r => r.op).join(',')}`).to.equal(0);
		expect(referencesParent(planCanon, 'p3')).to.equal(false);
		const outCanon = await results(db, qCanon + ' ORDER BY id');
		expect(outCanon.map(r => r.id)).to.deep.equal([1000, 1001]);

		// All five non-canonical permutations of (fa,fb,fc) ↔ (a,b,c) must NOT
		// fold and (with the seeded data) must return zero rows.
		const permutations: Array<[string, string, string]> = [
			// (fa→a, fb→c, fc→b)
			['p.a = c.fa', 'p.c = c.fb', 'p.b = c.fc'],
			// (fa→b, fb→a, fc→c)
			['p.b = c.fa', 'p.a = c.fb', 'p.c = c.fc'],
			// (fa→b, fb→c, fc→a)
			['p.b = c.fa', 'p.c = c.fb', 'p.a = c.fc'],
			// (fa→c, fb→a, fc→b)
			['p.c = c.fa', 'p.a = c.fb', 'p.b = c.fc'],
			// (fa→c, fb→b, fc→a)
			['p.c = c.fa', 'p.b = c.fb', 'p.a = c.fc'],
		];
		for (const [e1, e2, e3] of permutations) {
			const q = `SELECT id FROM c3 c WHERE EXISTS (SELECT 1 FROM p3 p WHERE ${e1} AND ${e2} AND ${e3})`;
			const plan = await planRows(db, q);
			expect(joinCount(plan), `perm ${e1}/${e2}/${e3} ops=${plan.map(r => r.op).join(',')}`).to.be.greaterThan(0);
			const out = await results(db, q + ' ORDER BY id');
			expect(out.map(r => r.id), `perm ${e1}/${e2}/${e3} result`).to.deep.equal([]);
		}
	});

	it('chained NOT EXISTS folds at every level when each FK covers', async () => {
		await db.exec(
			"CREATE TABLE grandparent (id INTEGER PRIMARY KEY, label TEXT) USING memory",
		);
		await db.exec(
			"CREATE TABLE parent2 (id INTEGER PRIMARY KEY, gp_id INTEGER NOT NULL REFERENCES grandparent(id)) USING memory",
		);
		await db.exec(
			"CREATE TABLE child2 (id INTEGER PRIMARY KEY, p_id INTEGER NOT NULL REFERENCES parent2(id)) USING memory",
		);
		await db.exec("INSERT INTO grandparent VALUES (1, 'g1')");
		await db.exec("INSERT INTO parent2 VALUES (10, 1)");
		await db.exec("INSERT INTO child2 VALUES (100, 10)");

		// Outer NOT EXISTS over a non-null FK should fold to empty regardless of
		// the inner clause shape. The Structural pass runs to a fixed point so
		// chained folds compose.
		const q = `SELECT id FROM child2 c WHERE NOT EXISTS (
			SELECT 1 FROM parent2 p WHERE p.id = c.p_id
		)`;
		const plan = await planRows(db, q);
		expect(joinCount(plan), `plan ops=${plan.map(r => r.op).join(',')}`).to.equal(0);
		// Fold pass cascades through the outer Project so the plan reduces to
		// a single EmptyRelation node.
		expect(plan.some(r => r.op === 'EMPTYRELATION'), `plan ops=${plan.map(r => r.op).join(',')}`).to.equal(true);

		const out = await results(db, q);
		expect(out).to.have.lengthOf(0);
	});

	it('does NOT fold when the parent side has a row-reducing filter', async () => {
		await setupSchema();
		// `SELECT id FROM parent WHERE id = 1` survives as a filtered subquery on
		// the antijoin's right side. The IND `child.parent_id ⊆ parent.id`
		// doesn't carry through that filter, so the rule must abstain.
		const q = 'SELECT c.id FROM child c WHERE NOT EXISTS (SELECT 1 FROM parent p WHERE p.id = c.parent_id AND p.id = 1)';
		const out = await results(db, q + ' ORDER BY c.id');
		// child rows with parent_id != 1: row 11 (parent_id=2). Row 10 and 12 have parent_id=1.
		expect(out.map(r => r.id)).to.deep.equal([11]);
	});
});
