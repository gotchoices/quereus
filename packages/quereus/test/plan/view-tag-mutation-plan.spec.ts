import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { SqlValue } from '../../src/common/types.js';

/**
 * A cached write-through plan must be invalidated when the view's behavioral
 * `quereus.update.*` tags change via `ALTER VIEW … SET TAGS`.
 *
 * A view-mediated write routes through `buildViewMutation`, which reads the
 * view-level `quereus.update.*` override tags to steer the lowering (here a
 * `default_for.<col>` that fills a projected-away base column). `SET TAGS`
 * swaps the in-memory `ViewSchema` and fires `view_modified`; every
 * view-mediated write records a `view` schema dependency, so the cached
 * `Statement` listener matches the event → recompiles → re-reads the new tag.
 *
 * The `.sqllogic` harness re-prepares every statement and so cannot express
 * prepared-statement reuse across an `ALTER`; hence this focused spec. A fresh
 * `prepare`/`exec` always re-plans and routes correctly, so the gap is
 * plan-caching-specific — this asserts the SAME cached statement re-routes.
 */
describe('View tag mutation invalidation of cached write-through plans', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	const rows = async (sql: string): Promise<Record<string, SqlValue>[]> => {
		const out: Record<string, SqlValue>[] = [];
		for await (const row of db.eval(sql)) out.push(row);
		return out;
	};

	it('re-routes a cached insert after ALTER VIEW … SET TAGS changes a default_for tag', async () => {
		// `created` is projected away by the view; its omitted-insert value comes from
		// the view-level `quereus.update.default_for.created` override tag.
		await db.exec(`
			create table t (id integer primary key, created integer);
			create view v as select id from t
				with tags ("quereus.update.default_for.created" = '100');
		`);

		// Prepare ONCE and run — this compiles + caches the write-through plan that
		// reads default_for.created = 100, and records the `view` dependency.
		const stmt = db.prepare('insert into v (id) values (?)');
		await stmt.run([1]);
		expect(await rows('select created from t where id = 1'))
			.to.deep.equal([{ created: 100 }], 'precondition: first insert uses the original default');

		// Behavioral retag: the new routing must reach the ALREADY-cached statement.
		await db.exec(`alter view v set tags ("quereus.update.default_for.created" = '200');`);

		// Re-run the SAME prepared statement. Without invalidation it would reuse the
		// cached plan and still write 100; with `view_modified` → `view`-dependency
		// invalidation it recompiles and writes the new default.
		await stmt.run([2]);
		expect(await rows('select created from t where id = 2'))
			.to.deep.equal([{ created: 200 }], 'cached plan must re-route to the new default after SET TAGS');

		await stmt.finalize();
	});

	it('re-routes a cached insert after ALTER MATERIALIZED VIEW … SET TAGS changes a default_for tag', async () => {
		// An MV-mediated write routes through the same view-mutation substrate (the
		// insert builder funnels `getView ?? getMaterializedView` into buildViewMutation),
		// so it records the `view` dependency and fires `materialized_view_modified` on a
		// retag. The MV body projects only the PK; `created` is supplied by the MV-level
		// default_for tag and the write-through lands on the source table `t`.
		await db.exec(`
			create table t (id integer primary key, created integer);
			create materialized view mv as select id from t
				with tags ("quereus.update.default_for.created" = '100');
		`);

		const stmt = db.prepare('insert into mv (id) values (?)');
		await stmt.run([1]);
		expect(await rows('select created from t where id = 1'))
			.to.deep.equal([{ created: 100 }], 'precondition: first MV insert uses the original default');

		await db.exec(`alter materialized view mv set tags ("quereus.update.default_for.created" = '200');`);

		await stmt.run([2]);
		expect(await rows('select created from t where id = 2'))
			.to.deep.equal([{ created: 200 }], 'cached MV write-through plan must re-route after SET TAGS');

		await stmt.finalize();
	});

	it('a fresh prepare always routes with the current tag (control)', async () => {
		await db.exec(`
			create table t (id integer primary key, created integer);
			create view v as select id from t
				with tags ("quereus.update.default_for.created" = '100');
		`);

		await db.exec('insert into v (id) values (1);');
		await db.exec(`alter view v set tags ("quereus.update.default_for.created" = '200');`);
		await db.exec('insert into v (id) values (2);');

		expect(await rows('select id, created from t order by id'))
			.to.deep.equal([{ id: 1, created: 100 }, { id: 2, created: 200 }], 'each fresh statement re-plans with the current tag');
	});
});
