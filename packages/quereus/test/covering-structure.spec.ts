/**
 * Covering structures — coverage prover + constraint↔structure linkage +
 * introspection hiding (ticket `covering-structure-unique-enforcement`).
 *
 * The implicit-reframe regression floor (observation-equivalence of UNIQUE
 * enforcement) is guarded by the existing UNIQUE suites in test/logic/ and
 * quereus-store; this file owns the new analysis + bookkeeping surface.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { collectSchemaCatalog } from '../src/schema/catalog.js';
import { proveCoverage, proveEffectiveKeyUnique, type CoverageResult } from '../src/planner/analysis/coverage-prover.js';
import type { FunctionalDependency, PhysicalProperties, RelationalPlanNode } from '../src/planner/nodes/plan-node.js';
import type { ColRef, RelationType } from '../src/common/datatype.js';
import type { MaterializedViewSchema } from '../src/schema/view.js';
import { parseSelect } from '../src/parser/index.js';
import { INTEGER_TYPE } from '../src/types/builtin-types.js';

async function freshDb(ddl: string[]): Promise<Database> {
	const db = new Database();
	for (const stmt of ddl) await db.exec(stmt);
	return db;
}

function bodyRoot(db: Database, bodySql: string): RelationalPlanNode {
	const root = db.getPlan(bodySql).getRelations()[0];
	expect(root, 'body produced a relation').to.not.be.undefined;
	return root as RelationalPlanNode;
}

/**
 * Creates the MV, then runs the prover directly against the named UNIQUE
 * constraint on the named base table so per-reason outcomes are observable.
 */
async function prove(
	db: Database,
	mvName: string,
	bodySql: string,
	tableName: string,
	ucIndex = 0,
): Promise<CoverageResult> {
	const mv = db.schemaManager.getMaterializedView('main', mvName);
	expect(mv, 'MV registered').to.not.be.undefined;
	const table = db.schemaManager.getTable('main', tableName)!;
	const uc = table.uniqueConstraints![ucIndex];
	return proveCoverage(bodyRoot(db, bodySql), mv!, uc, table);
}

/**
 * Runs the prover against a body that is *planned but not materialized*. Needed
 * for RIGHT JOIN, which plans correctly but is not executable yet (so it cannot
 * back a real MV — `collectBodyRows` throws "RIGHT JOIN is not supported yet").
 * `proveCoverage` reads only `mv.selectAst`, so a stub carrying the parsed body
 * suffices to exercise the prover's `'right'`-join branch end to end.
 */
function proveUnmaterialized(
	db: Database,
	bodySql: string,
	tableName: string,
	ucIndex = 0,
): CoverageResult {
	const table = db.schemaManager.getTable('main', tableName)!;
	const uc = table.uniqueConstraints![ucIndex];
	const mvStub = { selectAst: parseSelect(bodySql) } as unknown as MaterializedViewSchema;
	return proveCoverage(bodyRoot(db, bodySql), mvStub, uc, table);
}

describe('coverage prover — positive', () => {
	it('select uc-cols + pk ordered by uc-cols covers a composite UNIQUE', async () => {
		const db = await freshDb([
			'create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))',
			'create materialized view ix as select x, y, id from t order by x, y',
		]);
		try {
			expect((await prove(db, 'ix', 'select x, y, id from t order by x, y', 't')).covers).to.be.true;
		} finally {
			await db.close();
		}
	});

	it('covers regardless of ORDER BY permutation of the uc columns', async () => {
		const db = await freshDb([
			'create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))',
			'create materialized view ix as select x, y, id from t order by y, x',
		]);
		try {
			expect((await prove(db, 'ix', 'select x, y, id from t order by y, x', 't')).covers).to.be.true;
		} finally {
			await db.close();
		}
	});

	it('covers a nullable single-column UNIQUE when the body skips NULLs', async () => {
		const db = await freshDb([
			'create table t (id integer primary key, x integer null, unique (x))',
			'create materialized view ix as select x, id from t where x is not null order by x',
		]);
		try {
			expect((await prove(db, 'ix', 'select x, id from t where x is not null order by x', 't')).covers).to.be.true;
		} finally {
			await db.close();
		}
	});
});

