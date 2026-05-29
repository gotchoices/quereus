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
});
