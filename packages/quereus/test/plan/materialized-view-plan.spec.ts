import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { serializePlanTree } from '../../src/planner/debug.js';
import type { Row } from '../../src/common/types.js';

/**
 * A reference to a materialized view must resolve to a plain TableReference
 * against the hidden BACKING TABLE — NOT a re-expansion of the view body.
 *
 * The golden-plan dynamic harness can't cover this (it can't execute the CREATE
 * before planning), so this is a focused, execution-then-plan assertion.
 */
describe('Materialized view plan shape', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	it('select * from mv references the backing table, not the body source', async () => {
		await db.exec(`
			create table t (x integer primary key, y text);
			insert into t values (1, 'a');
			create materialized view mv as select x, y from t;
		`);

		const plan = db.getPlan('select * from mv');
		const serialized = serializePlanTree(plan);

		// Resolves to the backing table…
		expect(serialized).to.contain('_mv_mv');
		// …via a TableReference node (key-based addressing of a stored relation).
		expect(serialized).to.contain('TableReference');
		// …and NOT by re-expanding the body against the source table `t`.
		expect(serialized).to.not.contain('"name":"t"');
	});

	it('a stale, still-valid MV reference also resolves to the backing table', async () => {
		await db.exec(`
			create table t (x integer primary key, y text);
			insert into t values (1, 'a');
			create materialized view mv as select x, y from t;
			alter table t add column z integer null;
		`);

		// Compatible alter marks the MV stale but the body still plans; the
		// reference re-validates and resolves to the backing table.
		const plan = db.getPlan('select * from mv');
		const serialized = serializePlanTree(plan);
		expect(serialized).to.contain('_mv_mv');
	});
});

/**
 * A cached prepared-statement plan that reads an MV's backing table must be
 * invalidated when a source schema change (re)marks the MV stale — otherwise the
 * cached backing-reference plan re-runs and bypasses the build-time `stale`
 * re-validation guard in `building/select.ts`, silently serving stale rows.
 *
 * A fresh `prepare`/`eval` always re-plans and hits the guard, so the gap is
 * plan-caching-specific; the `.sqllogic` harness re-plans every statement and
 * cannot express it, hence this focused spec. Covers the fix in
 * `database-materialized-views.ts` `emitBackingInvalidation`: a source change
 * emits a synthetic `table_modified` event for the MV's backing table, which the
 * cached `Statement`'s dependency listener matches → recompile → re-hit the guard.
 */
describe('Materialized view stale invalidation of cached plans', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	const drain = async (it: AsyncIterable<Row>): Promise<Row[]> => {
		const rows: Row[] = [];
		for await (const row of it) rows.push(row);
		return rows;
	};

	const captureError = async (it: AsyncIterable<unknown>): Promise<Error | undefined> => {
		try {
			for await (const _ of it) { /* drain */ }
		} catch (e) {
			return e instanceof Error ? e : new Error(String(e));
		}
		return undefined;
	};

	it('invalidates a cached plan when an incompatible source change marks the MV stale', async () => {
		await db.exec(`
			create table t (x integer primary key, y text);
			insert into t values (1, 'a');
			create materialized view mv as select x, y from t;
		`);

		// Prepare + iterate to cache the backing-reference plan (and register the
		// statement's schema-change dependency on the backing table).
		const stmt = db.prepare('select x, y from mv order by x');
		expect(await drain(stmt.iterateRows())).to.deep.equal([[1, 'a']]);

		// Incompatible source change (drops a body column) → MV stale.
		await db.exec('alter table t drop column y;');
		const mv = db.schemaManager.getMaterializedView('main', 'mv');
		expect(mv?.stale, 'precondition: MV marked stale by the source change').to.equal(true);

		// Control: a freshly prepared statement re-plans and hits the guard.
		const freshErr = await captureError(db.eval('select x, y from mv order by x'));
		expect(freshErr?.message, 'control: a fresh prepare errors with the staleness diagnostic').to.match(/stale/i);

		// Regression: the SAME cached statement must now recompile + error too.
		await stmt.reset();
		const cachedErr = await captureError(stmt.iterateRows());
		expect(cachedErr, 'cached plan must re-validate against the stale MV').to.not.be.undefined;
		expect(cachedErr!.message).to.match(/stale/i);

		await stmt.finalize();
	});

	// The unconditional-emit facet: a plan compiled *while the MV is already stale*
	// is equally vulnerable to a SUBSEQUENT incompatible source change. The emit must
	// fire on every qualifying source change, not only the false→true transition.
	it('re-validates a plan compiled while already stale on a later incompatible change', async () => {
		await db.exec(`
			create table t2 (x integer primary key, y text);
			insert into t2 values (1, 'a');
			create materialized view mv2 as select x, y from t2;
		`);

		// Compatible alter: marks mv2 stale but the body still plans.
		await db.exec('alter table t2 add column z integer null;');
		const mv2 = db.schemaManager.getMaterializedView('main', 'mv2');
		expect(mv2?.stale, 'compatible alter marks the MV stale').to.equal(true);

		// Prepare + iterate WHILE already stale: the body re-validates (still plans),
		// resolves to the backing table, serves rows, and caches the plan.
		const stmt = db.prepare('select x, y from mv2 order by x');
		expect(await drain(stmt.iterateRows())).to.deep.equal([[1, 'a']]);

		// A SUBSEQUENT incompatible change must invalidate the already-cached,
		// compiled-while-stale plan — only the *unconditional* emit covers this (the
		// false→true stale transition already happened on the first, compatible alter).
		await db.exec('alter table t2 drop column y;');

		await stmt.reset();
		const cachedErr = await captureError(stmt.iterateRows());
		expect(cachedErr, 'compiled-while-stale plan must re-validate on the later incompatible change').to.not.be.undefined;
		expect(cachedErr!.message).to.match(/stale/i);

		await stmt.finalize();
	});
});