describe('coverage prover — negative (one per reason)', () => {
	async function expectReason(
		ddl: string[],
		mvName: string,
		bodySql: string,
		tableName: string,
		reason: string,
	): Promise<void> {
		const db = await freshDb(ddl);
		try {
			const result = await prove(db, mvName, bodySql, tableName);
			expect(result.covers, `expected NotCovers(${reason})`).to.be.false;
			if (!result.covers) expect(result.reason).to.equal(reason);
		} finally {
			await db.close();
		}
	}

	it('missing-uc-column', async () => {
		await expectReason(
			[
				'create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))',
				'create materialized view ix as select x, id from t order by x',
			],
			'ix', 'select x, id from t order by x', 't', 'missing-uc-column',
		);
	});

	it('missing-pk-column', async () => {
		await expectReason(
			[
				'create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))',
				'create materialized view ix as select x, y from t order by x, y',
			],
			'ix', 'select x, y from t order by x, y', 't', 'missing-pk-column',
		);
	});

	it('ordering-mismatch (no ORDER BY)', async () => {
		await expectReason(
			[
				'create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))',
				'create materialized view ix as select x, y, id from t',
			],
			'ix', 'select x, y, id from t', 't', 'ordering-mismatch',
		);
	});

	it('ordering-mismatch (partial ordering)', async () => {
		await expectReason(
			[
				'create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))',
				'create materialized view ix as select x, y, id from t order by x',
			],
			'ix', 'select x, y, id from t order by x', 't', 'ordering-mismatch',
		);
	});

	it('predicate-entailment (body scope wider than partial-UNIQUE scope)', async () => {
		await expectReason(
			[
				'create table t (id integer primary key, x integer not null, y integer not null)',
				'create unique index uq on t (x, y) where x > 5',
				'create materialized view ix as select x, y, id from t where x > 0 order by x, y',
			],
			'ix', 'select x, y, id from t where x > 0 order by x, y', 't', 'predicate-entailment',
		);
	});

	it('predicate-entailment (full UNIQUE but body restricts rows)', async () => {
		await expectReason(
			[
				'create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))',
				'create materialized view ix as select x, y, id from t where x > 0 order by x, y',
			],
			'ix', 'select x, y, id from t where x > 0 order by x, y', 't', 'predicate-entailment',
		);
	});

	it('missing-null-skip (nullable uc column, no NULL filter)', async () => {
		await expectReason(
			[
				'create table t (id integer primary key, x integer null, unique (x))',
				'create materialized view ix as select x, id from t order by x',
			],
			'ix', 'select x, id from t order by x', 't', 'missing-null-skip',
		);
	});

	it('shape (join body is not a single-table chain)', async () => {
		await expectReason(
			[
				'create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))',
				'create table u (uid integer primary key, x integer not null)',
				'create materialized view ix as select t.x, t.y, t.id from t join u on t.x = u.x order by t.x, t.y',
			],
			'ix', 'select t.x, t.y, t.id from t join u on t.x = u.x order by t.x, t.y', 't', 'shape',
		);
	});

	it('shape (LIMIT materializes only a prefix — never covers)', async () => {
		await expectReason(
			[
				'create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))',
				'create materialized view ix as select x, y, id from t order by x, y limit 100',
			],
			'ix', 'select x, y, id from t order by x, y limit 100', 't', 'shape',
		);
	});

	it('shape (OFFSET drops governed rows — never covers)', async () => {
		await expectReason(
			[
				'create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))',
				'create materialized view ix as select x, y, id from t order by x, y limit 100 offset 10',
			],
			'ix', 'select x, y, id from t order by x, y limit 100 offset 10', 't', 'shape',
		);
	});
});

describe('eager prove-and-link', () => {
	it('populates coveringStructureName + covers on create, clears on drop', async () => {
		const db = await freshDb([
			'create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))',
			'create materialized view ix_t_xy as select x, y, id from t order by x, y',
		]);
		try {
			const uc = () => db.schemaManager.getTable('main', 't')!.uniqueConstraints![0];
			expect(uc().coveringStructureName, 'forward pointer set').to.equal('ix_t_xy');

			const mv = db.schemaManager.getMaterializedView('main', 'ix_t_xy')!;
			expect(mv.origin).to.equal('explicit');
			expect(mv.covers).to.deep.include({ schemaName: 'main', tableName: 't' });

			await db.exec('drop materialized view ix_t_xy');
			expect(uc().coveringStructureName, 'forward pointer cleared on drop').to.be.undefined;
		} finally {
			await db.close();
		}
	});

	it('does NOT link a non-covering MV', async () => {
		const db = await freshDb([
			'create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))',
			// No ORDER BY ⇒ not a covering structure.
			'create materialized view ix as select x, y, id from t',
		]);
		try {
			expect(db.schemaManager.getTable('main', 't')!.uniqueConstraints![0].coveringStructureName).to.be.undefined;
			expect(db.schemaManager.getMaterializedView('main', 'ix')!.covers).to.be.undefined;
		} finally {
			await db.close();
		}
	});
});

/**
 * Multi-source (join) bodies — the prover admits a join body as covering a
 * single-table UNIQUE constraint when `T` provably contributes exactly one MV
 * row per governed `T` row (no row loss + no fan-out). See the coverage-prover
 * module doc § "The 1:1 join decomposition".
 *
 * NOTE on join survival: none of these DDLs declare a foreign key, so
 * `rule-join-elimination` (which needs FK→PK alignment) never fires and the join
 * survives to the optimized plan — exercising the new multi-source walk rather
 * than collapsing to the v1 single-source path.
 */
