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

async function results(db: Database, sql: string): Promise<ResultRow[]> {
	const rows: ResultRow[] = [];
	for await (const r of db.eval(sql)) rows.push(r);
	return rows;
}

/** Run `sql` with the aggregate-anchored elimination rule disabled (the baseline). */
async function resultsNoAggElim(db: Database, sql: string): Promise<ResultRow[]> {
	const base = db.optimizer.tuning;
	db.optimizer.updateTuning({
		...base,
		disabledRules: new Set([...(base.disabledRules ?? []), 'join-elimination-aggregate']),
	});
	try {
		return await results(db, sql);
	} finally {
		db.optimizer.updateTuning(base);
	}
}

describe('ruleJoinElimination', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	async function setupCustomersOrders(): Promise<void> {
		await db.exec(
			"CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, region TEXT) USING memory",
		);
		await db.exec(
			"CREATE TABLE orders (order_id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), total REAL) USING memory",
		);
		await db.exec("INSERT INTO customers VALUES (1, 'Acme', 'EU'), (2, 'Beta', 'US')");
		await db.exec("INSERT INTO orders VALUES (10, 1, 99.0), (11, 2, 49.5), (12, 1, 12.0)");
	}

	it('eliminates LEFT JOIN when no right-side columns are referenced', async () => {
		await setupCustomersOrders();
		const q =
			'SELECT order_id, total FROM orders LEFT JOIN customers ON orders.customer_id = customers.id';

		const rows = await planRows(db, q);
		expect(joinCount(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(0);

		const out = await results(db, q + ' ORDER BY order_id');
		expect(out).to.have.lengthOf(3);
		expect(out.map(r => r.order_id)).to.deep.equal([10, 11, 12]);
		expect(out.map(r => r.total)).to.deep.equal([99.0, 49.5, 12.0]);
	});

	it('does NOT eliminate when a right-side column is in the projection', async () => {
		await setupCustomersOrders();
		const q =
			'SELECT order_id, customers.name FROM orders LEFT JOIN customers ON orders.customer_id = customers.id';

		const rows = await planRows(db, q);
		expect(joinCount(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.be.greaterThan(0);

		const out = await results(db, q + ' ORDER BY order_id');
		expect(out).to.have.lengthOf(3);
		expect(out.map(r => r.name)).to.deep.equal(['Acme', 'Beta', 'Acme']);
	});

	it('does NOT eliminate when a right-side column is referenced above the join (WHERE)', async () => {
		await setupCustomersOrders();
		// Wrap the join in a CTE so the outer WHERE survives as a residual filter
		// sitting above the join (predicate-pushdown will still push it through
		// the CTE boundary into a Filter atop the join — that Filter forces a
		// reference into the right side, which keeps the join).
		const q = `WITH j AS (
			SELECT orders.order_id, orders.total, customers.region
			FROM orders LEFT JOIN customers ON orders.customer_id = customers.id
		) SELECT order_id FROM j WHERE region IS NOT NULL`;

		const rows = await planRows(db, q);
		expect(joinCount(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.be.greaterThan(0);
	});

	it('eliminates INNER JOIN when FK is NOT NULL', async () => {
		await setupCustomersOrders();
		const q =
			'SELECT order_id FROM orders JOIN customers ON orders.customer_id = customers.id';

		const rows = await planRows(db, q);
		expect(joinCount(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(0);

		const out = await results(db, q + ' ORDER BY order_id');
		expect(out).to.have.lengthOf(3);
		expect(out.map(r => r.order_id)).to.deep.equal([10, 11, 12]);
	});

	it('does NOT eliminate INNER JOIN when composite FK equi-pairs are misaligned with the FK pairing', async () => {
		await db.exec(
			"CREATE TABLE pcomp (a INTEGER NOT NULL, b INTEGER NOT NULL, label TEXT, PRIMARY KEY (a, b)) USING memory",
		);
		await db.exec(
			"CREATE TABLE ccomp (id INTEGER PRIMARY KEY, fa INTEGER NOT NULL, fb INTEGER NOT NULL, FOREIGN KEY (fa, fb) REFERENCES pcomp(a, b)) USING memory",
		);
		await db.exec("INSERT INTO pcomp VALUES (1, 10, 'p1'), (2, 20, 'p2')");
		await db.exec("INSERT INTO ccomp VALUES (100, 1, 10), (101, 2, 20)");

		// ON clause pairs fa with b and fb with a — a permuted set NOT covered by
		// the FK declaration (fa, fb) REFERENCES pcomp(a, b). The join must
		// survive in the plan and the result is the unfolded answer (empty).
		const q = 'SELECT id FROM ccomp c JOIN pcomp p ON p.a = c.fb AND p.b = c.fa';

		const rows = await planRows(db, q);
		expect(joinCount(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.be.greaterThan(0);

		const out = await results(db, q + ' ORDER BY id');
		expect(out.map(r => r.id)).to.deep.equal([]);
	});

	it('does NOT eliminate INNER JOIN when the FK column is nullable', async () => {
		await db.exec(
			"CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT) USING memory",
		);
		// `INTEGER NULL` overrides the Third-Manifesto-default NOT NULL.
		await db.exec(
			"CREATE TABLE orders (order_id INTEGER PRIMARY KEY, customer_id INTEGER NULL REFERENCES customers(id), total REAL) USING memory",
		);
		await db.exec("INSERT INTO customers VALUES (1, 'Acme')");
		await db.exec("INSERT INTO orders VALUES (10, 1, 99.0), (11, 1, 49.5)");

		const q =
			'SELECT order_id FROM orders JOIN customers ON orders.customer_id = customers.id';
		const rows = await planRows(db, q);
		expect(joinCount(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.be.greaterThan(0);
	});

	it('does NOT eliminate when no FK is declared', async () => {
		await db.exec(
			"CREATE TABLE parents (id INTEGER PRIMARY KEY, name TEXT) USING memory",
		);
		await db.exec(
			"CREATE TABLE children (child_id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL, val INTEGER) USING memory",
		);
		await db.exec("INSERT INTO parents VALUES (1, 'p1')");
		await db.exec("INSERT INTO children VALUES (10, 1, 100)");

		const q =
			'SELECT child_id, val FROM children LEFT JOIN parents ON children.parent_id = parents.id';
		const rows = await planRows(db, q);
		expect(joinCount(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.be.greaterThan(0);
	});

	it('does NOT eliminate FULL OUTER / CROSS joins via the Project-based rule', async () => {
		await setupCustomersOrders();
		// CROSS JOIN
		const cross =
			'SELECT order_id FROM orders CROSS JOIN customers';
		const crossPlan = await planRows(db, cross);
		expect(joinCount(crossPlan), `cross ops=${crossPlan.map(r => r.op).join(',')}`).to.be.greaterThan(0);

		// SEMI / ANTI without FK coverage: decorrelation produces a semi-join, the
		// IND-existence folding rules abstain (no declared FK), and ruleJoinElimination
		// itself never fires on SEMI/ANTI shapes — so a join op must survive.
		await db.exec("CREATE TABLE plain_parent (id INTEGER PRIMARY KEY, label TEXT) USING memory");
		await db.exec("CREATE TABLE plain_child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL, payload TEXT) USING memory");
		await db.exec("INSERT INTO plain_parent VALUES (1, 'p1')");
		await db.exec("INSERT INTO plain_child VALUES (10, 1, 'a')");
		const semi = 'SELECT id FROM plain_child c WHERE EXISTS (SELECT 1 FROM plain_parent p WHERE p.id = c.parent_id)';
		const semiPlan = await planRows(db, semi);
		const semiHasJoin = semiPlan.some(r => JOIN_OPS.has(r.op));
		expect(semiHasJoin, `semi ops=${semiPlan.map(r => r.op).join(',')}`).to.equal(true);
	});

	it('preserves result row equality across all eliminable cases', async () => {
		await setupCustomersOrders();

		// LEFT-eliminable
		const leftQ =
			'SELECT order_id, total FROM orders LEFT JOIN customers ON orders.customer_id = customers.id ORDER BY order_id';
		const leftOut = await results(db, leftQ);
		expect(leftOut).to.have.lengthOf(3);
		expect(leftOut.map(r => r.order_id)).to.deep.equal([10, 11, 12]);

		// INNER-eliminable
		const innerQ =
			'SELECT order_id FROM orders JOIN customers ON orders.customer_id = customers.id ORDER BY order_id';
		const innerOut = await results(db, innerQ);
		expect(innerOut).to.have.lengthOf(3);
		expect(innerOut.map(r => r.order_id)).to.deep.equal([10, 11, 12]);
	});

	it('does NOT eliminate INNER JOIN when PK side has a row-reducing wrapper (Filter)', async () => {
		await setupCustomersOrders();
		// Inline view with WHERE on the PK side — original query produces 2 rows
		// (orders whose customer is in EU). Naive elimination would survive all 3.
		const q = "SELECT order_id FROM orders JOIN (SELECT id FROM customers WHERE region='EU') c ON orders.customer_id = c.id";
		const out = await results(db, q + ' ORDER BY order_id');
		// customers 1 (EU) is referenced by orders 10 and 12.
		expect(out.map(r => r.order_id)).to.deep.equal([10, 12]);
	});

	it('does NOT eliminate INNER JOIN when PK side has a LimitOffset wrapper', async () => {
		await setupCustomersOrders();
		const q = "SELECT order_id FROM orders JOIN (SELECT id FROM customers ORDER BY id LIMIT 1) c ON orders.customer_id = c.id";
		const out = await results(db, q + ' ORDER BY order_id');
		// Only customer 1 survives the LIMIT, so only orders 10 and 12 match.
		expect(out.map(r => r.order_id)).to.deep.equal([10, 12]);
	});

	it('LEFT JOIN with row-reducing wrapper on non-preserved side is still safely eliminated', async () => {
		await setupCustomersOrders();
		// Filter on the non-preserved (right) side of a LEFT JOIN cannot change
		// the result row count when no right-side columns are selected, so
		// eliminating is still safe.
		const q = "SELECT order_id, total FROM orders LEFT JOIN (SELECT id FROM customers WHERE region='EU') c ON orders.customer_id = c.id";
		const out = await results(db, q + ' ORDER BY order_id');
		expect(out.map(r => r.order_id)).to.deep.equal([10, 11, 12]);
	});

	it('eliminates the inner join inside a view that selects only FK-side columns', async () => {
		await setupCustomersOrders();
		await db.exec(
			"CREATE VIEW order_view AS SELECT o.order_id, o.total, c.name AS cust_name FROM orders o LEFT JOIN customers c ON o.customer_id = c.id"
		);

		// When the outer query selects only the FK-side columns, the view's join
		// must drop out.
		const q = 'SELECT order_id, total FROM order_view ORDER BY order_id';
		const rows = await planRows(db, q);
		expect(joinCount(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(0);

		const out = await results(db, q);
		expect(out).to.have.lengthOf(3);
		expect(out.map(r => r.order_id)).to.deep.equal([10, 11, 12]);

		await db.exec('DROP VIEW order_view');
	});

	// `ruleJoinEliminationUnderAggregate` (id `join-elimination-aggregate`): the
	// Aggregate-anchored sibling of the Project entrypoint. A cardinality-only
	// aggregate (`count(*)`) over an FK→PK LEFT/RIGHT/INNER join whose
	// non-preserved side nothing reads collapses to zero join ops. The LEFT case
	// holds *unconditionally* (`|L LEFT JOIN R| == |L|`) — needing neither a
	// NOT-NULL FK nor a row-preserving R, the two checks the INNER case requires.
	describe('aggregate-anchored elimination', () => {
		it('eliminates the LEFT join under count(*) when no right-side columns are referenced', async () => {
			await setupCustomersOrders();
			const q =
				'SELECT count(*) AS n FROM orders LEFT JOIN customers ON orders.customer_id = customers.id';

			const rows = await planRows(db, q);
			expect(joinCount(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(0);

			const out = await results(db, q);
			expect(out).to.deep.equal([{ n: 3 }]);
			// Byte-equal to the rule-disabled baseline — elimination is a pure optimization.
			expect(out).to.deep.equal(await resultsNoAggElim(db, q));
		});

		it('eliminates the LEFT join under count(*) even when the FK is nullable (unmatched rows still counted)', async () => {
			// Distinct from the INNER nullable-FK case below, which KEEPS the join:
			// LEFT preserves the unmatched (null-FK) row by null-padding it, so
			// |L LEFT JOIN R| == |L| regardless of FK nullability.
			await db.exec("CREATE TABLE cust2 (id INTEGER PRIMARY KEY, name TEXT) USING memory");
			await db.exec(
				"CREATE TABLE ord2 (order_id INTEGER PRIMARY KEY, customer_id INTEGER NULL REFERENCES cust2(id), total REAL) USING memory",
			);
			await db.exec("INSERT INTO cust2 VALUES (1, 'Acme')");
			// Row 21 has a NULL FK — unmatched in the join, but LEFT keeps it.
			await db.exec("INSERT INTO ord2 VALUES (20, 1, 99.0), (21, null, 49.5), (22, 1, 12.0)");

			const q =
				'SELECT count(*) AS n FROM ord2 LEFT JOIN cust2 ON ord2.customer_id = cust2.id';
			const rows = await planRows(db, q);
			expect(joinCount(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(0);

			const out = await results(db, q);
			expect(out).to.deep.equal([{ n: 3 }]);
			expect(out).to.deep.equal(await resultsNoAggElim(db, q));
		});

		it('does NOT eliminate when an aggregate argument reads the non-preserved side', async () => {
			await setupCustomersOrders();
			const q =
				'SELECT sum(length(customers.region)) AS s FROM orders LEFT JOIN customers ON orders.customer_id = customers.id';

			const rows = await planRows(db, q);
			expect(joinCount(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.be.greaterThan(0);

			// regions EU(2)/US(2): orders 10,12 → EU, 11 → US ⇒ 2+2+2 = 6.
			const out = await results(db, q);
			expect(out).to.deep.equal([{ s: 6 }]);
		});

		it('does NOT eliminate when a GROUP BY key reads the non-preserved side', async () => {
			await setupCustomersOrders();
			const q =
				'SELECT customers.region AS region, count(*) AS n FROM orders LEFT JOIN customers ' +
				'ON orders.customer_id = customers.id GROUP BY customers.region ORDER BY region';

			const rows = await planRows(db, q);
			expect(joinCount(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.be.greaterThan(0);

			const out = await results(db, q);
			expect(out).to.deep.equal([
				{ region: 'EU', n: 2 },
				{ region: 'US', n: 1 },
			]);
		});

		it('does NOT eliminate when a live existence flag is demanded (hasExistenceColumns guard)', async () => {
			await setupCustomersOrders();
			// The flag IS demanded (an aggregate arg), so join-existence-pruning keeps
			// it; the flag's attr id is invisible to the usesRight scan, so the
			// hasExistenceColumns guard must retain the join.
			const q =
				'SELECT sum(case when hasC then 1 else 0 end) AS s FROM orders ' +
				'LEFT JOIN customers ON orders.customer_id = customers.id exists right as hasC';

			const rows = await planRows(db, q);
			expect(joinCount(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.be.greaterThan(0);

			// FK NOT NULL ⇒ every order matches ⇒ hasC always true ⇒ sum = 3.
			const out = await results(db, q);
			expect(out).to.deep.equal([{ s: 3 }]);
		});

		it('eliminates the join under count(*) once an undemanded existence flag is pruned (cascade)', async () => {
			await setupCustomersOrders();
			// The flag is unreferenced: join-existence-pruning-aggregate (priority 22)
			// strips it, then this rule eliminates the flag-free LEFT join — both in one
			// applyRules pass. (Also covered in the existence-pruning spec.)
			const q =
				'SELECT count(*) AS n FROM orders LEFT JOIN customers ' +
				'ON orders.customer_id = customers.id exists right as hasC';

			const rows = await planRows(db, q);
			expect(joinCount(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(0);

			const out = await results(db, q);
			expect(out).to.deep.equal([{ n: 3 }]);
		});
	});
});
