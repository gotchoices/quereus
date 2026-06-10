import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { Parser } from '../../src/parser/parser.js';
import type { SchemaDependency } from '../../src/planner/planning-context.js';

/**
 * Unit pins for the `view` plan-dependency invalidation path, in two halves:
 *
 * - **Dependency recording** — every view-/MV-mediated write dispatches into the
 *   `buildViewMutation` funnel, which records a `{ type: 'view' }` schema
 *   dependency before any per-shape branching (view-mutation-builder.ts). Pinned
 *   via `db._buildPlan(...)`, whose `BuildTimeDependencyTracker` is returned
 *   alongside the plan.
 *
 * - **Invalidation** — `Statement.compile()` caches the planned `BlockNode` and
 *   installs a schema-change listener that nulls the cached plan when a
 *   `view_modified` / `materialized_view_modified` event matches a recorded
 *   `view` dependency (statement.ts). Pinned via plan-object identity across
 *   `compile()` calls: same object = cache hit, new object = invalidated.
 *   Events are driven through real `ALTER VIEW / MATERIALIZED VIEW … TAGS` SQL
 *   with legal, non-reserved tags — exactly the regime where a stale plan and a
 *   fresh plan behave identically, which is why identity (not behavior) is the
 *   observable. Every `!==` assert is preceded by a `===` cache control so a
 *   never-caching compile cannot pass vacuously.
 *
 * The DROP-TAGS recovery contract (a failed compile is not cached as the
 * answer; reserved-tag validation re-runs at plan time) is pinned separately in
 * `view-tag-mutation-plan.spec.ts` — not duplicated here. The `.sqllogic`
 * harness re-prepares every statement, so neither half is expressible there.
 */
