import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { DEFAULT_TUNING } from '../../src/planner/optimizer.js';
import { serializePlanTree } from '../../src/planner/debug.js';

/**
 * Golden plan shapes for automatic materialized-view query rewrite (read side).
 * The rewrite substitutes an ordinary backing `TableReference`, so `query_plan()`
 * (here, `serializePlanTree`) shows the `_mv_<name>` scan for free. The dynamic
 * golden-plan harness can't create an MV before planning, so these are focused
 * execution-then-plan assertions (cf. `materialized-view-plan.spec.ts`).
 */
describe('Materialized-view query rewrite — golden plans', () => {
	let db: Database;
	beforeEach(async () => {
		db = new Database();
		await db.exec(`
			create table sales (id integer primary key, customer_id integer not null, amt integer not null);
			insert into sales values (1,7,10),(2,7,-3),(3,9,5),(4,7,20),(5,9,-1);
			create materialized view recent as select id, customer_id, amt from sales where amt > 0;
		`);
	});
	afterEach(async () => { await db.close(); });

	it('a covering query rewrites to the backing scan with a residual', () => {
		const plan = serializePlanTree(db.getPlan('select customer_id, amt from sales where amt > 0 and customer_id = 7'));
		// Backing-table scan…
		expect(plan).to.contain('_mv_recent');
		// …and the original base table is no longer recomputed.
		expect(plan).to.not.contain('sales');
	});

	it('a near-miss (predicate not entailed) keeps the base recompute', () => {
		// amt > -5 is NOT entailed by the MV's amt > 0, so no rewrite.
		const plan = serializePlanTree(db.getPlan('select customer_id, amt from sales where amt > -5'));
		expect(plan).to.not.contain('_mv_recent');
		expect(plan).to.contain('sales');
	});

	it('a stale MV is not used (base recompute)', async () => {
		await db.exec('alter table sales add column note text null');
		expect(db.schemaManager.getMaterializedView('main', 'recent')!.stale).to.equal(true);
		const plan = serializePlanTree(db.getPlan('select customer_id, amt from sales where amt > 0'));
		expect(plan).to.not.contain('_mv_recent');
		expect(plan).to.contain('sales');
	});

	it('cost gate declines a no-win case (MV with no WHERE answering a no-WHERE query)', async () => {
		const db2 = new Database();
		try {
			await db2.exec(`
				create table tt (id integer primary key, x integer, y integer);
				insert into tt values (1,10,20),(2,30,40);
				create materialized view allt as select id, x, y from tt;
			`);
			// Backing == base cardinality and no filter saved → not strictly cheaper → decline.
			const plan = serializePlanTree(db2.getPlan('select x, y from tt'));
			expect(plan, 'no-win case keeps the base recompute').to.not.contain('_mv_allt');
			expect(plan).to.not.contain('_mv_');
		} finally {
			await db2.close();
		}
	});

	it('the substituted backing scan flows through normal physical access selection', () => {
		// The replacement is an ordinary TableReference, so a SeqScan over the backing
		// appears (query_plan visibility is free).
		const plan = serializePlanTree(db.getPlan('select customer_id, amt from sales where amt > 0'));
		expect(plan).to.contain('_mv_recent');
		expect(plan).to.match(/SeqScan|IndexScan|Retrieve/);
	});

	it('cheapest-wins with a deterministic name tiebreak across two covering MVs', async () => {
		const db2 = new Database();
		try {
			await db2.exec(`
				create table t (id integer primary key, x integer not null, y integer not null);
				insert into t values (1,5,6),(2,7,8);
				create materialized view bbb as select id, x, y from t where x > 0;
				create materialized view aaa as select id, x, y from t where x > 0;
			`);
			// Both MVs cover identically (equal cost) → stable lowercased-name tiebreak picks 'aaa'.
			const plan = serializePlanTree(db2.getPlan('select x, y from t where x > 0'));
			expect(plan).to.contain('_mv_aaa');
			expect(plan).to.not.contain('_mv_bbb');
		} finally {
			await db2.close();
		}
	});

	// Keep DEFAULT_TUNING import meaningful (rule-disabled control used in the
	// equivalence harness; referenced here to assert default-on behavior).
	it('the rewrite is on by default', () => {
		expect(DEFAULT_TUNING.disabledRules?.has?.('materialized-view-rewrite') ?? false).to.equal(false);
	});
});
