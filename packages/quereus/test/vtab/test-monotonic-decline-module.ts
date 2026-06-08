/**
 * Test virtual-table module that advertises `monotonicOn` on its single-column
 * PK while *intentionally declining* range filters on that column. This
 * simulates a (rare) misbehaving module so the defensive escalation in
 * `rule-monotonic-range-access` can be exercised: a Filter sits directly above
 * a leaf with `monotonicOn(x)` because the vtab returned `handledFilters[i] =
 * false` for a range on `x` — the rule should drop `monotonicOn` from the
 * leaf so downstream rules don't rely on streaming monotonic emit over the
 * WHERE-restricted tuple set.
 */

import type { Database } from '../../src/core/database.js';
import { VirtualTable, type UpdateArgs } from '../../src/vtab/table.js';
import type { VirtualTableModule, BaseModuleConfig } from '../../src/vtab/module.js';
import type { TableSchema } from '../../src/schema/table.js';
import type { Row, UpdateResult } from '../../src/common/types.js';
import type { FilterInfo } from '../../src/vtab/filter-info.js';
import {
	AccessPlanBuilder,
	type BestAccessPlanRequest,
	type BestAccessPlanResult,
	validateAccessPlan,
} from '../../src/vtab/best-access-plan.js';

type DeclineTableConfig = BaseModuleConfig;

export const declineStore = new Map<string, Row[]>();

export function setDeclineData(schemaName: string, tableName: string, rows: Row[]): void {
	const key = `${schemaName}.${tableName}`.toLowerCase();
	declineStore.set(key, rows.slice());
}

export class TestMonotonicDeclineModule
	implements VirtualTableModule<TestMonotonicDeclineTable, DeclineTableConfig>
{
	async create(db: Database, tableSchema: TableSchema): Promise<TestMonotonicDeclineTable> {
		return new TestMonotonicDeclineTable(db, this, tableSchema);
	}

	async connect(
		db: Database,
		_pAux: unknown,
		_moduleName: string,
		schemaName: string,
		tableName: string,
		_options: DeclineTableConfig,
		importedTableSchema?: TableSchema,
	): Promise<TestMonotonicDeclineTable> {
		const tableSchema = importedTableSchema ?? db.schemaManager.getTable(schemaName, tableName);
		if (!tableSchema) {
			throw new Error(`Table ${schemaName}.${tableName} not found`);
		}
		return new TestMonotonicDeclineTable(db, this, tableSchema);
	}

	async destroy(): Promise<void> { /* tests manage declineStore directly */ }

	getBestAccessPlan(
		_db: Database,
		tableInfo: TableSchema,
		request: BestAccessPlanRequest,
	): BestAccessPlanResult {
		const pk = tableInfo.primaryKeyDefinition;
		const tableSize = request.estimatedRows ?? 100;

		// Always claim a full scan and decline every filter — including any range
		// on the PK column. This forces a residual Filter above the leaf.
		const plan = AccessPlanBuilder.fullScan(tableSize)
			.setHandledFilters(new Array(request.filters.length).fill(false))
			.setExplanation('DeclineModule full scan (all filters declined)')
			.setIndexName('_primary_')
			.setSeekColumns([])
			.build();

		const result: BestAccessPlanResult = { ...plan };

		// Advertise PK ordering so the access-path lowering routes us to
		// IndexScanNode (the "ordering-only" path), which lifts monotonicOn
		// via its advertisement plumbing. SeqScanNode would not.
		if (pk.length === 1) {
			result.providesOrdering = [{ columnIndex: pk[0].index, desc: pk[0].desc ?? false }];
			result.orderingIndexName = '_primary_';
			result.monotonicOn = {
				columnIndex: pk[0].index,
				direction: pk[0].desc ? 'desc' : 'asc',
				strict: true,
			};
			result.supportsAsofRight = true;
		}

		validateAccessPlan(request, result);
		return result;
	}
}

export class TestMonotonicDeclineTable extends VirtualTable {
	private readonly storeKey: string;

	constructor(db: Database, module: TestMonotonicDeclineModule, tableSchema: TableSchema) {
		super(db, module, tableSchema.schemaName, tableSchema.name);
		this.tableSchema = tableSchema;
		this.storeKey = `${tableSchema.schemaName}.${tableSchema.name}`.toLowerCase();
		if (!declineStore.has(this.storeKey)) {
			declineStore.set(this.storeKey, []);
		}
	}

	async disconnect(): Promise<void> { /* no-op */ }

	async update(args: UpdateArgs): Promise<UpdateResult> {
		const rows = declineStore.get(this.storeKey) ?? [];
		switch (args.operation) {
			case 'insert':
				if (args.values) {
					rows.push(args.values);
					rows.sort((a, b) => Number(a[0]) - Number(b[0]));
					declineStore.set(this.storeKey, rows);
					return { status: 'ok', row: args.values };
				}
				return { status: 'ok' };
			case 'delete':
				return { status: 'ok' };
			case 'update':
				return { status: 'ok' };
		}
		return { status: 'ok' };
	}

	async *query(_filterInfo: FilterInfo): AsyncIterable<Row> {
		const all = declineStore.get(this.storeKey) ?? [];
		for (const r of all) yield r as Row;
	}
}