describe('coverage prover — multi-source (join) bodies', () => {
	// orders(unique(customer_id, sku)) left-joined to a unique lookup key: 1:1.
	const ORDERS_CUSTOMERS = [
		'create table orders (id integer primary key, customer_id integer not null, sku text not null, unique (customer_id, sku))',
		'create table customers (id integer primary key, name text)',
	];

	it('positive: LEFT join to a unique lookup key (T on the preserving left side) covers', async () => {
		const body = 'select o.customer_id, o.sku, o.id from orders o left join customers c on o.customer_id = c.id order by o.customer_id, o.sku';
		const db = await freshDb([...ORDERS_CUSTOMERS, `create materialized view ix as ${body}`]);
		try {
			expect((await prove(db, 'ix', body, 'orders')).covers, 'left-join to unique lookup is 1:1').to.be.true;
		} finally {
			await db.close();
		}
	});

	it('positive: RIGHT join with the lookup on the left (T on the preserving right side) covers', async () => {
		// RIGHT JOIN is not executable yet, so the MV cannot be materialized; prove
		// against the planned body directly (the prover's `'right'`-join branch).
		const body = 'select o.customer_id, o.sku, o.id from customers c right join orders o on o.customer_id = c.id order by o.customer_id, o.sku';
		const db = await freshDb(ORDERS_CUSTOMERS);
		try {
			expect(proveUnmaterialized(db, body, 'orders').covers, 'symmetric right-join case').to.be.true;
		} finally {
			await db.close();
		}
	});

	it('negative fanout: LEFT join on a NON-unique lookup key multiplies T rows', async () => {
		// tags.val is not unique (PK is on a different column) ⇒ one orders row can
		// match many tags rows ⇒ the join fans out.
		const body = 'select o.customer_id, o.sku, o.id from orders o left join tags t on o.customer_id = t.val order by o.customer_id, o.sku';
		const db = await freshDb([
			'create table orders (id integer primary key, customer_id integer not null, sku text not null, unique (customer_id, sku))',
			'create table tags (id integer primary key, val integer not null, label text)',
			`create materialized view ix as ${body}`,
		]);
		try {
			const result = await prove(db, 'ix', body, 'orders');
			expect(result.covers, 'a fanning lookup join must not cover').to.be.false;
			if (!result.covers) expect(result.reason).to.equal('fanout');
		} finally {
			await db.close();
		}
	});

	it('negative shape: the same body as an INNER join loses unmatched T rows', async () => {
		const body = 'select o.customer_id, o.sku, o.id from orders o inner join customers c on o.customer_id = c.id order by o.customer_id, o.sku';
		const db = await freshDb([...ORDERS_CUSTOMERS, `create materialized view ix as ${body}`]);
		try {
			const result = await prove(db, 'ix', body, 'orders');
			expect(result.covers, 'inner join cannot prove no-row-loss').to.be.false;
			if (!result.covers) expect(result.reason).to.equal('shape');
		} finally {
			await db.close();
		}
	});

	it('negative shape: T on the dropping side of an outer join', async () => {
		// customers LEFT JOIN orders preserves customers; orders rows with no
		// matching customer are dropped ⇒ row loss for orders.
		const body = 'select o.customer_id, o.sku, o.id from customers c left join orders o on o.customer_id = c.id order by o.customer_id, o.sku';
		const db = await freshDb([...ORDERS_CUSTOMERS, `create materialized view ix as ${body}`]);
		try {
			const result = await prove(db, 'ix', body, 'orders');
			expect(result.covers, 'T on the non-preserving side cannot cover').to.be.false;
			if (!result.covers) expect(result.reason).to.equal('shape');
		} finally {
			await db.close();
		}
	});

	it('negative shape: self-join of T to T is ambiguous', async () => {
		const body = 'select o1.customer_id, o1.sku, o1.id from orders o1 join orders o2 on o1.id = o2.id order by o1.customer_id, o1.sku';
		const db = await freshDb([
			'create table orders (id integer primary key, customer_id integer not null, sku text not null, unique (customer_id, sku))',
			`create materialized view ix as ${body}`,
		]);
		try {
			const result = await prove(db, 'ix', body, 'orders');
			expect(result.covers, 'self-join puts T on both sides ⇒ ambiguous').to.be.false;
			if (!result.covers) expect(result.reason).to.equal('shape');
		} finally {
			await db.close();
		}
	});

	it('negative: WHERE referencing a lookup column cannot sneak through', async () => {
		const body = 'select o.customer_id, o.sku, o.id from orders o left join customers c on o.customer_id = c.id where c.name is not null order by o.customer_id, o.sku';
		const db = await freshDb([...ORDERS_CUSTOMERS, `create materialized view ix as ${body}`]);
		try {
			const result = await prove(db, 'ix', body, 'orders');
			expect(result.covers, 'a non-T filter must not be accepted').to.be.false;
			// Either the optimizer null-rejected the LEFT join into an INNER join
			// (rejected by the structural side/type gate ⇒ 'shape') or it survived as
			// a LEFT join and the AST WHERE (on a non-T column) failed predicate
			// alignment ⇒ 'predicate-entailment'. Both are sound rejections.
			if (!result.covers) expect(['shape', 'predicate-entailment']).to.include(result.reason);
		} finally {
			await db.close();
		}
	});

	it('eager link: a covering join MV stamps covers + coveringStructureName', async () => {
		const body = 'select o.customer_id, o.sku, o.id from orders o left join customers c on o.customer_id = c.id order by o.customer_id, o.sku';
		const db = await freshDb([...ORDERS_CUSTOMERS, `create materialized view ix as ${body}`]);
		try {
			const uc = db.schemaManager.getTable('main', 'orders')!.uniqueConstraints![0];
			expect(uc.coveringStructureName, 'forward pointer set to the join MV').to.equal('ix');
			const mv = db.schemaManager.getMaterializedView('main', 'ix')!;
			expect(mv.covers).to.deep.include({ schemaName: 'main', tableName: 'orders' });
		} finally {
			await db.close();
		}
	});

	it('eager link: a fanning join MV stamps nothing', async () => {
		const body = 'select o.customer_id, o.sku, o.id from orders o left join tags t on o.customer_id = t.val order by o.customer_id, o.sku';
		const db = await freshDb([
			'create table orders (id integer primary key, customer_id integer not null, sku text not null, unique (customer_id, sku))',
			'create table tags (id integer primary key, val integer not null, label text)',
			`create materialized view ix as ${body}`,
		]);
		try {
			expect(db.schemaManager.getTable('main', 'orders')!.uniqueConstraints![0].coveringStructureName).to.be.undefined;
			expect(db.schemaManager.getMaterializedView('main', 'ix')!.covers).to.be.undefined;
		} finally {
			await db.close();
		}
	});

	// --- Nested joins: the topmost-join capture + per-join structural gate +
	//     composed join-frame FDs must hold for a chain of joins, not just one. ---

	it('positive: nested LEFT joins, both 1:1, cover', async () => {
		const body = 'select o.customer_id, o.sku, o.id from orders o left join customers c on o.customer_id = c.id left join addresses a on o.id = a.id order by o.customer_id, o.sku';
		const db = await freshDb([
			...ORDERS_CUSTOMERS,
			'create table addresses (id integer primary key, city text)',
			`create materialized view ix as ${body}`,
		]);
		try {
			expect((await prove(db, 'ix', body, 'orders')).covers, 'a 1:1 chain of LEFT joins is still 1:1').to.be.true;
		} finally {
			await db.close();
		}
	});

	it('negative fanout: nested LEFT joins where the OUTER join fans out (deeper-than-top fan-out is caught at the join frame)', async () => {
		// orders LJ customers is 1:1, but the outer LJ tags (tags.val non-unique)
		// fans out. The fan-out gate checks isUnique(orders.pk) at the *topmost*
		// join frame, whose FDs do not let orders.pk reach the tags columns ⇒ fanout.
		const body = 'select o.customer_id, o.sku, o.id from orders o left join customers c on o.customer_id = c.id left join tags t on o.customer_id = t.val order by o.customer_id, o.sku';
		const db = await freshDb([
			...ORDERS_CUSTOMERS,
			'create table tags (id integer primary key, val integer not null, label text)',
			`create materialized view ix as ${body}`,
		]);
		try {
			const result = await prove(db, 'ix', body, 'orders');
			expect(result.covers, 'a fan-out below the top join must still be caught').to.be.false;
			if (!result.covers) expect(result.reason).to.equal('fanout');
		} finally {
			await db.close();
		}
	});

	it('positive: a composite-PK table maps every PK attribute into the join frame', async () => {
		// line_items has a 2-column PK (oid, lineno); the covered UC is (oid, sku).
		// The fan-out gate must map BOTH pk attributes into the join frame for the
		// isUnique check, not just the first. The lookup is on region_id (a non-UC,
		// non-PK column) to a unique key, with no lookup-side name colliding with a
		// UC column — so the name-collision guard does not (correctly) intervene.
		const body = 'select l.oid, l.sku, l.lineno from line_items l left join regions r on l.region_id = r.rid order by l.oid, l.sku';
		const db = await freshDb([
			'create table line_items (oid integer not null, lineno integer not null, sku text not null, region_id integer not null, primary key (oid, lineno), unique (oid, sku))',
			'create table regions (rid integer primary key, rname text)',
			`create materialized view ix as ${body}`,
		]);
		try {
			expect((await prove(db, 'ix', body, 'line_items')).covers, 'composite-PK 1:1 lookup join covers').to.be.true;
		} finally {
			await db.close();
		}
	});

	// products.sku reuses the UC column name `sku`, but the prover's ORDER BY /
	// WHERE resolution is now qualifier-aware, so `l.sku` (T) and `p.sku` (lookup)
	// are kept distinct — no bare-name collision guard. The natural-key 1:1 lookup
	// join therefore covers.
	const LINE_ITEMS_PRODUCTS = [
		'create table line_items (oid integer not null, lineno integer not null, sku text not null, primary key (oid, lineno), unique (oid, sku))',
		'create table products (sku text primary key, name text)',
	];

	it('positive: a 1:1 join whose lookup key reuses a UC column name, sorted by the T-qualified column, covers', async () => {
		const body = 'select l.oid, l.sku, l.lineno from line_items l left join products p on l.sku = p.sku order by l.oid, l.sku';
		const db = await freshDb([...LINE_ITEMS_PRODUCTS, `create materialized view ix as ${body}`]);
		try {
			expect((await prove(db, 'ix', body, 'line_items')).covers, 'a UC-named lookup key qualified to T still covers').to.be.true;
		} finally {
			await db.close();
		}
	});

	it('negative ordering-mismatch: the SAME UC-shared name qualified to the LOOKUP side is not a T ordering', async () => {
		// `order by l.oid, p.sku` sorts by the lookup-side `sku`, not T's — so it is
		// an ordering-mismatch, NOT a `shape` rejection (the old collision guard).
		const body = 'select l.oid, l.sku, l.lineno from line_items l left join products p on l.sku = p.sku order by l.oid, p.sku';
		const db = await freshDb([...LINE_ITEMS_PRODUCTS, `create materialized view ix as ${body}`]);
		try {
			const result = await prove(db, 'ix', body, 'line_items');
			expect(result.covers, 'ordering on a lookup column cannot cover').to.be.false;
			if (!result.covers) expect(result.reason).to.equal('ordering-mismatch');
		} finally {
			await db.close();
		}
	});

	it('negative predicate-entailment: a WHERE on the UC-shared name qualified to the LOOKUP side is rejected for the right reason', async () => {
		// `where p.sku is null` filters on the lookup-side `sku` (the anti-join
		// pattern keeps the LEFT join), so it is a predicate-entailment failure —
		// NOT `shape` as the bare-name collision guard would have reported.
		const body = 'select l.oid, l.sku, l.lineno from line_items l left join products p on l.sku = p.sku where p.sku is null order by l.oid, l.sku';
		const db = await freshDb([...LINE_ITEMS_PRODUCTS, `create materialized view ix as ${body}`]);
		try {
			const result = await prove(db, 'ix', body, 'line_items');
			expect(result.covers, 'a lookup-side WHERE cannot cover').to.be.false;
			if (!result.covers) expect(result.reason).to.equal('predicate-entailment');
		} finally {
			await db.close();
		}
	});

	// --- INNER / CROSS-equi joins admitted via enforced referential integrity:
	//     a NOT-NULL FK from T to the lookup PK makes the inner join 1:1, so no
	//     governed T row is dropped. The lookup column is projected in every
	//     positive case so `rule-join-elimination` does NOT collapse the join to
	//     the v1 single-source path — the inner-join multi-source walk is what is
	//     under test (confirmed: the body keeps a surviving HashJoin). ---

	it('positive: INNER join on a NOT-NULL FK to the lookup PK covers (RI ⇒ no row loss)', async () => {
		const body = 'select o.customer_id, o.sku, o.id, c.name from orders o inner join customers c on o.customer_id = c.id order by o.customer_id, o.sku';
		const db = await freshDb([
			'create table customers (id integer primary key, name text)',
			'create table orders (id integer primary key, customer_id integer not null, sku text not null, unique (customer_id, sku), foreign key (customer_id) references customers(id))',
			`create materialized view ix as ${body}`,
		]);
		try {
			expect((await prove(db, 'ix', body, 'orders')).covers, 'NOT-NULL FK inner join is 1:1').to.be.true;
		} finally {
			await db.close();
		}
	});

	it('positive: INNER join on a composite NOT-NULL FK covers', async () => {
		const body = 'select c.pa, c.pb, c.sku, c.id, p.label from child c inner join parent p on c.pa = p.a and c.pb = p.b order by c.pa, c.pb, c.sku';
		const db = await freshDb([
			'create table parent (a integer not null, b integer not null, label text, primary key (a, b))',
			'create table child (id integer primary key, pa integer not null, pb integer not null, sku text not null, unique (pa, pb, sku), foreign key (pa, pb) references parent(a, b))',
			`create materialized view ix as ${body}`,
		]);
		try {
			expect((await prove(db, 'ix', body, 'child')).covers, 'composite NOT-NULL FK inner join is 1:1').to.be.true;
		} finally {
			await db.close();
		}
	});

	it('negative shape: INNER join on a NULLABLE FK can drop T rows (NULL FK has no parent)', async () => {
		// region_id is explicitly `null` (Quereus columns are NOT NULL by default —
		// Third Manifesto), so orders rows with NULL region_id match no customer and
		// are dropped by the inner join ⇒ row loss ⇒ must not cover. The UC
		// (customer_id, sku) is NOT NULL so predicate alignment is satisfied; the
		// rejection is purely the no-row-loss gate.
		const body = 'select o.customer_id, o.sku, o.id, c.name from orders o inner join customers c on o.region_id = c.id order by o.customer_id, o.sku';
		const db = await freshDb([
			'create table customers (id integer primary key, name text)',
			'create table orders (id integer primary key, customer_id integer not null, sku text not null, region_id integer null, unique (customer_id, sku), foreign key (region_id) references customers(id))',
			`create materialized view ix as ${body}`,
		]);
		try {
			const result = await prove(db, 'ix', body, 'orders');
			expect(result.covers, 'a nullable FK cannot prove no-row-loss').to.be.false;
			if (!result.covers) expect(result.reason).to.equal('shape');
		} finally {
			await db.close();
		}
	});

	it('negative shape: INNER join on a non-FK UNIQUE lookup key carries no inclusion guarantee', async () => {
		// c.code is UNIQUE (no fan-out) but there is NO foreign key from orders, so
		// an orders.customer_id with no matching c.code is dropped ⇒ row loss.
		const body = 'select o.customer_id, o.sku, o.id, c.name from orders o inner join customers c on o.customer_id = c.code order by o.customer_id, o.sku';
		const db = await freshDb([
			'create table customers (id integer primary key, code integer not null unique, name text)',
			'create table orders (id integer primary key, customer_id integer not null, sku text not null, unique (customer_id, sku))',
			`create materialized view ix as ${body}`,
		]);
		try {
			const result = await prove(db, 'ix', body, 'orders');
			expect(result.covers, 'a non-FK equi-join to a unique key cannot prove no-row-loss').to.be.false;
			if (!result.covers) expect(result.reason).to.equal('shape');
		} finally {
			await db.close();
		}
	});

	it('negative shape: INNER join whose ON clause adds a same-side equality filter does not cover', async () => {
		// `c.grp1 = c.grp2` is a single-relation filter on the lookup side: orders
		// rows whose matched customer has grp1 != grp2 are dropped ⇒ row loss. It
		// passes the pure-column-equi shape but produces no cross-side equi-pair, so
		// the FK-alignment proof must reject it (whether the optimizer pushes it
		// below the join as a Filter or leaves it on the logical JoinNode).
		const body = 'select o.customer_id, o.sku, o.id, c.name from orders o inner join customers c on o.customer_id = c.id and c.grp1 = c.grp2 order by o.customer_id, o.sku';
		const db = await freshDb([
			'create table customers (id integer primary key, grp1 integer not null, grp2 integer not null, name text)',
			'create table orders (id integer primary key, customer_id integer not null, sku text not null, unique (customer_id, sku), foreign key (customer_id) references customers(id))',
			`create materialized view ix as ${body}`,
		]);
		try {
			const result = await prove(db, 'ix', body, 'orders');
			expect(result.covers, 'a same-side equality filter in the ON clause drops T rows').to.be.false;
			if (!result.covers) expect(result.reason).to.equal('shape');
		} finally {
			await db.close();
		}
	});

	it('eager link: a covering INNER-FK join MV stamps covers + coveringStructureName', async () => {
		const body = 'select o.customer_id, o.sku, o.id, c.name from orders o inner join customers c on o.customer_id = c.id order by o.customer_id, o.sku';
		const db = await freshDb([
			'create table customers (id integer primary key, name text)',
			'create table orders (id integer primary key, customer_id integer not null, sku text not null, unique (customer_id, sku), foreign key (customer_id) references customers(id))',
			`create materialized view ix as ${body}`,
		]);
		try {
			expect(db.schemaManager.getTable('main', 'orders')!.uniqueConstraints![0].coveringStructureName, 'forward pointer set').to.equal('ix');
			expect(db.schemaManager.getMaterializedView('main', 'ix')!.covers).to.deep.include({ schemaName: 'main', tableName: 'orders' });
		} finally {
			await db.close();
		}
	});
});

