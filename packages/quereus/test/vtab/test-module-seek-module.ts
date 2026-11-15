/**
 * Test virtual-table module that answers with module-listed seek arguments
 * (`BestAccessPlanResult.moduleSeekFilters`): it handles every `=` and range filter on a
 * configurable set of columns, lists them in `request.filters` order on a minted index
 * name with no descriptor (unless one is configured), and applies whatever `FilterInfo.constraints` / `args` it gets
 * back. That is the shape a multi-dimensional index answering a box query takes.
 *
 * Rows are emitted in reverse insertion order, which is not primary-key order, so a test
 * that depends on emission order notices.
 */

import type { Database } from '../../src/core/database.js';
import { VirtualTable, type UpdateArgs } from '../../src/vtab/table.js';
import type { VirtualTableModule, BaseModuleConfig } from '../../src/vtab/module.js';
import type { TableSchema } from '../../src/schema/table.js';
import type { Row, SqlValue, UpdateResult } from '../../src/common/types.js';
import { IndexConstraintOp } from '../../src/common/constants.js';
import type { FilterInfo } from '../../src/vtab/filter-info.js';
import type { IndexDescriptor } from '../../src/vtab/index-descriptor.js';
import { decodeIdxStr, idxStrSentinel, planCodeFromKind } from '../../src/vtab/idx-str.js';
import { compareSqlValues } from '../../src/util/comparison.js';
import {
	AccessPlanBuilder,
	type BestAccessPlanRequest,
	type BestAccessPlanResult,
	type PredicateConstraint,
	validateAccessPlan,
} from '../../src/vtab/best-access-plan.js';

/** The index name this module mints; the engine can resolve nothing by it. */
export const MODULE_SEEK_INDEX_NAME = '_box_';

/** Row storage, keyed `schema.table` (lowercased). Tests seed it via INSERT. */
export const moduleSeekStore = new Map<string, Row[]>();

const SEEK_OPS: ReadonlySet<string> = new Set(['=', '<', '<=', '>', '>=']);

export class TestModuleSeekModule implements VirtualTableModule<TestModuleSeekTable, BaseModuleConfig> {
	/** Columns whose `=` / range filters the module handles and lists. */
	listedColumns: ReadonlySet<number> = new Set();
	/** A column whose `=` filter the module handles WITHOUT listing it. */
	unlistedColumn: number | undefined;
	/** When true the plan lists nothing, while still handling what it would have listed. */
	listNothing = false;
	/**
	 * When set, the plan describes its index with this descriptor and claims ascending
	 * order on its last key column. The claim is not honoured: rows still come out in
	 * reverse insertion order, so a test only passes if the engine keeps its Sort.
	 */
	descriptor: IndexDescriptor | undefined;
	/** The FilterInfo of the most recent `query()`, for assertions. */
	lastFilterInfo: FilterInfo | undefined;
	queryCount = 0;

	async create(db: Database, tableSchema: TableSchema): Promise<TestModuleSeekTable> {
		return new TestModuleSeekTable(db, this, tableSchema);
	}

	async connect(
		db: Database,
		_pAux: unknown,
		_moduleName: string,
		schemaName: string,
		tableName: string,
		_options: BaseModuleConfig,
		importedTableSchema?: TableSchema,
	): Promise<TestModuleSeekTable> {
		const tableSchema = importedTableSchema ?? db.schemaManager.getTable(schemaName, tableName);
		if (!tableSchema) throw new Error(`Table ${schemaName}.${tableName} not found`);
		return new TestModuleSeekTable(db, this, tableSchema);
	}

	async destroy(): Promise<void> { /* tests manage moduleSeekStore directly */ }

	getBestAccessPlan(_db: Database, tableInfo: TableSchema, request: BestAccessPlanRequest): BestAccessPlanResult {
		const listable = (f: PredicateConstraint): boolean => this.listedColumns.has(f.columnIndex) && SEEK_OPS.has(f.op);
		const handled = request.filters.map(f => listable(f) || (f.columnIndex === this.unlistedColumn && f.op === '='));
		// Priced as a full scan, so the engine's seek-versus-scan probe (no filters) loses to the box.
		if (!handled.some(h => h)) {
			return AccessPlanBuilder.fullScan(100).setHandledFilters(handled).build();
		}
		const listed = this.listNothing ? [] : request.filters.flatMap((f, i) => listable(f) ? [i] : []);
		const plan: BestAccessPlanResult = {
			...AccessPlanBuilder.rangeScan(1, 0.1)
				.setHandledFilters(handled)
				.setIndexName(MODULE_SEEK_INDEX_NAME)
				.setExplanation('TestModuleSeekModule box lookup')
				.build(),
			moduleSeekFilters: listed,
			...this.orderingClaim(),
		};
		validateAccessPlan(request, plan, tableInfo.vtabModuleName);
		return plan;
	}

	private orderingClaim(): Partial<BestAccessPlanResult> {
		if (!this.descriptor) return {};
		const last = this.descriptor.keyColumns[this.descriptor.keyColumns.length - 1];
		return {
			indexDescriptor: this.descriptor,
			orderingIndexName: MODULE_SEEK_INDEX_NAME,
			providesOrdering: [{ columnIndex: last.columnIndex, desc: false }],
		};
	}
}

export class TestModuleSeekTable extends VirtualTable {
	private readonly storeKey: string;

	constructor(db: Database, private readonly owner: TestModuleSeekModule, tableSchema: TableSchema) {
		super(db, owner, tableSchema.schemaName, tableSchema.name);
		this.tableSchema = tableSchema;
		this.storeKey = `${tableSchema.schemaName}.${tableSchema.name}`.toLowerCase();
		if (!moduleSeekStore.has(this.storeKey)) moduleSeekStore.set(this.storeKey, []);
	}

	async disconnect(): Promise<void> { /* no-op */ }

	async update(args: UpdateArgs): Promise<UpdateResult> {
		if (args.operation === 'insert' && args.values) {
			moduleSeekStore.get(this.storeKey)!.push(args.values);
			return { status: 'ok', row: args.values };
		}
		return { status: 'ok' };
	}

	async *query(filterInfo: FilterInfo): AsyncIterable<Row> {
		this.owner.lastFilterInfo = filterInfo;
		this.owner.queryCount++;
		// A collation decline hands this module a plain full scan instead.
		if (idxStrSentinel(filterInfo.idxStr) !== 'fullScan') {
			const spec = decodeIdxStr(filterInfo.idxStr);
			if (spec?.indexName !== MODULE_SEEK_INDEX_NAME || spec.plan !== planCodeFromKind('moduleSeek')) {
				throw new Error(`TestModuleSeekModule expected a plan=8 seek on ${MODULE_SEEK_INDEX_NAME}, got '${filterInfo.idxStr}'`);
			}
		}
		const rows = moduleSeekStore.get(this.storeKey) ?? [];
		for (let i = rows.length - 1; i >= 0; i--) {
			if (matchesEvery(rows[i], filterInfo)) yield rows[i];
		}
	}
}

/** Every delivered constraint holds; a null value or null argument never matches. */
function matchesEvery(row: Row, filterInfo: FilterInfo): boolean {
	return filterInfo.constraints.every(({ constraint, argvIndex }) =>
		comparisonHolds(row[constraint.iColumn], constraint.op, filterInfo.args[argvIndex - 1]));
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
		default: throw new Error(`TestModuleSeekModule cannot apply constraint op ${op}`);
	}
}
