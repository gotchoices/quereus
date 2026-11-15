import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import {
	AccessPlanBuilder, Database, IndexConstraintOp, MemoryTableModule, asyncIterableToArray, compareSqlValues,
	decodeIdxStr, makeFullScanFilterInfo, planCodeFromKind, validateAccessPlan,
} from '@quereus/quereus';
import type {
	AccessPath, BaseModuleConfig, BestAccessPlanRequest, BestAccessPlanResult, Database as Db, FilterInfo, Row,
	SqlValue, TableSchema,
} from '@quereus/quereus';
import { IsolationModule } from '../src/index.js';

/**
 * A read inside a transaction over module-listed seek arguments (plan `moduleSeek`) returns
 * the rows it would return after commit.
 *
 * The double lists every `=` / range filter on the box columns `x` and `y` as
 * `moduleSeekFilters`, under `seekIndexName`: the default `_box_` resolves to no index and
 * the plan claims no order, so it arrives as an `unorderedIndex` access path (the shape a
 * multi-dimensional index answering a box takes); a schema index name resolves to an
 * ordinary `index` path. It answers a plan=8 read itself, applying every constraint, and
 * emits matching rows in descending primary-key order, so a merge that relied on
 * primary-key order would mis-shadow. Every other read, write and commit is memory's own.
 */
class ModuleSeekMemoryModule extends MemoryTableModule {
	seekIndexName = '_box_';
	/** The access path of each plan=8 read the underlying served. */
	readonly seekPaths: (AccessPath | undefined)[] = [];
	private readonly wrapped = new WeakSet<object>();

	override getBestAccessPlan(db: Db, tableInfo: TableSchema, request: BestAccessPlanRequest): BestAccessPlanResult {
		const listed = request.filters.flatMap((f, i) => BOX_COLUMNS.has(f.columnIndex) && SEEK_OPS.has(f.op) ? [i] : []);
		if (listed.length === 0) return super.getBestAccessPlan(db, tableInfo, request);
		const plan: BestAccessPlanResult = {
			...AccessPlanBuilder.rangeScan(1, 0.1)
				.setHandledFilters(request.filters.map((_, i) => listed.includes(i)))
				.setIndexName(this.seekIndexName)
				.build(),
			moduleSeekFilters: listed,
		};
		validateAccessPlan(request, plan, tableInfo.vtabModuleName);
		return plan;
	}

	override async create(db: Db, tableSchema: TableSchema) {
		return this.answerSeeks(await super.create(db, tableSchema));
	}

	override async connect(
		db: Db,
		pAux: unknown,
		moduleName: string,
		schemaName: string,
		tableName: string,
		options: BaseModuleConfig,
		tableSchema?: TableSchema,
	) {
		return this.answerSeeks(
			await super.connect(db, pAux, moduleName, schemaName, tableName, options as never, tableSchema));
	}

	private answerSeeks<T extends { query: (fi: FilterInfo) => AsyncIterable<Row> }>(table: T): T {
		if (this.wrapped.has(table)) return table;
		this.wrapped.add(table);
		const scan = table.query.bind(table);
		const seekPaths = this.seekPaths;
		table.query = (filterInfo: FilterInfo): AsyncIterable<Row> => {
			if (decodeIdxStr(filterInfo.idxStr)?.plan !== planCodeFromKind('moduleSeek')) return scan(filterInfo);
			seekPaths.push(filterInfo.accessPath);
			return seekInDescendingKeyOrder(scan, filterInfo);
		};
		return table;
	}
}

const BOX_COLUMNS: ReadonlySet<number> = new Set([1, 2]);
const SEEK_OPS: ReadonlySet<string> = new Set(['=', '<', '<=', '>', '>=']);

async function* seekInDescendingKeyOrder(
	scan: (fi: FilterInfo) => AsyncIterable<Row>,
	filterInfo: FilterInfo,
): AsyncIterable<Row> {
	const rows = await asyncIterableToArray(scan(makeFullScanFilterInfo()));
	for (let i = rows.length - 1; i >= 0; i--) {
		if (filterInfo.constraints.every(({ constraint, argvIndex }) =>
			comparisonHolds(rows[i][constraint.iColumn], constraint.op, filterInfo.args[argvIndex - 1]))) {
			yield rows[i];
		}
	}
}

function comparisonHolds(value: SqlValue, op: IndexConstraintOp, arg: SqlValue | undefined): boolean {
	if (value === null || arg === null || arg === undefined) return false;
	const cmp = compareSqlValues(value, arg);
	switch (op) {
		case IndexConstraintOp.EQ: return cmp === 0;
		case IndexConstraintOp.GT: return cmp > 0;
		case IndexConstraintOp.GE: return cmp >= 0;
		case IndexConstraintOp.LT: return cmp < 0;
		case IndexConstraintOp.LE: return cmp <= 0;
		default: throw new Error(`ModuleSeekMemoryModule cannot apply constraint op ${op}`);
	}
}

describe('module-listed seek arguments under the isolation overlay', () => {
	let db: Database;
	let mod: ModuleSeekMemoryModule;

	const ids = async (sql: string, params?: SqlValue[]): Promise<number[]> => {
		const out: number[] = [];
		for await (const row of db.eval(sql, params)) out.push(row.id as number);
		return out.sort((a, b) => a - b);
	};

	/** Asserts the answer in the transaction, then that commit leaves it unchanged. */
	const expectStableAcrossCommit = async (sql: string, expected: number[], params?: SqlValue[]): Promise<void> => {
		expect(await ids(sql, params), 'inside the transaction').to.deep.equal(expected);
		await db.exec('commit');
		expect(await ids(sql, params), 'after commit').to.deep.equal(expected);
	};

	beforeEach(async () => {
		db = new Database();
		mod = new ModuleSeekMemoryModule();
		db.registerModule('isolated', new IsolationModule({ underlying: mod }));
		await db.exec('create table t (id integer primary key, x integer, y integer) using isolated');
	});

	afterEach(async () => {
		await db.close();
	});

	it('merges staged inserts, updates and deletes into a box read over an index with no describable order', async () => {
		await db.exec('insert into t values (1, 1, 1), (2, 5, 5), (3, 9, 9), (4, 2, 3), (5, 8, 2), (6, 3, 3)');
		await db.exec('begin');
		await db.exec('insert into t values (7, 4, 4), (8, 10, 1)');
		await db.exec('update t set x = 20 where id = 6');
		await db.exec('update t set x = 2 where id = 5');
		await db.exec('delete from t where id = 4');
		await expectStableAcrossCommit('select id from t where x >= 0 and x <= 6 and y >= 0 and y <= 6', [1, 2, 5, 7]);
		expect(mod.seekPaths[0]?.kind).to.equal('unorderedIndex');
	});

	it('reads several equalities a module listed on one column as a conjunction', async () => {
		await db.exec('create index t_x on t (x)');
		mod.seekIndexName = 't_x';
		await db.exec('insert into t values (1, 1, 1), (2, 2, 2)');
		await db.exec('begin');
		await db.exec('insert into t values (3, 1, 3)');
		await expectStableAcrossCommit('select id from t where x = ? and x = ?', [], [1, 2]);
		expect(mod.seekPaths[0]?.kind).to.equal('index');
	});
});
