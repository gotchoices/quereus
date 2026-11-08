import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { Row } from '../../src/common/types.js';
import { VirtualTable } from '../../src/vtab/table.js';
import type { VirtualTableModule, BaseModuleConfig } from '../../src/vtab/module.js';
import type { TableSchema } from '../../src/schema/table.js';
import type { FilterInfo } from '../../src/vtab/filter-info.js';
import type { BestAccessPlanRequest, BestAccessPlanResult } from '../../src/vtab/best-access-plan.js';
import { compareSqlValues } from '../../src/util/comparison.js';

/** Rows for the single table under test: (id, s) with s nullable. */
const rows: Row[] = [['1', 'b'], ['2', null], ['3', 'a']];

/**
 * Claims every `requiredOrdering` it is asked for and serves it with the engine's default
 * NULL placement (NULLs first, both directions). It cannot see an explicit NULLS LAST, so
 * the planner must not hand it a sort that asks for one.
 */
class OrderClaimingModule implements VirtualTableModule<OrderClaimingTable, BaseModuleConfig> {
	async create(db: Database, tableSchema: TableSchema): Promise<OrderClaimingTable> {
		return new OrderClaimingTable(db, this, tableSchema);
	}
	async connect(db: Database, _pAux: unknown, _m: string, schemaName: string, tableName: string): Promise<OrderClaimingTable> {
		return new OrderClaimingTable(db, this, db.schemaManager.getTable(schemaName, tableName)!);
	}
	async destroy(): Promise<void> { /* rows are static */ }
	getBestAccessPlan(_db: Database, _t: TableSchema, request: BestAccessPlanRequest): BestAccessPlanResult {
		const ordering = request.requiredOrdering;
		return {
			handledFilters: request.filters.map(() => false),
			cost: 1,
			rows: rows.length,
			...(ordering?.length
				? { providesOrdering: ordering, orderingIndexName: `ord_${ordering.map(o => `${o.columnIndex}${o.desc ? 'd' : 'a'}`).join('_')}` }
				: {}),
		};
	}
}

class OrderClaimingTable extends VirtualTable {
	constructor(db: Database, module: OrderClaimingModule, tableSchema: TableSchema) {
		super(db, module, tableSchema.schemaName, tableSchema.name);
		this.tableSchema = tableSchema;
	}
	async disconnect(): Promise<void> { /* no-op */ }
	async update(): Promise<never> { throw new Error('read-only'); }
	async *query(filterInfo: FilterInfo): AsyncIterable<Row> {
		// Recover the claimed ordering from the index name the planner stamps into idxStr.
		const spec = (filterInfo.idxStr ?? '').match(/idx=ord_([^(;]+)/)?.[1];
		const keys = spec?.split('_').map(k => ({ col: Number(k.slice(0, -1)), desc: k.endsWith('d') })) ?? [];
		yield* rows.slice().sort((a, b) => {
			for (const { col, desc } of keys) {
				if (a[col] === null || b[col] === null) {
					const c = a[col] === b[col] ? 0 : a[col] === null ? -1 : 1;
					if (c !== 0) return c;
					continue;
				}
				const c = compareSqlValues(a[col], b[col]);
				if (c !== 0) return desc ? -c : c;
			}
			return 0;
		});
	}
}

describe('Explicit NULLS placement with a module that claims the ordering', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		db.registerModule('order_claiming', new OrderClaimingModule());
		await db.exec('create table t (id text primary key, s text null) using order_claiming');
	});

	afterEach(async () => {
		await db.close();
	});

	/** `select *` keeps the Sort directly above the table access, where the module is asked for it. */
	async function column(name: 'id' | 's', orderBy: string): Promise<unknown[]> {
		const out: unknown[] = [];
		for await (const r of db.eval(`select * from t order by ${orderBy}`)) out.push(r[name]);
		return out;
	}

	it('returns rows in the requested NULL placement', async () => {
		expect(await column('s', 's nulls last')).to.deep.equal(['a', 'b', null]);
		expect(await column('s', 's nulls first')).to.deep.equal([null, 'a', 'b']);
		expect(await column('s', 's')).to.deep.equal([null, 'a', 'b']);
		expect(await column('s', 's desc nulls first')).to.deep.equal([null, 'b', 'a']);
		// NOT NULL column: the placement cannot change the answer.
		expect(await column('id', 'id desc nulls last')).to.deep.equal(['3', '2', '1']);
	});
});