describe('introspection hiding', () => {
	it('omits the implicit covering structure by default', async () => {
		const db = await freshDb([
			'create table t (id integer primary key, x integer not null, constraint uq unique (x))',
		]);
		try {
			const catalog = collectSchemaCatalog(db, 'main');
			expect(catalog.indexes.find(i => i.tableName === 't'), 'no implicit index surfaced').to.be.undefined;
		} finally {
			await db.close();
		}
	});

	it('surfaces it when the constraint carries quereus.expose_implicit_index = true', async () => {
		const db = await freshDb([
			'create table t (id integer primary key, x integer not null, constraint uq unique (x) with tags ("quereus.expose_implicit_index" = true))',
		]);
		try {
			const catalog = collectSchemaCatalog(db, 'main');
			const idx = catalog.indexes.find(i => i.tableName === 't' && i.name === 'uq');
			expect(idx, 'implicit index surfaced under the constraint name').to.not.be.undefined;
		} finally {
			await db.close();
		}
	});
});

/**
 * Effective-key ("body proves it") prover — proves the body's own *output*
 * relation is unique on the declared key columns via its effective key (FD
 * closure), the obligation primitive the lens prover's `obligation: proved`
 * class consumes. Distinct from base-table `proveCoverage` above (see the
 * module doc in coverage-prover.ts for why this is NOT folded into it).
 */
