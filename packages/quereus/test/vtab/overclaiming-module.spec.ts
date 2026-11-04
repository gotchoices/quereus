/**
 * Guard for `reattachUnconsumedConstraints` in `rule-select-access-path`.
 *
 * `handledFilters[i] = true` makes `rule-grow-retrieve` leave filter `i` out of the
 * residual. The rule turns at most one constraint per column per role into a seek bound
 * (the first `=`/`IN`, the first lower bound, the first upper bound) and no non-seek
 * constraint at all, so without the reattach anything else a module claims stays in the
 * plan nowhere, and the query silently returns extra rows.
 *
 * `TestOverclaimModule` claims every pushed filter and enforces only what reaches it
 * in `FilterInfo`, which is exactly the failure mode. Correct results here therefore
 * depend on the planner reattaching the orphaned constraints as a residual `Filter`.
 * Delete the safety net and these tests fail; the in-tree memory/store modules would
 * not, because they now claim positionally.
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import type { TableSchema } from '../../src/schema/table.js';
import type { BestAccessPlanRequest, BestAccessPlanResult } from '../../src/vtab/best-access-plan.js';
import { TestOverclaimModule, overclaimStore } from './test-overclaim-module.js';

describe('over-claiming module: planner reattaches unconsumed filters', () => {
	let db: Database;

	beforeEach(async () => {
		overclaimStore.clear();
		db = new Database();
		db.registerModule('overclaim', new TestOverclaimModule());
		await db.exec('create table t (x integer primary key, y integer) using overclaim');
		await db.exec('insert into t values (10, 1), (20, 2), (30, 3), (40, 4)');
	});

	afterEach(async () => {
		await db.close();
		overclaimStore.clear();
	});

	const xs = async (sql: string): Promise<number[]> => {
		const out: number[] = [];
		for await (const row of db.eval(sql)) out.push(row.x as number);
		return out;
	};

	it('keeps the second lower bound on the seek column', async () =>
		expect(await xs('select x from t where x > 10 and x > 30 order by x')).to.deep.equal([40]));

	it('keeps the second upper bound on the seek column', async () =>
		expect(await xs('select x from t where x < 40 and x < 20 order by x')).to.deep.equal([10]));

	it('keeps a mixed same-side pair (> then >=)', async () =>
		expect(await xs('select x from t where x > 10 and x >= 30 order by x')).to.deep.equal([30, 40]));

	it('keeps a claimed constraint on a non-seek column', async () =>
		expect(await xs('select x from t where x > 10 and y = 3 order by x')).to.deep.equal([30]));

	it('keeps a contradicting equality pair on the seek column', async () =>
		expect(await xs('select x from t where x = 20 and x = 30')).to.deep.equal([]));

	it('still applies the bounds the planner did consume', async () =>
		expect(await xs('select x from t where x > 10 and x < 40 order by x')).to.deep.equal([20, 30]));
});

/**
 * Memory's seek still consumes `b = 5`, so a growth rule commits to the plan; the extra
 * claims are the ones no seek can consume. The double applies none of them, which is the
 * position an isolation overlay's staged rows are in under a module that honours its claim.
 */
class NonSeekClaimModule extends MemoryTableModule {
	override getBestAccessPlan(db: Database, tableInfo: TableSchema, request: BestAccessPlanRequest): BestAccessPlanResult {
		const plan = super.getBestAccessPlan(db, tableInfo, request);
		const handledFilters = plan.handledFilters.map((handled, i) =>
			handled || ['IS NULL', 'IS NOT NULL', 'LIKE'].includes(request.filters[i].op));
		return { ...plan, handledFilters };
	}
}

describe('non-seek claim: planner reattaches the filter it cannot consume', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		db.registerModule('nonseekclaim', new NonSeekClaimModule());
		await db.exec('create table t (id integer primary key, a integer null, s text, b integer) using nonseekclaim');
		await db.exec('create index t_b on t (b)');
		await db.exec(`insert into t values (1, null, 'a', 5), (3, 4, 'b', 5)`);
	});

	afterEach(async () => {
		await db.close();
	});

	const ids = async (sql: string): Promise<number[]> => {
		const out: number[] = [];
		for await (const row of db.eval(sql)) out.push(row.id as number);
		return out.sort((x, y) => x - y);
	};

	it('re-checks a claimed is null', async () =>
		expect(await ids('select id from t where a is null and b = 5')).to.deep.equal([1]));

	it('re-checks a claimed is not null', async () =>
		expect(await ids('select id from t where a is not null and b = 5')).to.deep.equal([3]));

	it('re-checks a claimed like', async () =>
		expect(await ids(`select id from t where s like 'a%' and b = 5`)).to.deep.equal([1]));
});

/**
 * `is not null` on a `not null` column is always true, so reattaching it would only add a
 * predicate evaluation per row. Memory claims exactly this tautology, and the minmax
 * boundary read is where the extra Filter would sit between its scan and its LIMIT.
 */
describe('non-seek claim: a tautological is not null is not reattached', () => {
	it('grows no filter for is not null on a not null column', async () => {
		const db = new Database();
		try {
			await db.exec('create table t (id integer primary key, a integer not null)');
			await db.exec('create index t_a on t (a)');
			await db.exec('insert into t values (1, 10), (2, 20)');
			const ops: string[] = [];
			for await (const row of db.eval('select op from query_plan(?)', ['select min(a) from t where a is not null'])) {
				ops.push(row.op as string);
			}
			expect(ops.filter(op => /^filter$/i.test(op))).to.have.lengthOf(0);
		} finally {
			await db.close();
		}
	});
});
