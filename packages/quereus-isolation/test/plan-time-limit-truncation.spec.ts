import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, MemoryTableModule } from '@quereus/quereus';
import type { BestAccessPlanRequest, BestAccessPlanResult, Database as Db, FilterInfo, Row, TableSchema } from '@quereus/quereus';
import { IsolationModule } from '../src/index.js';

type MemoryTable = Awaited<ReturnType<MemoryTableModule['create']>>;

/**
 * A query inside a transaction returns the rows it would return after commit, even when
 * the underlying module stops reading at the plan-time limit the engine licensed.
 *
 * The licence (`BestAccessPlanRequest.limit`) only accounts for rows a `Filter` can
 * discard. The isolation merge also discards rows: a committed row the transaction
 * deleted or re-keyed is shadowed by the overlay. If such rows fill the limit, the
 * underlying has already stopped and the rows that should replace them are never read.
 *
 * The double records `limit + offset` from any probe that carries a limit and stops every
 * later scan after that many rows — what the licence allows. Memory ignores the limit
 * outright, so without the double the bug cannot be seen.
 */
class TruncatingModule extends MemoryTableModule {
	private cap: number | undefined;

	override getBestAccessPlan(db: Db, tableInfo: TableSchema, request: BestAccessPlanRequest): BestAccessPlanResult {
		if (request.limit !== undefined && request.limit !== null) {
			this.cap = request.limit + (request.offset ?? 0);
		}
		return super.getBestAccessPlan(db, tableInfo, request);
	}

	override async create(db: Db, tableSchema: TableSchema): Promise<MemoryTable> {
		return this.truncating(await super.create(db, tableSchema));
	}

	private truncating(table: MemoryTable): MemoryTable {
		const query = table.query.bind(table);
		const module = this;
		table.query = async function* (filterInfo: FilterInfo): AsyncIterable<Row> {
			let emitted = 0;
			for await (const row of query(filterInfo)) {
				if (module.cap !== undefined && emitted >= module.cap) return;
				emitted++;
				yield row;
			}
		};
		return table;
	}
}

describe('plan-time limit under the isolation overlay', () => {
	let db: Database;

	const scalar = async (sql: string): Promise<unknown> => {
		for await (const row of db.eval(sql)) return Object.values(row)[0];
		return undefined;
	};

	beforeEach(async () => {
		db = new Database();
		db.registerModule('isolated', new IsolationModule({ underlying: new TruncatingModule() }));
		await db.exec('create table t (id integer primary key, a integer) using isolated');
		await db.exec('insert into t values (1, 1), (2, 2), (3, 3)');
	});

	afterEach(async () => {
		await db.close();
	});

	it('does not let a deleted committed row use up the limit', async () => {
		await db.exec('begin');
		await db.exec('delete from t where id = 1');
		expect(await scalar('select min(id) from t')).to.equal(2);
	});

	it('does not let a re-keyed committed row use up the limit', async () => {
		await db.exec('begin');
		await db.exec('update t set id = 10 where id = 1');
		expect(await scalar('select min(id) from t')).to.equal(2);
	});
});