describe('View plan dependencies and invalidation', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	/** Plan `sql` (without executing) and return its recorded schema dependencies. */
	const planDeps = (sql: string): SchemaDependency[] =>
		db._buildPlan(new Parser().parseAll(sql)).schemaDependencies.getDependencies();

	const viewDeps = (sql: string): SchemaDependency[] =>
		planDeps(sql).filter(d => d.type === 'view');

	describe('dependency recording (buildViewMutation funnel)', () => {
		it('a single-source view INSERT records a view dependency', async () => {
			await db.exec(`
				create table t (id integer primary key);
				create view v as select id from t;
			`);
			const deps = viewDeps('insert into v (id) values (1)');
			expect(deps.length, 'exactly one view dep for the single mutated view').to.equal(1);
			expect(deps[0].objectName).to.equal('v');
			expect(deps[0].schemaName).to.equal('main');
		});

		it('an MV-mediated INSERT records a view dependency for the MV', async () => {
			await db.exec(`
				create table t (id integer primary key);
				create materialized view mv as select id from t;
			`);
			const deps = viewDeps('insert into mv (id) values (1)');
			expect(deps.length, 'exactly one view dep for the mutated MV').to.equal(1);
			expect(deps[0].objectName).to.equal('mv');
			expect(deps[0].schemaName).to.equal('main');
		});

		it('a multi-source inner-join view UPDATE records a view dependency', async () => {
			// Shape mirrors `par_mj` in test/logic/93.4-view-mutation.sqllogic — a
			// writable two-table inner-join passthrough view. Recording sits above the
			// analyzeJoinView/decompose branching, so this pins that the non-single-
			// source shape dispatches into the funnel at all.
			await db.exec(`
				create table p (pid integer primary key, label text);
				create table c (cid integer primary key, pref integer, note text,
					foreign key (pref) references p(pid));
				create view vj as
					select c.cid as cid, c.note collate nocase as note, p.label as label
					from c join p on p.pid = c.pref;
			`);
			const deps = viewDeps(`update vj set note = 'gamma' where cid = 10`);
			expect(deps.length, 'exactly one view dep for the mutated join view').to.equal(1);
			expect(deps[0].objectName).to.equal('vj');
			expect(deps[0].schemaName).to.equal('main');
		});

		it('a read-only SELECT from a view records no view dependency', async () => {
			// View tags do not affect read results, so a read plan must not invalidate
			// on a tag change. The read still records the base *table* dep (the view
			// body resolves `t`) — assert on the absence of view-typed entries
			// specifically, not on emptiness.
			await db.exec(`
				create table t (id integer primary key);
				create view v as select id from t;
			`);
			const all = planDeps('select id from v');
			expect(all.filter(d => d.type === 'view')).to.deep.equal([]);
			expect(
				all.some(d => d.type === 'table' && d.objectName === 't'),
				'the base table dep is still recorded',
			).to.equal(true);
		});
	});

	describe('plan invalidation (prepared-statement compile identity)', () => {
		it('ALTER VIEW … SET TAGS invalidates a cached write-through plan', async () => {
			await db.exec(`
				create table t (id integer primary key);
				create view v as select id from t;
			`);
			const stmt = db.prepare('insert into v (id) values (1)');
			const p1 = stmt.compile();
			expect(stmt.compile(), 'compile() caches the plan (control)').to.equal(p1);

			await db.exec(`alter view v set tags (display_name = 'x')`);
			const p2 = stmt.compile();
			expect(p2, 'view_modified invalidated the cached plan').to.not.equal(p1);

			// The re-planned statement still executes.
			await stmt.run();
			const out: unknown[] = [];
			for await (const row of db.eval('select id from t')) out.push(row);
			expect(out).to.deep.equal([{ id: 1 }]);
			await stmt.finalize();
		});

		it('ALTER MATERIALIZED VIEW … ADD TAGS invalidates a cached MV write-through plan', async () => {
			await db.exec(`
				create table t (id integer primary key);
				create materialized view mv as select id from t;
			`);
			const stmt = db.prepare('insert into mv (id) values (1)');
			const p1 = stmt.compile();
			expect(stmt.compile(), 'compile() caches the plan (control)').to.equal(p1);

			await db.exec(`alter materialized view mv add tags (display_name = 'x')`);
			expect(stmt.compile(), 'materialized_view_modified invalidated the cached plan').to.not.equal(p1);

			await stmt.run();
			await stmt.finalize();
		});

		it('a recompile re-subscribes: a second ALTER invalidates the recompiled plan', async () => {
			// Pins that compile() removes the old unsubscriber and installs a live
			// listener on every recompile — a leaked stale unsubscriber or a missing
			// re-subscribe both fail this.
			await db.exec(`
				create table t (id integer primary key);
				create view v as select id from t;
			`);
			const stmt = db.prepare('insert into v (id) values (1)');
			const p1 = stmt.compile();
			expect(stmt.compile(), 'compile() caches the plan (control)').to.equal(p1);

			await db.exec(`alter view v set tags (display_name = 'a')`);
			const p2 = stmt.compile();
			expect(p2, 'first ALTER invalidates').to.not.equal(p1);
			expect(stmt.compile(), 'recompiled plan caches again (control)').to.equal(p2);

			await db.exec(`alter view v add tags (comment = 'b')`);
			expect(stmt.compile(), 'second ALTER invalidates the recompiled plan').to.not.equal(p2);
			await stmt.finalize();
		});

		it('an ALTER on an unrelated view does not invalidate', async () => {
			await db.exec(`
				create table t (id integer primary key);
				create view v as select id from t;
				create view other as select id from t;
			`);
			const stmt = db.prepare('insert into v (id) values (1)');
			const p1 = stmt.compile();
			expect(stmt.compile(), 'compile() caches the plan (control)').to.equal(p1);

			await db.exec(`alter view other set tags (display_name = 'x')`);
			expect(stmt.compile(), 'objectName mismatch must not invalidate').to.equal(p1);
			await stmt.finalize();
		});

		it('a prepared SELECT from a view keeps its plan across a view tag change', async () => {
			// The read plan's deps carry the base table, so a listener IS installed —
			// this pins that the `view`-typed dep match is what gates invalidation,
			// not listener absence.
			await db.exec(`
				create table t (id integer primary key);
				create view v as select id from t;
			`);
			const stmt = db.prepare('select id from v');
			const p1 = stmt.compile();
			expect(stmt.compile(), 'compile() caches the plan (control)').to.equal(p1);

			await db.exec(`alter view v set tags (display_name = 'x')`);
			expect(stmt.compile(), 'a read plan records no view dep — tag change must not invalidate').to.equal(p1);
			await stmt.finalize();
		});

		it('a case-differing ALTER view name still invalidates (canonical objectName in the event)', async () => {
			// The tag setters fire the canonical stored name (`updated.name`), so an
			// `alter view MYVIEW` on `create view MyView` matches the dep's `view.name`.
			await db.exec(`
				create table t (id integer primary key);
				create view MyView as select id from t;
			`);
			const stmt = db.prepare('insert into myview (id) values (1)');
			const p1 = stmt.compile();
			expect(stmt.compile(), 'compile() caches the plan (control)').to.equal(p1);

			await db.exec(`alter view MYVIEW set tags (display_name = 'x')`);
			expect(stmt.compile(), 'case-differing ALTER must still invalidate').to.not.equal(p1);
			await stmt.finalize();
		});

		it('a schema-qualified ALTER invalidates, including a case-differing schema qualifier', async () => {
			// The dep records the canonical `view.schemaName` ('main') and the
			// statement listener compares schema names exactly, so the tag setters
			// must fire the canonical schema name — `alter view MAIN.v` would
			// otherwise miss.
			await db.exec(`
				create table t (id integer primary key);
				create view v as select id from t;
			`);
			const stmt = db.prepare('insert into v (id) values (1)');
			const p1 = stmt.compile();
			expect(stmt.compile(), 'compile() caches the plan (control)').to.equal(p1);

			await db.exec(`alter view main.v set tags (display_name = 'x')`);
			const p2 = stmt.compile();
			expect(p2, 'exact-case schema-qualified ALTER invalidates').to.not.equal(p1);
			expect(stmt.compile(), 'recompiled plan caches again (control)').to.equal(p2);

			await db.exec(`alter view MAIN.v add tags (comment = 'y')`);
			expect(stmt.compile(), 'case-differing schema qualifier must still invalidate (canonical schema name in the event)').to.not.equal(p2);
			await stmt.finalize();
		});

		it('a case-differing schema-qualified ALTER MATERIALIZED VIEW invalidates', async () => {
			// Mirrors the case above for the MV tag emitter.
			await db.exec(`
				create table t (id integer primary key);
				create materialized view mv as select id from t;
			`);
			const stmt = db.prepare('insert into mv (id) values (1)');
			const p1 = stmt.compile();
			expect(stmt.compile(), 'compile() caches the plan (control)').to.equal(p1);

			await db.exec(`alter materialized view MAIN.mv add tags (display_name = 'x')`);
			expect(stmt.compile(), 'case-differing schema qualifier must still invalidate the MV write plan').to.not.equal(p1);
			await stmt.finalize();
		});
	});
});
