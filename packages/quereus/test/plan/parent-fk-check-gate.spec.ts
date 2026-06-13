import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { planRows } from './_helpers.js';

/**
 * Plan-time gate for parent-side FK checks (`buildParentSideFKChecks`, routed
 * through `SchemaManager.getReferencingForeignKeys` by
 * reverse-fk-index-engine-consumers).
 *
 * A DELETE / UPDATE on the referenced table synthesizes a `NOT EXISTS` parent-side
 * RESTRICT check ONLY for FKs that reference it. After the rewrite the builder no
 * longer walks the whole catalog; it asks the reverse-FK index for the referencing
 * FKs. The observable contract is unchanged:
 *
 *  - a referenced parent's DELETE plan carries exactly its parent-side FK checks
 *    (so the immediate RESTRICT enforcement is emitted), and
 *  - an unreferenced table's DELETE plan carries NO parent-side FK check (the gate
 *    also trims plan-time work).
 *
 * The ConstraintCheck node renders as `CHECK <n> CONSTRAINTS ON DELETE`; a DELETE
 * carries no other constraint class for these minimal tables, so the count is the
 * parent-side FK-check count. The assertion is robust to an empty-check-node
 * elision: we look for ANY node whose detail reports a non-zero constraint count.
 */
describe('parent-side FK check plan-time gate (reverse-FK index)', () => {
	let db: Database;
	beforeEach(async () => {
		db = new Database();
		await db.exec('pragma foreign_keys = true');
	});
	afterEach(async () => { await db.close(); });

	/** Number of plan nodes reporting a non-zero `CHECK <n> CONSTRAINTS ON <OP>` detail. */
	async function nonEmptyConstraintCheckCounts(sql: string): Promise<number[]> {
		const rows = await planRows(db, sql);
		const counts: number[] = [];
		for (const r of rows) {
			const m = /CHECK (\d+) CONSTRAINTS ON/.exec(r.detail);
			if (m && Number(m[1]) > 0) counts.push(Number(m[1]));
		}
		return counts;
	}

	it('an unreferenced table DELETE emits no parent-side FK check', async () => {
		await db.exec(`
			create table u (id integer primary key, v text);
			-- An unrelated referenced table so the reverse-FK index is non-empty overall.
			create table other_p (pid integer primary key);
			create table other_c (cid integer primary key, p integer, foreign key (p) references other_p(pid));
		`);
		// No FK references u -> the parent-side builder gets the empty bucket -> zero checks.
		expect(await nonEmptyConstraintCheckCounts('delete from u where id = 1')).to.deep.equal([]);
	});

	it('a referenced parent DELETE emits exactly its one parent-side FK check', async () => {
		await db.exec(`
			create table p (id integer primary key);
			create table c (cid integer primary key, p_id integer,
				foreign key (p_id) references p(id) on delete restrict);
		`);
		// p is referenced by one RESTRICT FK -> exactly one parent-side NOT EXISTS check.
		expect(await nonEmptyConstraintCheckCounts('delete from p where id = 1')).to.deep.equal([1]);
	});

	it('a parent referenced by two children DELETE emits two parent-side FK checks', async () => {
		await db.exec(`
			create table p (id integer primary key);
			create table c1 (cid integer primary key, p_id integer,
				foreign key (p_id) references p(id) on delete restrict);
			create table c2 (cid integer primary key, p_id integer,
				foreign key (p_id) references p(id) on delete restrict);
		`);
		// Both referencing RESTRICT FKs are discovered through the index -> two checks.
		expect(await nonEmptyConstraintCheckCounts('delete from p where id = 1')).to.deep.equal([2]);
	});
});
