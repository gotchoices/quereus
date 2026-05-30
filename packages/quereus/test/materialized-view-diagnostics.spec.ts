import { expect } from 'chai';
import { Database } from '../src/index.js';

/**
 * The mandatory create-time gate: every materialized view is row-time maintained,
 * so a body that is not row-time maintainable is rejected at CREATE with a
 * shape-naming diagnostic that names the MV and steers to a plain `view` (live
 * re-evaluation) or `create table … as` (one-off snapshot) — NOT a refresh policy,
 * and never leaking the hidden `_mv_<name>` backing table.
 *
 * The sqllogic harness (`53-materialized-views-rowtime.sqllogic` §7) covers the
 * positive substring; it cannot express the *negative* assertions below, so this
 * focused spec locks the user-facing wording in.
 */
describe('Materialized view create-time gate diagnostic', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	async function captureError(sql: string): Promise<Error> {
		try {
			await db.exec(sql);
		} catch (e) {
			return e instanceof Error ? e : new Error(String(e));
		}
		throw new Error(`Expected an error from: ${sql}`);
	}

	it('names the MV + shape and steers to view / create-table, not the backing table or a refresh policy', async () => {
		await db.exec(`
			create table orders (id integer primary key, status text);
			insert into orders values (1, 'open'), (2, 'open'), (3, 'shipped');
		`);

		const err = await captureError('create materialized view mv_status as select distinct status from orders;');

		// Shape-naming, user-facing wording…
		expect(err.message).to.contain('cannot be materialized');
		expect(err.message).to.contain('mv_status');
		// …steering to the right alternative…
		expect(err.message).to.contain('create view');
		expect(err.message).to.contain('create table');
		// …never a refresh policy (the knob is gone)…
		expect(err.message).to.not.contain('refresh');
		// …and never leaking the hidden backing-table implementation detail.
		expect(err.message).to.not.contain('_mv_');
	});

	it('rolls the backing table back so the MV name stays free after a failed create', async () => {
		await db.exec(`
			create table orders (id integer primary key, status text);
			insert into orders values (1, 'open'), (2, 'open'), (3, 'shipped');
		`);
		// An ineligible body (DISTINCT) fills the backing table, then the gate
		// rejects it — so the rollback must drop the backing table it just created.
		await captureError('create materialized view mv_status as select distinct status from orders;');

		// A row-time-eligible body (projects the source PK) over the same source must
		// succeed — proving the failed create did not half-register the name or leave
		// a backing table behind.
		await db.exec('create materialized view mv_status as select id, status from orders;');
		const rows: Record<string, unknown>[] = [];
		for await (const row of db.eval('select id, status from mv_status order by id')) {
			rows.push(row);
		}
		expect(rows).to.deep.equal([
			{ id: 1, status: 'open' }, { id: 2, status: 'open' }, { id: 3, status: 'shipped' },
		]);
	});

	// A duplicate-producing ("bag") body fails the set contract at fill time (before
	// the row-time gate is reached). This path is separate from the gate diagnostic
	// above; it must still name the MV + set contract, never leak the backing table,
	// and never suggest `distinct`/`group by` (both of which the gate now rejects).
	it('a duplicate-producing body fails the set contract with a non-leaking diagnostic', async () => {
		await db.exec(`
			create table orders (id integer primary key, status text);
			insert into orders values (1, 'open'), (2, 'open'), (3, 'shipped');
		`);

		const err = await captureError('create materialized view mv_status as select status from orders;');
		expect(err.message).to.contain('must be a set');
		expect(err.message).to.contain('mv_status');
		// Never leaks the hidden backing-table name…
		expect(err.message).to.not.contain('_mv_');
		// …and steers to the now-valid remedies only (not the gate-rejected distinct/group by).
		expect(err.message).to.match(/create view/);
		expect(err.message).to.match(/create table/);

		// The failed create rolled back, so the name is free for an eligible body.
		await db.exec('create materialized view mv_status as select id, status from orders;');
		expect(db.schemaManager.getMaterializedView('main', 'mv_status'), 'MV registered after rollback').to.not.be.undefined;
	});
});

/**
 * Per-reason gate diagnostics. The sqllogic harness (§7) pins one distinctive tail
 * per case, but it cannot ergonomically express the *check-ordering* subtleties:
 * the `tableRefs.length` checks run first, so a multi-table UNION reports a
 * source-count reason (not "set operation") and a recursive-CTE-only / TVF-only
 * body reports "reads no source table". These cases lock the literal tails the
 * `buildRowTimePlan` rejects actually produce (captured from the engine), so a
 * reason silently re-routing to a different branch is caught.
 *
 * NOTE: the "set operation (union/intersect/except)", "recursive CTE", "calls a
 * table-valued function", "has no primary key", and "WHERE not evaluable" reject
 * branches are NOT reachable from a clean single-source SQL body — an earlier
 * source-count check (≥2 refs for any union/join/subquery-source; 0 refs for a
 * CTE-only / TVF-only body) fires first, and every base table is keyed. They
 * remain as defensive guards. See the row-time-test-coverage review handoff.
 */