describe('coverage prover — effective-key (body proves it)', () => {
	it('group-by proves the composite key {x, y}', async () => {
		const db = await freshDb([
			'create table t (id integer primary key, x integer not null, y integer not null, z integer)',
		]);
		try {
			const root = bodyRoot(db, 'select x, y, sum(z) from t group by x, y');
			expect(proveEffectiveKeyUnique(root, [0, 1])).to.deep.equal({ proved: true });
		} finally {
			await db.close();
		}
	});

	it('group-by does NOT prove a strict subset of the group key', async () => {
		const db = await freshDb([
			'create table t (id integer primary key, x integer not null, y integer not null, z integer)',
		]);
		try {
			// Two distinct groups can share x ⇒ {x} is not a key on the output.
			const root = bodyRoot(db, 'select x, y, sum(z) from t group by x, y');
			expect(proveEffectiveKeyUnique(root, [0])).to.deep.equal({ proved: false, reason: 'not-a-key' });
		} finally {
			await db.close();
		}
	});

	it('group-by proves a superset of the group key (superkey semantics)', async () => {
		const db = await freshDb([
			'create table t (id integer primary key, x integer not null, y integer not null, z integer)',
		]);
		try {
			// [0,1,2] is a superset of the real key {0,1} ⇒ still unique.
			const root = bodyRoot(db, 'select x, y, sum(z) from t group by x, y');
			expect(proveEffectiveKeyUnique(root, [0, 1, 2])).to.deep.equal({ proved: true });
		} finally {
			await db.close();
		}
	});

	it('nullable group key still proves it (strict-unique ⟹ NULL-permissive unique)', async () => {
		const db = await freshDb([
			'create table t (id integer primary key, x integer null)',
		]);
		try {
			const root = bodyRoot(db, 'select x, count(*) from t group by x');
			expect(proveEffectiveKeyUnique(root, [0])).to.deep.equal({ proved: true });
		} finally {
			await db.close();
		}
	});

	it('non-aggregating body: PK FD flows through projection', async () => {
		const db = await freshDb([
			'create table t (id integer primary key, x integer)',
		]);
		try {
			const root = bodyRoot(db, 'select id, x from t');
			expect(proveEffectiveKeyUnique(root, [0]), 'id is a key').to.deep.equal({ proved: true });
			expect(proveEffectiveKeyUnique(root, [1]), 'x alone is not a key').to.deep.equal({ proved: false, reason: 'not-a-key' });
		} finally {
			await db.close();
		}
	});

	it('out-of-frame: a key index beyond the output columns', async () => {
		const db = await freshDb([
			'create table t (id integer primary key, x integer null)',
		]);
		try {
			const root = bodyRoot(db, 'select x, count(*) from t group by x');
			expect(proveEffectiveKeyUnique(root, [99])).to.deep.equal({ proved: false, reason: 'out-of-frame' });
		} finally {
			await db.close();
		}
	});
});

