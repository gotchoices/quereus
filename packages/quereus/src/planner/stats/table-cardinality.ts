/**
 * The base-table row-count seam.
 *
 * Every planner reading of a base table's size goes through {@link plannedRowCount}:
 * the count observed during execution (the per-database overlay, see
 * `core/database-cardinality-feedback.ts`), else the catalog's count, else
 * `undefined`. `TableReferenceNode` (every scan's base cardinality, and the
 * `BestAccessPlanRequest.estimatedRows` hint) and `CatalogStatsProvider.tableRows`
 * (selectivity denominators, MV sizing) both call it, so scan cardinality and the
 * stats-provider estimate cannot drift apart within one plan.
 *
 * There are exactly two spellings: `undefined` means "nobody knows" and a number —
 * including a real 0 — means "measured". `undefined` must stay `undefined` here:
 * callers apply their own fallback (e.g. NaiveStatsProvider's default of 1000), and
 * folding a default in would change every un-analyzed table's cardinality.
 *
 * NOTE: the catalog `rowCount` is a snapshot from the last `ANALYZE` — rows written
 * afterwards are invisible until the next one (or until a complete scan is observed).
 *
 * NOTE: a real 0 (analyzed or observed empty table) is distinct from `undefined`,
 * but the `estimatedRows || default` spellings in `rule-select-access-path`,
 * `rule-grow-retrieve` and `IndexSeekNode.computePhysical` collapse the two and
 * substitute their default — so a measured empty table reaches `getBestAccessPlan`
 * as "unknown" (1000) while a SeqScan over it reports 0. Harmless today (any plan
 * over 0 rows is cheap); switch those to `??` if an empty-table plan ever costs out
 * wrong.
 */

import type { TableSchema } from '../../schema/table.js';

/**
 * Exact table sizes observed during execution. Answers only for the `TableSchema`
 * object the count was observed against, so any schema swap (`ANALYZE`, `ALTER`,
 * drop and re-create) silences an entry.
 */
export interface ObservedRowCounts {
	observedRows(table: TableSchema): number | undefined;
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
 * The base-table row count the planner uses: observed, else catalog (`ANALYZE`), else
 * `undefined` (unknown). The overlay wins because an entry only answers for the exact
 * `TableSchema` it was observed under and any `ANALYZE` swaps that object — an
 * answering entry is always newer than the catalog numbers on the schema it names.
 * Only the row count is overridden; column statistics are untouched.
 *
 * NOTE: accepted tradeoff — the result also becomes `BestAccessPlanRequest.estimatedRows`,
 * and a self-sizing module (`StoreModule.sizeRequestFromLiveCount`) honors a supplied
 * hint over its own running count, so between full scans it prices against the last
 * observed size instead of its live one; one size per plan weighed over the fresher
 * live count. Revisit when a module's live size reaches the planner
 * (`feat-planner-asks-the-backend-how-big-a-table-is`) — it should outrank the overlay.
 */
export function plannedRowCount(table: TableSchema, observed: ObservedRowCounts | undefined): number | undefined {
	return observed?.observedRows(table) ?? catalogRowCount(table);
}