describe('Materialized view gate diagnostic — per-reason tails', () => {
	let db: Database;
	beforeEach(async () => {
		db = new Database();
		await db.exec(`
			create table g (id integer primary key, k integer, v integer);
			create table g2 (id integer primary key, w integer);
			insert into g values (1, 100, 5);
		`);
	});
	afterEach(async () => { await db.close(); });

	async function captureError(sql: string): Promise<Error> {
		try {
			await db.exec(sql);
		} catch (e) {
			return e instanceof Error ? e : new Error(String(e));
		}
		throw new Error(`Expected an error from: ${sql}`);
	}

	// label → [body, distinctive tail substring]
	const cases: Array<[string, string, string]> = [
		['aggregate', 'select k, sum(v) as sv from g group by k', 'its body uses an aggregate'],
		['join (multi-source)', 'select g.id, g.v from g join g2 on g.id = g2.id', 'its body reads more than one source table (joins are not supported)'],
		['self-join (multi-source)', 'select a.id, a.v from g a join g b on a.id = b.id', 'its body reads more than one source table (joins are not supported)'],
		['union over two tables (multi-source, NOT set-op)', 'select id, v from g union select id, w from g2', 'its body reads more than one source table (joins are not supported)'],
		['WHERE subquery over another table (multi-source)', 'select id, v from g where v in (select w from g2)', 'its body reads more than one source table (joins are not supported)'],
		['DISTINCT (single source)', 'select distinct v from g', 'its body uses DISTINCT'],
		['LIMIT', 'select id, v from g limit 10', 'its body uses LIMIT/OFFSET'],
		['OFFSET', 'select id, v from g order by id limit 5 offset 2', 'its body uses LIMIT/OFFSET'],
		['recursive-CTE-only (reads no base table)', 'with recursive r(n) as (select 1 union all select n + 1 from r where n < 3) select n from r', 'its body reads no source table'],
		['drops a source PK column', 'select v from g', "it does not project source primary-key column 'id'"],
		['computed/expression column', 'select id, v + 1 as v1 from g', 'it projects a computed/expression column'],
	];

	for (const [label, body, tail] of cases) {
		it(`rejects ${label} with its distinctive tail`, async () => {
			const err = await captureError(`create materialized view bad as ${body};`);
			expect(err.message, label).to.contain('cannot be materialized');
			expect(err.message, `${label}: distinctive tail`).to.contain(tail);
		});
	}

	// MV-over-MV is no longer rejected — the cascade (database-materialized-views.ts)
	// maintains a chain synchronously. Creating an MV whose body reads another MV
	// SUCCEEDS, and a later source write cascades through the inner MV's backing into
	// the outer MV with no refresh.
	it('accepts a materialized view over a materialized view and cascades source writes through it', async () => {
		await db.exec('create materialized view mv_base as select id, v from g;');
		await db.exec('create materialized view mv_over as select id, v from mv_base;');
		expect(db.schemaManager.getMaterializedView('main', 'mv_over'), 'MV-over-MV registered').to.not.be.undefined;

		// A source insert cascades through mv_base's backing into mv_over.
		await db.exec('insert into g values (2, 200, 7);');
		const rows: Record<string, unknown>[] = [];
		for await (const row of db.eval('select id, v from mv_over order by id')) {
			rows.push(row);
		}
		expect(rows).to.deep.equal([{ id: 1, v: 5 }, { id: 2, v: 7 }]);
	});
});

/**
 * The `with refresh = …` clause is gone entirely (every MV is row-time maintained,
 * with no policy knob). The parser consumes only a trailing `with tags (...)`, so a
 * trailing `with refresh = …` is left unconsumed and fails at the statement
 * boundary — a parse error, regardless of the literal value (the clause is never
 * inspected). Supersedes any "round-trip the row-time policy" expectation.
 */
describe('Materialized view `with refresh` is a parse error', () => {
	let db: Database;
	beforeEach(async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, x integer);');
	});
	afterEach(async () => { await db.close(); });

	async function captureError(sql: string): Promise<Error> {
		try {
			await db.exec(sql);
		} catch (e) {
			return e instanceof Error ? e : new Error(String(e));
		}
		throw new Error(`Expected an error from: ${sql}`);
	}

	it('rejects `with refresh = \'row-time\'` as a parse error', async () => {
		const err = await captureError("create materialized view v1 as select id, x from t with refresh = 'row-time';");
		// The trailing clause is reparsed as a stray statement → CTE-shaped parse error.
		expect(err.message).to.contain('after CTE name');
		expect(db.schemaManager.getMaterializedView('main', 'v1'), 'no MV registered on parse failure').to.be.undefined;
	});

	it('rejects an unknown `with refresh = \'bogus\'` literal identically (clause is never inspected)', async () => {
		const err = await captureError("create materialized view v2 as select id, x from t with refresh = 'bogus';");
		expect(err.message).to.contain('after CTE name');
		expect(db.schemaManager.getMaterializedView('main', 'v2'), 'no MV registered on parse failure').to.be.undefined;
	});
});