/**
 * Stub-based unit coverage for `proveEffectiveKeyUnique` — mirrors
 * test/optimizer/keysof-isunique.spec.ts: a lightweight `RelationType` +
 * `physical.fds` stub (no full plan tree) exercises the out-of-frame guard and
 * the delegation to `isUnique`.
 */
describe('coverage prover — effective-key (stub unit)', () => {
	function makeRoot(opts: {
		columnCount: number;
		isSet?: boolean;
		keys?: ColRef[][];
		fds?: FunctionalDependency[];
	}): RelationalPlanNode {
		const columns = Array.from({ length: opts.columnCount }, (_, i) => ({
			name: `c${i}`,
			type: { typeClass: 'scalar' as const, logicalType: INTEGER_TYPE, nullable: true, isReadOnly: true },
		}));
		const type: RelationType = {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: opts.isSet ?? false,
			columns,
			keys: opts.keys ?? [],
			rowConstraints: [],
		} as RelationType;
		const physical = { fds: opts.fds } as PhysicalProperties;
		// Only getType()/physical are touched by proveEffectiveKeyUnique → isUnique.
		return { getType: () => type, physical } as unknown as RelationalPlanNode;
	}

	it('out-of-frame guard fires for indices below 0 or ≥ columnCount', () => {
		const root = makeRoot({ columnCount: 2, fds: [{ determinants: [0], dependents: [1] }] });
		expect(proveEffectiveKeyUnique(root, [2])).to.deep.equal({ proved: false, reason: 'out-of-frame' });
		expect(proveEffectiveKeyUnique(root, [-1])).to.deep.equal({ proved: false, reason: 'out-of-frame' });
		// A mix where one index is out of frame still reports out-of-frame.
		expect(proveEffectiveKeyUnique(root, [0, 5])).to.deep.equal({ proved: false, reason: 'out-of-frame' });
	});

	it('delegates to isUnique: FD-derived key proves, non-key does not', () => {
		const root = makeRoot({ columnCount: 2, fds: [{ determinants: [0], dependents: [1] }] });
		expect(proveEffectiveKeyUnique(root, [0])).to.deep.equal({ proved: true });
		expect(proveEffectiveKeyUnique(root, [1])).to.deep.equal({ proved: false, reason: 'not-a-key' });
	});

	it('empty key columns: proved only when the relation is ≤1 row', () => {
		// ∅ → all_cols ⇒ the empty key holds ⇒ [] is unique.
		const oneRow = makeRoot({ columnCount: 2, fds: [{ determinants: [], dependents: [0, 1] }] });
		expect(proveEffectiveKeyUnique(oneRow, [])).to.deep.equal({ proved: true });
		// A bag with no ≤1-row guarantee: [] is not a key.
		const bag = makeRoot({ columnCount: 2 });
		expect(proveEffectiveKeyUnique(bag, [])).to.deep.equal({ proved: false, reason: 'not-a-key' });
	});
});

