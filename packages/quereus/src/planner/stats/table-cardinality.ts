/**
 * The base-table row-count seam.
 *
 * Every planner reading of a base table's size goes through {@link plannedRowCount},
 * which ranks four sources (docs/progressive-optimizer.md §3.3): an exact count the
 * table's module maintains (`VirtualTableModule.getRowCount`), the count observed
 * during execution (the per-database overlay, see `core/database-cardinality-feedback.ts`),
 * an approximate module count, the catalog's count — else `undefined`.
 * `TableReferenceNode` (every scan's base cardinality, and the
 * `BestAccessPlanRequest.estimatedRows` hint) and `CatalogStatsProvider.tableRows`
 * (selectivity denominators, MV sizing) both call it with the database's one
 * {@link RowCountSources}, so scan cardinality and the stats-provider estimate cannot
 * drift apart within one plan.
 *
 * There are exactly two spellings: `undefined` means "nobody knows" and a number —
 * including a real 0 — means "measured". `undefined` must stay `undefined` here:
 * callers apply their own fallback (e.g. NaiveStatsProvider's default of 1000), and
 * folding a default in would change every un-analyzed table's cardinality.
 *
 * NOTE: the catalog `rowCount` is a snapshot from the last `ANALYZE` — rows written
 * afterwards are invisible until the next one (or until a complete scan is observed),
 * unless the module reports its own count.
 *
 * A real 0 (analyzed or observed empty table) is relayed as 0 everywhere a row count is
 * reported. Sites that turn a count into a COST floor a measured 0 at one row instead
 * (`costedRows` in `planner/util/row-estimates.ts`; the store's request sizing floors
 * its own): a zero goes stale on the first insert, and a table priced at nothing would
 * trade its primary-key seeks for scans (docs/optimizer-costing.md § Base-table row
 * estimates).
 */

import type { TableSchema } from '../../schema/table.js';
import type { Database } from '../../core/database.js';
import type { ModuleRowCount } from '../../vtab/module.js';
import { createLogger } from '../../common/logger.js';

const debugLog = createLogger('optimizer:stats:row-count').extend('debug');

/** What execution has shown of one table's size: an exact count, a floor, or both. */
export interface ObservedRowCount {
	/** Exact row count from the latest complete read; absent when the table is known only from below. */
	readonly rows?: number;
	/** The table holds at least this many rows, proven by a read of part of it. */
	readonly atLeast?: number;
}

/**
 * Table sizes observed during execution. Answers only for the `TableSchema` object the
 * observation was made against, so any schema swap (`ANALYZE`, `ALTER`, drop and
 * re-create) silences an entry.
 */
export interface ObservedRowCounts {
	observedRows(table: TableSchema): ObservedRowCount | undefined;
}

/**
 * The catalog's row count — `TableSchema.statistics`, populated by `ANALYZE` or VTab
 * reporting.
 *
 * NOTE: planner reads go through {@link plannedRowCount}. The remaining callers —
 * assertion and watcher delta sizing, the lens prover's cardinality band,
 * auto-analyze's staleness arithmetic — are catalog-only on purpose: none of them
 * plans a query, and auto-analyze must not be fed numbers it did not collect.
 */
export function catalogRowCount(table: TableSchema): number | undefined {
	return table.statistics?.rowCount;
}

/**
 * Everything {@link plannedRowCount} ranks besides the catalog. One per `Database`
 * ({@link databaseRowCountSources}), shared by every planner reader.
 */
export interface RowCountSources extends ObservedRowCounts {
	/** The table's module's own count — {@link reportedRowCount}. */
	reportedRows(table: TableSchema): ModuleRowCount | undefined;
}

/** The database's row-count sources: its observed overlay, and its tables' modules. */
export function databaseRowCountSources(db: Database, observed: ObservedRowCounts): RowCountSources {
	return {
		observedRows: table => observed.observedRows(table),
		reportedRows: table => reportedRowCount(db, table),
	};
}

/** True when `table`'s registered module implements `VirtualTableModule.getRowCount`, whether or not it answers now. */
export function moduleReportsRowCount(db: Database, table: TableSchema): boolean {
	return db.schemaManager.getModule(table.vtabModuleName)?.module.getRowCount !== undefined;
}

/**
 * Asks `table`'s registered module for its count (`VirtualTableModule.getRowCount`).
 * A hint, so a module without the hook, a throw, or a malformed answer (`rows` not a
 * non-negative integer) is `undefined` — a failed hint must never fail planning.
 */
export function reportedRowCount(db: Database, table: TableSchema): ModuleRowCount | undefined {
	const module = db.schemaManager.getModule(table.vtabModuleName)?.module;
	if (!module?.getRowCount) return undefined;
	let answer: ModuleRowCount | undefined;
	try {
		answer = module.getRowCount(db, table);
	} catch (e) {
		debugLog('Ignored row count for %s.%s: module %s threw %O', table.schemaName, table.name, table.vtabModuleName, e);
		return undefined;
	}
	if (answer === undefined) return undefined;
	if (!Number.isInteger(answer.rows) || answer.rows < 0) {
		debugLog('Ignored row count for %s.%s: module %s answered %o', table.schemaName, table.name, table.vtabModuleName, answer);
		return undefined;
	}
	return answer;
}

/**
 * The base-table row count the planner uses, first answer wins:
 *
 * 1. an exact module count — maintained on every write, so it is the truth now and any
 *    snapshot below is older;
 * 2. the overlay's observed count — an entry only answers for the exact `TableSchema`
 *    it was observed under and any `ANALYZE` swaps that object, so it is newer than the
 *    catalog numbers on the schema it names;
 * 3. an approximate module count — below a measurement this session made, because an
 *    estimate can be off by more than the overlay's shift factor and only a complete
 *    scan can correct it; above the catalog, because it describes the table now;
 * 4. the catalog (`ANALYZE`) count;
 * 5. `undefined` (unknown).
 *
 * The overlay's floor then raises whatever answered from 2–4, and answers alone when
 * nothing did (it was recorded only above the default). It never raises an exact module
 * count: that is current, and a floor describes committed state at some earlier moment,
 * so it cannot legitimately exceed it.
 *
 * The module is asked first so an exactly-sized table never touches the overlay, whose
 * reads refresh its recency. Only the row count is overridden; column statistics are
 * untouched.
 *
 * The result also becomes `BestAccessPlanRequest.estimatedRows`, so a module that reports
 * its count prices its access path against the same number the rest of the plan uses —
 * one size per plan.
 */
export function plannedRowCount(table: TableSchema, sources: RowCountSources | undefined): number | undefined {
	const reported = sources?.reportedRows(table);
	if (reported?.exact) return reported.rows;
	const observed = sources?.observedRows(table);
	return raiseToFloor(observed?.rows ?? reported?.rows ?? catalogRowCount(table), observed?.atLeast);
}

function raiseToFloor(rows: number | undefined, floor: number | undefined): number | undefined {
	if (floor === undefined) return rows;
	return rows === undefined ? floor : Math.max(rows, floor);
}
