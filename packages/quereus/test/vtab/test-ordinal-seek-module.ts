/**
 * Test virtual-table module with O(log N) ordinal seek support.
 *
 * Backs each table with a sorted array indexed by an integer primary key.
 * Advertises `monotonicOn` + `supportsOrdinalSeek` on PK-ordered scans so
 * the `monotonic-limit-pushdown` rule can fire end-to-end during tests.
 *
 * Honors `FilterInfo.offset` and `FilterInfo.limit` directives by slicing
 * the sorted backing array before yielding — the whole point of the
 * ordinal-seek capability.
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

type OrdinalSeekTableConfig = BaseModuleConfig;

/**
 * In-memory store keyed by qualified table name. Tests can pre-populate
 * this before calling `CREATE TABLE … USING ord_seek` so the `connect`
 * call returns a table backed by deterministic data.
 */
export const ordSeekStore = new Map<string, Row[]>();

export function setOrdSeekData(schemaName: string, tableName: string, rows: Row[]): void {
	const key = `${schemaName}.${tableName}`.toLowerCase();
	ordSeekStore.set(key, rows.slice());
}

export class TestOrdinalSeekModule
	implements VirtualTableModule<TestOrdinalSeekTable, OrdinalSeekTableConfig>
{
	/**
	 * Tracks the offset/limit values the most recent `query()` call observed
	 * via FilterInfo. Tests inspect this to confirm the rule pushed bounds
	 * into the scan rather than buffering above it.
	 */
	lastObservedOffset: number | undefined;
	lastObservedLimit: number | undefined;

	/** When false, suppress `monotonicOn` advertisement entirely. */
	advertiseMonotonic = true;
	/** When false, advertise `monotonicOn` but not `supportsOrdinalSeek`. */
	advertiseOrdinalSeek = true;

	async create(db: Database, tableSchema: TableSchema): Promise<TestOrdinalSeekTable> {
		return new TestOrdinalSeekTable(db, this, tableSchema);
	}

	async connect(
		db: Database,
		_pAux: unknown,
		_moduleName: string,
		schemaName: string,
		tableName: string,
		_options: OrdinalSeekTableConfig,
		importedTableSchema?: TableSchema,
	): Promise<TestOrdinalSeekTable> {
		const tableSchema = importedTableSchema ?? db.schemaManager.getTable(schemaName, tableName);
		if (!tableSchema) {
			throw new Error(`Table ${schemaName}.${tableName} not found`);
		}
		return new TestOrdinalSeekTable(db, this, tableSchema);
	}

	async destroy(): Promise<void> {
		// Tests manage `ordSeekStore` directly.
	}

	getBestAccessPlan(
		_db: Database,
		tableInfo: TableSchema,
		request: BestAccessPlanRequest,
	): BestAccessPlanResult {
		const pk = tableInfo.primaryKeyDefinition;
		const tableSize = request.estimatedRows ?? 1000;

		const advertiseOrdinalSeek = this.advertiseOrdinalSeek;
		const advertiseMonotonic = this.advertiseMonotonic;

		// We only support an unfiltered, single-column PK full scan in this
		// fixture (it's the only path with deterministic O(log N) ordinal seek
		// semantics over our backing array). Any filter falls back to full scan
		// without monotonicOn/ordinalSeek so the rule will not fire.
		const hasUsableFilter = request.filters.some(f => f.usable);
		const eligible =
			!hasUsableFilter && pk.length === 1;

		if (!eligible) {
			const plan = AccessPlanBuilder.fullScan(tableSize)
				.setHandledFilters(new Array(request.filters.length).fill(false))
				.setExplanation('OrdSeekModule full scan (ineligible)')
				.build();
			validateAccessPlan(request, plan);
			return plan;
		}

		const pkCol = pk[0];
		const direction: 'asc' | 'desc' = pkCol.desc ? 'desc' : 'asc';
		const naturalDesc = pkCol.desc ?? false;

		// Only claim to satisfy required ordering when it matches the PK's
		// natural direction. Otherwise leave providesOrdering unset so the
		// planner inserts a Sort (mirrors MemoryTableModule behavior).
		const required = request.requiredOrdering;
		const satisfiesRequired = !required
			|| (required.length === 1
				&& required[0].columnIndex === pkCol.index
				&& required[0].desc === naturalDesc);

		const builder = AccessPlanBuilder.fullScan(tableSize)
			.setHandledFilters(new Array(request.filters.length).fill(false))
			.setExplanation('OrdSeekModule PK scan')
			.setIndexName('_primary_')
			.setSeekColumns([]);

		const plan = builder.build();

		const result: BestAccessPlanResult = { ...plan };
		if (satisfiesRequired) {
			result.providesOrdering = [{ columnIndex: pkCol.index, desc: naturalDesc }];
			result.orderingIndexName = '_primary_';
		}

		// Always advertise monotonicOn(asc) when enabled — that's the leaf's
		// natural emit order. A Sort sitting above (added by the planner when
		// requiredOrdering was desc) carries its own direction and survives
		// the rule's direction check.
		if (advertiseMonotonic) {
			result.monotonicOn = { columnIndex: pkCol.index, direction, strict: true };
			if (advertiseOrdinalSeek) {
				result.supportsOrdinalSeek = true;
			}
		}

		validateAccessPlan(request, result);
		return result;
	}
}