/**
 * Row-time covering enforcement — a UNIQUE constraint whose conflict resolution
 * is answered by an explicit `row-time` covering MV's backing table rather than
 * the auto-index (`covering-structure-mv-rowtime-enforcement`). The covering MV
 * is `select <uc-cols>, <pk> from T order by <uc-cols> with refresh = 'row-time'`,
 * so it is both *covering* (the prover links it) and *row-time* (its backing is
 * consistent mid-statement). `findIndexForConstraint` then prefers it over the
 * auto-index, and the source PK is recovered from the MV projection so
 * IGNORE/ABORT/REPLACE resolve against the correct source row.
 */
describe('row-time covering enforcement', () => {
	let db: Database;
	afterEach(async () => { if (db) await db.close(); });

	async function selectAll(sql: string): Promise<Record<string, unknown>[]> {
		const rows: Record<string, unknown>[] = [];
		for await (const row of db.eval(sql)) rows.push(row);
		return rows;
	}

	async function expectThrows(fn: () => Promise<unknown>, substr: string): Promise<void> {
		let err: unknown;
		try { await fn(); } catch (e) { err = e; }
		expect(err, `expected an error containing "${substr}"`).to.not.be.undefined;
		expect(String((err as Error).message)).to.contain(substr);
	}

	/** t(id pk, x, y, unique(x,y)) covered by a row-time MV `ix`. */
	async function freshCovered(extra: string[] = []): Promise<void> {
		db = new Database();
		await db.exec('create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))');
		await db.exec("create materialized view ix as select x, y, id from t order by x, y with refresh = 'row-time'");
		for (const stmt of extra) await db.exec(stmt);
	}

	it('resolver: a row-time covering MV is found; manual / on-commit-incremental are not', async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))');
		await db.exec("create materialized view rt as select x, y, id from t order by x, y with refresh = 'row-time'");
		const uc = () => db.schemaManager.getTable('main', 't')!.uniqueConstraints![0];
		expect(uc().coveringStructureName, 'forward pointer set').to.equal('rt');
		expect(db._findRowTimeCoveringStructure('main', 't', uc())?.name, 'row-time MV is enforcement-ready').to.equal('rt');

		// A second table whose covering MV is `manual` must NOT be enforcement-ready.
		await db.exec('create table u (id integer primary key, x integer not null, y integer not null, unique (x, y))');
		await db.exec('create materialized view man as select x, y, id from u order by x, y');
		const ucu = db.schemaManager.getTable('main', 'u')!.uniqueConstraints![0];
		expect(ucu.coveringStructureName, 'manual MV still links').to.equal('man');
		expect(db._findRowTimeCoveringStructure('main', 'u', ucu), 'manual MV is not row-time consistent').to.be.undefined;

		// An on-commit-incremental covering MV is likewise not row-time consistent.
		await db.exec('create table w (id integer primary key, x integer not null, y integer not null, unique (x, y))');
		await db.exec("create materialized view ci as select x, y, id from w order by x, y with refresh = 'on-commit-incremental'");
		const ucw = db.schemaManager.getTable('main', 'w')!.uniqueConstraints![0];
		expect(db._findRowTimeCoveringStructure('main', 'w', ucw), 'on-commit-incremental MV is not row-time consistent').to.be.undefined;
	});

	it('INSERT conflict, default ABORT → UNIQUE constraint failed: t (x, y)', async () => {
		await freshCovered(['insert into t values (1, 5, 5)']);
		await expectThrows(() => db.exec('insert into t values (2, 5, 5)'), 'UNIQUE constraint failed: t (x, y)');
		expect(await selectAll('select * from t order by id')).to.deep.equal([{ id: 1, x: 5, y: 5 }]);
	});

	it('ABORT reports the prior source row recovered via the MV projection (ON CONFLICT upsert)', async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, x integer not null, y integer not null, n text, unique (x, y))');
		await db.exec("create materialized view ix as select x, y, id, n from t order by x, y with refresh = 'row-time'");
		await db.exec("insert into t values (1, 5, 5, 'orig')");
		// The conflict must resolve against the prior source row (id=1) the MV recovers:
		// the upsert updates id=1 in place (id stays 1, n←'new') rather than inserting id=2,
		// proving the correct source row — not a backing-shaped projection — flowed through.
		await db.exec("insert into t values (2, 5, 5, 'new') on conflict (x, y) do update set n = excluded.n");
		expect(await selectAll('select * from t order by id')).to.deep.equal([{ id: 1, x: 5, y: 5, n: 'new' }]);
	});

	it('INSERT OR IGNORE → duplicate silently skipped, row count unchanged', async () => {
		await freshCovered(['insert into t values (1, 5, 5)']);
		await db.exec('insert or ignore into t values (2, 5, 5)');
		expect(await selectAll('select * from t order by id')).to.deep.equal([{ id: 1, x: 5, y: 5 }]);
	});

	it('INSERT OR REPLACE → prior source row evicted by recovered PK, new row present, no phantom backing', async () => {
		await freshCovered(['insert into t values (1, 5, 5)']);
		await db.exec('insert or replace into t values (10, 5, 5)');
		// Correct source PK (id=1) recovered + evicted; new row present.
		expect(await selectAll('select * from t order by id')).to.deep.equal([{ id: 10, x: 5, y: 5 }]);
		// Regression for the eviction-maintenance edge: the evicted row's backing
		// entry must be gone (the MV — which resolves to the backing — shows only id=10).
		expect(await selectAll('select * from ix order by x, y')).to.deep.equal([{ x: 5, y: 5, id: 10 }]);
	});

	it('multi-row INSERT with an intra-statement duplicate (reads-own-writes)', async () => {
		// ABORT: the second row conflicts with the first written mid-statement.
		await freshCovered();
		await expectThrows(() => db.exec('insert into t values (1, 5, 5), (2, 5, 5)'), 'UNIQUE constraint failed: t (x, y)');
		expect(await selectAll('select count(*) as n from t')).to.deep.equal([{ n: 0 }]);

		// OR IGNORE: the second (intra-statement) duplicate is skipped, the first lands.
		await db.exec('insert or ignore into t values (1, 5, 5), (2, 5, 5)');
		expect(await selectAll('select * from t order by id')).to.deep.equal([{ id: 1, x: 5, y: 5 }]);
	});

	it('UPDATE moving a row onto an existing UC value (no PK change), default ABORT', async () => {
		await freshCovered(['insert into t values (1, 5, 5), (2, 6, 6)']);
		// Moving id=1 onto (6,6) collides with id=2 (UPDATE OR <action> is unsupported,
		// so the constraint's ABORT default governs).
		await expectThrows(() => db.exec('update t set x = 6, y = 6 where id = 1'), 'UNIQUE constraint failed: t (x, y)');
		expect(await selectAll('select * from t order by id')).to.deep.equal([{ id: 1, x: 5, y: 5 }, { id: 2, x: 6, y: 6 }]);
	});

	it('UPDATE onto an existing UC value with a schema-level ON CONFLICT REPLACE default evicts + maintains', async () => {
		// Per-statement UPDATE OR REPLACE is unsupported; the constraint's
		// `on conflict replace` default drives REPLACE for the conflicting UPDATE.
		db = new Database();
		await db.exec('create table t (id integer primary key, x integer not null, y integer not null, unique (x, y) on conflict replace)');
		await db.exec("create materialized view ix as select x, y, id from t order by x, y with refresh = 'row-time'");
		await db.exec('insert into t values (1, 5, 5), (2, 6, 6)');
		// id=1 moves onto (6,6): id=2 is evicted (recovered by PK) + its backing entry maintained.
		await db.exec('update t set x = 6, y = 6 where id = 1');
		expect(await selectAll('select * from t order by id')).to.deep.equal([{ id: 1, x: 6, y: 6 }]);
		expect(await selectAll('select * from ix order by x, y')).to.deep.equal([{ x: 6, y: 6, id: 1 }]);
	});

	it('UPDATE that changes the PK only (UC unchanged) is not a self-conflict', async () => {
		// The internal old-row delete bypasses the row-time hook, so the backing
		// transiently still carries id=1's (5,5) entry. The live-source validation
		// must skip that stale candidate rather than raise a phantom conflict.
		await freshCovered(['insert into t values (1, 5, 5)']);
		await db.exec('update t set id = 10 where id = 1');
		expect(await selectAll('select * from t order by id')).to.deep.equal([{ id: 10, x: 5, y: 5 }]);
		expect(await selectAll('select * from ix order by x, y')).to.deep.equal([{ x: 5, y: 5, id: 10 }]);
	});

	it('UPDATE that changes the PK and moves onto an existing UC value', async () => {
		await freshCovered(['insert into t values (1, 5, 5), (2, 6, 6)']);
		await expectThrows(() => db.exec('update t set id = 99, x = 6, y = 6 where id = 1'), 'UNIQUE constraint failed: t (x, y)');

		// With a schema-level REPLACE default the PK-changing move evicts id=2.
		db = new Database();
		await db.exec('create table t2 (id integer primary key, x integer not null, y integer not null, unique (x, y) on conflict replace)');
		await db.exec("create materialized view ix2 as select x, y, id from t2 order by x, y with refresh = 'row-time'");
		await db.exec('insert into t2 values (1, 5, 5), (2, 6, 6)');
		await db.exec('update t2 set id = 99, x = 6, y = 6 where id = 1');
		expect(await selectAll('select * from t2 order by id')).to.deep.equal([{ id: 99, x: 6, y: 6 }]);
	});

	it('partial covering MV: out-of-scope rows are not checked', async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, x integer not null, y integer not null, active integer not null)');
		await db.exec('create unique index uq on t (x, y) where active = 1');
		await db.exec("create materialized view ix as select x, y, id from t where active = 1 order by x, y with refresh = 'row-time'");
		const uc = db.schemaManager.getTable('main', 't')!.uniqueConstraints![0];
		expect(uc.coveringStructureName, 'partial covering MV linked').to.equal('ix');
		expect(db._findRowTimeCoveringStructure('main', 't', uc)?.name).to.equal('ix');

		await db.exec('insert into t values (1, 5, 5, 1)'); // in scope
		// An out-of-scope row sharing (x,y) does NOT conflict.
		await db.exec('insert into t values (2, 5, 5, 0)');
		// Two out-of-scope rows sharing (x,y) do NOT conflict.
		await db.exec('insert into t values (3, 7, 7, 0), (4, 7, 7, 0)');
		expect(await selectAll('select count(*) as n from t')).to.deep.equal([{ n: 4 }]);
		// A second in-scope row sharing (x,y) DOES conflict.
		await expectThrows(() => db.exec('insert into t values (5, 5, 5, 1)'), 'UNIQUE constraint failed: t (x, y)');
	});

	it('non-row-time covering MV falls through to the auto-index (still enforced)', async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))');
		// A `manual` covering MV links but is NOT row-time consistent ⇒ not used for enforcement.
		await db.exec('create materialized view man as select x, y, id from t order by x, y');
		const uc = db.schemaManager.getTable('main', 't')!.uniqueConstraints![0];
		expect(uc.coveringStructureName).to.equal('man');
		expect(db._findRowTimeCoveringStructure('main', 't', uc), 'manual MV is not enforcement-ready').to.be.undefined;
		// Enforcement still works (via the auto-index).
		await db.exec('insert into t values (1, 5, 5)');
		await expectThrows(() => db.exec('insert into t values (2, 5, 5)'), 'UNIQUE constraint failed: t (x, y)');
	});
});
