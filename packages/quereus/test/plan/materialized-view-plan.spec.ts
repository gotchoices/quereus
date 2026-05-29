import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { serializePlanTree } from '../../src/planner/debug.js';

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
