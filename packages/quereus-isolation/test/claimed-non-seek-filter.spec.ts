import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, MemoryTableModule } from '@quereus/quereus';
import type { BestAccessPlanRequest, BestAccessPlanResult, Database as Db, TableSchema } from '@quereus/quereus';
import { IsolationModule } from '../src/index.js';

/**
 * A query inside a transaction returns the rows it would return after commit, even when
 * the underlying module claims a filter no seek can consume.
 *
 * The merged read checks staged rows only against `FilterInfo.constraints`, and a claimed
 * `is null` or `like` never becomes one. So the engine has to re-check those filters above
 * the merge, or a staged row that fails one is emitted.
 *
 * Every row committed before the transaction satisfies the claimed filter, so the double
 * is as honest as a module that applies it: inside the transaction only staged rows can
 * fail. The double extends memory, which ignores `request.limit`, so the limit case stays
 * sound after commit, when rows failing the filter have become committed rows.
 */
class NonSeekClaimModule extends MemoryTableModule {
	override getBestAccessPlan(db: Db, tableInfo: TableSchema, request: BestAccessPlanRequest): BestAccessPlanResult {
		const plan = super.getBestAccessPlan(db, tableInfo, request);
		const handledFilters = plan.handledFilters.map((handled, i) =>
			handled || ['IS NULL', 'IS NOT NULL', 'LIKE'].includes(request.filters[i].op));
		return { ...plan, handledFilters };
	}
}

describe('claimed non-seek filter under the isolation overlay', () => {
	let db: Database;

	const ids = async (sql: string): Promise<number[]> => {
		const out: number[] = [];
		for await (const row of db.eval(sql)) out.push(row.id as number);
		return out;
	};

	/** Asserts the answer in the transaction, then that commit leaves it unchanged. */
	const expectStableAcrossCommit = async (sql: string, expected: number[]): Promise<void> => {
		expect(await ids(sql), 'inside the transaction').to.deep.equal(expected);
		await db.exec('commit');
		expect(await ids(sql), 'after commit').to.deep.equal(expected);
	};

	beforeEach(async () => {
		db = new Database();
		db.registerModule('isolated', new IsolationModule({ underlying: new NonSeekClaimModule() }));
		await db.exec('create table t (id integer primary key, a integer null, s text, b integer) using isolated');
		await db.exec('create index t_b on t (b)');
	});

	afterEach(async () => {
		await db.close();
	});

	it('removes a staged row failing a claimed is null on a seek of another column', async () => {
		await db.exec(`insert into t values (6, null, 'a', 5)`);
		await db.exec('begin');
		await db.exec(`insert into t values (2, null, 'b', 5), (4, 9, 'b', 5)`);
		await expectStableAcrossCommit('select id from t where a is null and b = 5 order by id', [2, 6]);
	});

	it('removes a staged row failing a claimed like on a seek of another column', async () => {
		await db.exec(`insert into t values (3, 4, 'a', 5)`);
		await db.exec('begin');
		await db.exec(`insert into t values (2, null, 'b', 5), (4, 9, 'ab', 5)`);
		await expectStableAcrossCommit(`select id from t where s like 'a%' and b = 5 order by id`, [3, 4]);
	});

	it('does not count a staged row failing a claimed is not null toward a limit', async () => {
		await db.exec(`insert into t values (3, 4, 'a', 5), (6, 7, 'a', 5)`);
		await db.exec('begin');
		await db.exec(`insert into t values (2, null, 'b', 5), (4, 9, 'b', 5)`);
		await expectStableAcrossCommit('select id from t where a is not null order by id limit 2 offset 0', [3, 4]);
	});
});
