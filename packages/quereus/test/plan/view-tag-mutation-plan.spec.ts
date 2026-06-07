import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { SqlValue } from '../../src/common/types.js';

/**
 * A cached write-through plan must be invalidated when the view's behavioral
 * `quereus.update.*` tags change via any of `ALTER VIEW … {SET|ADD|DROP} TAGS`.
 *
 * A view-mediated write routes through `buildViewMutation`, which reads the
 * view-level `quereus.update.*` override tags to steer the lowering (here a
 * `default_for.<col>` that fills a projected-away base column). Each verb
 * (`set*Tags` / `merge*Tags` / `drop*Tags`) swaps the in-memory `ViewSchema` /
 * `MaterializedViewSchema` and fires `view_modified` / `materialized_view_modified`;
 * every view-mediated write records a `view` schema dependency, so the cached
 * `Statement` listener matches the event → recompiles → re-reads the new tag.
 * The `ADD` / `DROP` cases below prove the merge / drop helpers fire the same
 * invalidation event as `SET` (the implement pass left this structurally
 * guaranteed but unproven).
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

	it('invalidates a cached plan when ALTER uses a different identifier case than the view was created with', async () => {
		// SQL identifiers are case-insensitive. The `view` plan dependency records the
		// canonical stored name (`MyView`), so the `view_modified` event must also carry
		// the canonical name — not the raw `ALTER` token (`MYVIEW`) — or the listener's
		// exact-match invalidation misses and the cached plan keeps the stale routing.
		await db.exec(`
			create table t (id integer primary key, created integer);
			create view MyView as select id from t
				with tags ("quereus.update.default_for.created" = '100');
		`);

		const stmt = db.prepare('insert into MyView (id) values (?)');
		await stmt.run([1]);
		expect(await rows('select created from t where id = 1'))
			.to.deep.equal([{ created: 100 }], 'precondition: first insert uses the original default');

		await db.exec(`alter view MYVIEW set tags ("quereus.update.default_for.created" = '200');`);

		await stmt.run([2]);
		expect(await rows('select created from t where id = 2'))
			.to.deep.equal([{ created: 200 }], 'case-differing ALTER must still invalidate the cached plan');

		await stmt.finalize();
	});

	it('re-routes a cached insert after ALTER VIEW … ADD TAGS overwrites a default_for tag', async () => {
		// ADD TAGS (merge) overwriting the behavioral key must fire `view_modified`
		// exactly as SET does — the merge helper rides the same event path.
		await db.exec(`
			create table t (id integer primary key, created integer);
			create view v as select id from t
				with tags ("quereus.update.default_for.created" = '100');
		`);

		const stmt = db.prepare('insert into v (id) values (?)');
		await stmt.run([1]);
		expect(await rows('select created from t where id = 1'))
			.to.deep.equal([{ created: 100 }], 'precondition: first insert uses the original default');

		// Merge a new value for the same key (overwrite), keeping any other tags.
		await db.exec(`alter view v add tags ("quereus.update.default_for.created" = '200');`);

		await stmt.run([2]);
		expect(await rows('select created from t where id = 2'))
			.to.deep.equal([{ created: 200 }], 'cached plan must re-route to the merged default after ADD TAGS');

		await stmt.finalize();
	});

	it('re-routes a cached insert after ALTER VIEW … DROP TAGS removes a default_for tag', async () => {
		// DROP TAGS removing the behavioral key must fire `view_modified` too — and
		// the routing genuinely changes: with no default override the projected-away
		// column falls back to NULL (the column is declared nullable so the omitted
		// insert is legal — a bare `integer` column is NOT NULL in Quereus).
		await db.exec(`
			create table t (id integer primary key, created integer null);
			create view v as select id from t
				with tags ("quereus.update.default_for.created" = '100');
		`);

		const stmt = db.prepare('insert into v (id) values (?)');
		await stmt.run([1]);
		expect(await rows('select created from t where id = 1'))
			.to.deep.equal([{ created: 100 }], 'precondition: first insert uses the original default');

		await db.exec(`alter view v drop tags ("quereus.update.default_for.created");`);

		await stmt.run([2]);
		expect(await rows('select created from t where id = 2'))
			.to.deep.equal([{ created: null }], 'cached plan must re-route to no-default (NULL) after DROP TAGS');

		await stmt.finalize();
	});

	it('re-routes a cached MV insert after ALTER MATERIALIZED VIEW … ADD / DROP TAGS', async () => {
		// The MV merge / drop helpers fire `materialized_view_modified`, which the
		// `view`-dependency listener also honors — so a cached MV write-through plan
		// re-routes on both ADD (overwrite) and DROP (remove → NULL).
		await db.exec(`
			create table t (id integer primary key, created integer null);
			create materialized view mv as select id from t
				with tags ("quereus.update.default_for.created" = '100');
		`);

		const stmt = db.prepare('insert into mv (id) values (?)');
		await stmt.run([1]);
		expect(await rows('select created from t where id = 1'))
			.to.deep.equal([{ created: 100 }], 'precondition: first MV insert uses the original default');

		await db.exec(`alter materialized view mv add tags ("quereus.update.default_for.created" = '200');`);
		await stmt.run([2]);
		expect(await rows('select created from t where id = 2'))
			.to.deep.equal([{ created: 200 }], 'cached MV plan must re-route after ADD TAGS');

		await db.exec(`alter materialized view mv drop tags ("quereus.update.default_for.created");`);
		await stmt.run([3]);
		expect(await rows('select created from t where id = 3'))
			.to.deep.equal([{ created: null }], 'cached MV plan must re-route to no-default (NULL) after DROP TAGS');

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