export class TestOrdinalSeekTable extends VirtualTable {
	private readonly testModule: TestOrdinalSeekModule;
	private readonly storeKey: string;

	constructor(db: Database, module: TestOrdinalSeekModule, tableSchema: TableSchema) {
		super(db, module, tableSchema.schemaName, tableSchema.name);
		this.tableSchema = tableSchema;
		this.testModule = module;
		this.storeKey = `${tableSchema.schemaName}.${tableSchema.name}`.toLowerCase();
		if (!ordSeekStore.has(this.storeKey)) {
			ordSeekStore.set(this.storeKey, []);
		}
	}

	async disconnect(): Promise<void> {
		// no-op
	}

	async update(args: UpdateArgs): Promise<UpdateResult> {
		const rows = ordSeekStore.get(this.storeKey) ?? [];
		switch (args.operation) {
			case 'insert':
				if (args.values) {
					rows.push(args.values);
					rows.sort((a, b) => Number(a[0]) - Number(b[0]));
					ordSeekStore.set(this.storeKey, rows);
					return { status: 'ok', row: args.values };
				}
				return { status: 'ok' };
			case 'delete':
				if (args.oldKeyValues) {
					const idx = rows.findIndex(r => r[0] === args.oldKeyValues![0]);
					if (idx >= 0) rows.splice(idx, 1);
				}
				return { status: 'ok' };
			case 'update':
				if (args.oldKeyValues && args.values) {
					const idx = rows.findIndex(r => r[0] === args.oldKeyValues![0]);
					if (idx >= 0) {
						rows[idx] = args.values;
						return { status: 'ok', row: args.values };
					}
				}
				return { status: 'ok' };
		}
		return { status: 'ok' };
	}

	async *query(filterInfo: FilterInfo): AsyncIterable<Row> {
		this.testModule.lastObservedOffset = filterInfo.offset;
		this.testModule.lastObservedLimit = filterInfo.limit;

		const all = ordSeekStore.get(this.storeKey) ?? [];
		const start = filterInfo.offset !== undefined ? Math.max(0, Math.trunc(filterInfo.offset)) : 0;
		const cap = filterInfo.limit !== undefined ? Math.max(0, Math.trunc(filterInfo.limit)) : Infinity;
		const end = Number.isFinite(cap) ? Math.min(all.length, start + cap) : all.length;
		for (let i = start; i < end; i++) {
			yield all[i] as Row;
		}
	}
}
