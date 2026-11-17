import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, MemoryTableModule } from '@quereus/quereus';
import type { BestAccessPlanRequest, BestAccessPlanResult, Database as Db, FilterInfo, Row, TableSchema } from '@quereus/quereus';
import { IsolationModule } from '../src/index.js';

type MemoryTable = Awaited<ReturnType<MemoryTableModule['create']>>;

/**
 * A query inside a transaction returns the rows it would return after commit, even when
 * the underlying module stops reading at the row bound the engine granted.
 *
 * The engine grants a bound only when nothing between the scan and the LIMIT can discard
 * a row, and the isolation merge also discards rows: a committed row the transaction
 * deleted or re-keyed is shadowed by the overlay. If such rows fill the bound, the
 * underlying has already stopped and the rows that should replace them are never read.
 * The bound reaches the module as `FilterInfo.limit`, so the isolated table withholds it
 * from a merged read and applies it to the merged stream instead.
 *
 * The double honours the run-time window the way the contract allows — skips
 * `FilterInfo.offset` rows, then stops after `FilterInfo.limit` — and records each `limit`
 * it was handed. Memory ignores both fields outright, so without the double the bug
 * cannot be seen.
 */
class TruncatingModule extends MemoryTableModule {
	readonly seenLimits: (number | undefined)[] = [];

	override async create(db: Db, tableSchema: TableSchema): Promise<MemoryTable> {
		return this.truncating(await super.create(db, tableSchema));
	}

	private truncating(table: MemoryTable): MemoryTable {
		const query = table.query.bind(table);
		const seenLimits = this.seenLimits;
		table.query = async function* (filterInfo: FilterInfo): AsyncIterable<Row> {
			seenLimits.push(filterInfo.limit);
			let skipped = 0;
			let emitted = 0;
			for await (const row of query(filterInfo)) {
				if (skipped < (filterInfo.offset ?? 0)) {
					skipped++;
					continue;
				}
				if (filterInfo.limit !== undefined && emitted >= filterInfo.limit) return;
				emitted++;
				yield row;
			}
		};
		return table;
	}
}

/**
 * Advertises an ordinal seek on its primary-key walk, so `order by id limit n offset k`
 * hands it `FilterInfo.offset` — the k-th row in committed order, which staged rows shift.
 */
class OrdinalSeekModule extends TruncatingModule {
	override getBestAccessPlan(db: Db, tableInfo: TableSchema, request: BestAccessPlanRequest): BestAccessPlanResult {
		return {
			...super.getBestAccessPlan(db, tableInfo, request),
			monotonicOn: { columnIndex: 0, direction: 'asc', strict: true },
			supportsOrdinalSeek: true,
		};
	}
}

describe('plan-time limit under the isolation overlay', () => {
	let db: Database;
	let underlying: TruncatingModule;

	const open = async (module: TruncatingModule): Promise<void> => {
		db = new Database();
		underlying = module;
		db.registerModule('isolated', new IsolationModule({ underlying }));
		await db.exec('create table t (id integer primary key, a integer) using isolated');
		await db.exec('insert into t values (1, 1), (2, 2), (3, 3), (4, 4)');
	};

	const ids = async (sql: string): Promise<unknown[]> => {
		const out: unknown[] = [];
		for await (const row of db.eval(sql)) out.push(Object.values(row)[0]);
		return out;
	};

	afterEach(async () => {
		await db.close();
	});

	describe('a granted row bound', () => {
		beforeEach(async () => {
			await open(new TruncatingModule());
		});

		it('reaches the underlying when the transaction staged nothing', async () => {
			// Without this the cases below would pass with no bound stamped at all.
			underlying.seenLimits.length = 0;
			expect(await ids('select min(id) from t')).to.deep.equal([1]);
			expect(underlying.seenLimits).to.deep.equal([1]);
		});

		it('is not used up by a deleted committed row', async () => {
			await db.exec('begin');
			await db.exec('delete from t where id = 1');
			expect(await ids('select min(id) from t')).to.deep.equal([2]);
		});

		it('is not used up by a re-keyed committed row', async () => {
			await db.exec('begin');
			await db.exec('update t set id = 10 where id = 1');
			expect(await ids('select min(id) from t')).to.deep.equal([2]);
		});
	});

	it('an ordinal seek counts positions in the merged stream, not the committed one', async () => {
		await open(new OrdinalSeekModule());
		await db.exec('begin');
		await db.exec('delete from t where id = 1');
		expect(await ids('select id from t order by id limit 2 offset 1')).to.deep.equal([3, 4]);
	});
});
