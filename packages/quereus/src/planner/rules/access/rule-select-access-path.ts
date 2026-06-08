/**
 * Rule: Select Access Path
 *
 * Required Characteristics:
 * - Node must be a RetrieveNode representing a virtual table access boundary
 * - Module must support either supports() (query-based) or getBestAccessPlan() (index-based)
 *
 * Applied When:
 * - RetrieveNode needs to be converted to appropriate physical access method
 *
 * Benefits: Enables cost-based access path selection and module-specific execution
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, ScalarPlanNode } from '../../nodes/plan-node.js';
import { isRelationalNode, type RelationalPlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { RetrieveNode } from '../../nodes/retrieve-node.js';
import { RemoteQueryNode } from '../../nodes/remote-query-node.js';
import { SeqScanNode, IndexScanNode, IndexSeekNode, EmptyResultNode, type AccessPathAdvertisement } from '../../nodes/table-access-nodes.js';
import { seqScanCost } from '../../cost/index.js';
import type { ColumnMeta, BestAccessPlanRequest, BestAccessPlanResult } from '../../../vtab/best-access-plan.js';
import { FilterInfo } from '../../../vtab/filter-info.js';
import type { IndexConstraint, IndexConstraintUsage } from '../../../vtab/index-info.js';
import type { SqlValue } from '../../../common/types.js';
import { compareSqlValues, normalizeCollationName } from '../../../util/comparison.js';
import type { Scope } from '../../scopes/scope.js';
import { TableReferenceNode } from '../../nodes/reference.js';
import { FilterNode } from '../../nodes/filter.js';
import { extractConstraintsForTable, type PredicateConstraint as PlannerPredicateConstraint, type RangeSpec, createTableInfoFromNode } from '../../analysis/constraint-extractor.js';
import { LiteralNode, BinaryOpNode, BetweenNode } from '../../nodes/scalar.js';
import { InNode } from '../../nodes/subquery.js';
import type { TableSchema } from '../../../schema/table.js';
import type * as AST from '../../../parser/ast.js';
import { IndexConstraintOp } from '../../../common/constants.js';

const log = createLogger('optimizer:rule:select-access-path');

/**
 * Extract the monotonic-ordering advertisement from a `BestAccessPlanResult`,
 * or return undefined when nothing is advertised. The result is forwarded to
 * the physical leaf node so it can lift the advertisement onto its
 * `physical.monotonicOn` / `physical.accessCapabilities`.
 */
function extractAdvertisement(plan: BestAccessPlanResult): AccessPathAdvertisement | undefined {
	if (!plan.monotonicOn && !plan.supportsOrdinalSeek && !plan.supportsAsofRight) {
		return undefined;
	}
	const advertisement: AccessPathAdvertisement = {};
	if (plan.monotonicOn) advertisement.monotonicOn = plan.monotonicOn;
	if (plan.supportsOrdinalSeek) advertisement.supportsOrdinalSeek = true;
	if (plan.supportsAsofRight) advertisement.supportsAsofRight = true;
	return advertisement;
}

export function ruleSelectAccessPath(node: PlanNode, context: OptContext): PlanNode | null {
	// Guard: node must be a RetrieveNode
	if (!(node instanceof RetrieveNode)) {
		return null;
	}

	const retrieveNode = node as RetrieveNode;
	const tableSchema = retrieveNode.tableRef.tableSchema;
	const vtabModule = retrieveNode.vtabModule;

	log('Selecting access path for retrieve over table %s', tableSchema.name);

	// Always allow fallback to sequential scan to guarantee physicalization
	// even when no specialized support is available.

	// If grow-retrieve established an index-style context, reuse it directly
	if (isIndexStyleContext(retrieveNode.moduleCtx)) {
		log('Using index-style context provided by grow-retrieve');
		const accessPlan = retrieveNode.moduleCtx.accessPlan;
		const originalConstraints = retrieveNode.moduleCtx.originalConstraints as unknown as PlannerPredicateConstraint[];
		const physicalLeaf: RelationalPlanNode = selectPhysicalNode(retrieveNode.tableRef, accessPlan, originalConstraints);
		if (retrieveNode.moduleCtx.residualPredicate) {
			return new FilterNode(retrieveNode.scope, physicalLeaf, retrieveNode.moduleCtx.residualPredicate);
		}
		return physicalLeaf;
	}

	// Check if module supports query-based execution via supports() method.
	// `supports()` is consulted FIRST because it can collapse multi-operator
	// pipelines (e.g. Aggregate-over-scan) into a single `RemoteQueryNode`.
	// When `supports()` declines, fall through to `getBestAccessPlan()` so a
	// module that exposes BOTH methods (the lamina-quereus adapter) can still
	// have its index-based access plan honoured — without this fall-through
	// the rule would `createSeqScan` immediately and silently drop every
	// WHERE constraint, since `supports()` only handles whole-subtree shapes.
	// See `tickets/complete/quereus-vtab-equality-filter-ignored`.
	if (vtabModule.supports && typeof vtabModule.supports === 'function') {
		log('Module has supports() method - checking support for current pipeline');

		// Check if module supports the current pipeline
		const assessment = vtabModule.supports(retrieveNode.source);

		if (assessment) {
			log('Pipeline supported - creating RemoteQueryNode (cost: %d)', assessment.cost);
			return new RemoteQueryNode(
				retrieveNode.scope,
				retrieveNode.source,
				retrieveNode.tableRef,
				assessment.ctx
			);
		}
		log('Pipeline not supported by module - falling through to index-based access path');
	}

	// Check if module supports index-based execution via getBestAccessPlan() method
	if (vtabModule.getBestAccessPlan && typeof vtabModule.getBestAccessPlan === 'function') {
		log('Module has getBestAccessPlan() method - using index-based execution for %s', tableSchema.name);

		return createIndexBasedAccess(retrieveNode, context);
	}

	// Fall back to sequential scan if module has no access planning support.
	// When the Retrieve's `source` carries additional operators (Filter, Sort,
	// LimitOffset) — typically produced when `rule-grow-retrieve` previously
	// slid them in — we MUST re-apply them above the `SeqScan`. Without this
	// the operators would be silently dropped and downstream callers would
	// see unfiltered rows. See
	// `tickets/complete/quereus-vtab-equality-filter-ignored`.
	log('No access planning support, using sequential scan for %s', tableSchema.name);
	const seqScan = createSeqScan(retrieveNode.tableRef);
	if (retrieveNode.source === retrieveNode.tableRef) {
		return seqScan;
	}
	return rebuildPipelineWithNewLeaf(retrieveNode.source, retrieveNode.tableRef, seqScan as unknown as RelationalPlanNode);
}

/**
 * Create index-based access for modules that support getBestAccessPlan()
 */
function createIndexBasedAccess(retrieveNode: RetrieveNode, context: OptContext): PlanNode {
	const tableSchema = retrieveNode.tableRef.tableSchema;
	const vtabModule = retrieveNode.vtabModule;

	// Check if we have pre-computed access plan from ruleGrowRetrieve
	let accessPlan: BestAccessPlanResult;
	let constraints: PlannerPredicateConstraint[];
	let residualPredicate: ScalarPlanNode | undefined;

	if (isIndexStyleContext(retrieveNode.moduleCtx)) {
		// Use pre-computed access plan from grow rule
		log('Using pre-computed access plan from grow rule');
		accessPlan = retrieveNode.moduleCtx.accessPlan;
		constraints = (retrieveNode.moduleCtx.originalConstraints as PlannerPredicateConstraint[]) || [];
		residualPredicate = retrieveNode.moduleCtx.residualPredicate;
	} else {
		// Extract constraints from grown pipeline in source using table instance key
		const tInfo = createTableInfoFromNode(retrieveNode.tableRef, `${tableSchema.schemaName}.${tableSchema.name}`);
		constraints = extractConstraintsForTable(retrieveNode.source, tInfo.relationKey);

		// Build request for getBestAccessPlan
		const request: BestAccessPlanRequest = {
			columns: tableSchema.columns.map((col, index) => ({
				index,
				name: col.name,
				type: col.logicalType,
				isPrimaryKey: col.primaryKey || false,
				isUnique: col.primaryKey || false // For now, assume only PK columns are unique
			} as ColumnMeta)),
			filters: constraints,
			estimatedRows: retrieveNode.tableRef.estimatedRows || undefined
		};

		// Use the vtab module's getBestAccessPlan method to get an optimized access plan
		accessPlan = vtabModule.getBestAccessPlan!(context.db, tableSchema, request) as BestAccessPlanResult;
	}

	// Choose physical node based on access plan
	const physicalLeaf: RelationalPlanNode = selectPhysicalNode(retrieveNode.tableRef, accessPlan, constraints);

	// If the Retrieve source contained a pipeline (e.g., Filter/Sort/Project), rebuild it above the physical leaf
	let rebuiltPipeline: RelationalPlanNode = physicalLeaf;
	if (retrieveNode.source !== retrieveNode.tableRef) {
		log('Rebuilding Retrieve pipeline above physical access node');
		rebuiltPipeline = rebuildPipelineWithNewLeaf(retrieveNode.source, retrieveNode.tableRef, physicalLeaf);
	}

	// Wrap with residual predicate if present (on top of rebuilt pipeline)
	let finalNode: PlanNode = rebuiltPipeline;
	if (residualPredicate) {
		log('Wrapping rebuilt pipeline with residual filter');
		finalNode = new FilterNode(rebuiltPipeline.scope, rebuiltPipeline, residualPredicate);
	}

	log('Selected access for table %s (cost: %f, rows: %s)', tableSchema.name, accessPlan.cost, accessPlan.rows);
	return finalNode;
}

/**
 * Rebuilds a relational pipeline by replacing the specified leaf with a new leaf.
 * Preserves all operators (e.g., Filter, Sort, Project) above the leaf.
 */
function rebuildPipelineWithNewLeaf(
	pipelineRoot: RelationalPlanNode,
	oldLeaf: RelationalPlanNode,
	newLeaf: RelationalPlanNode
): RelationalPlanNode {
	if (pipelineRoot === oldLeaf) {
		return newLeaf;
	}
	const children = pipelineRoot.getChildren();
	const newChildren: PlanNode[] = children.map(child => {
		if (isRelationalNode(child)) {
			return rebuildPipelineWithNewLeaf(child, oldLeaf, newLeaf);
		}
		return child; // keep scalar children unchanged
	});
	return pipelineRoot.withChildren(newChildren) as RelationalPlanNode;
}

/**
 * Select the appropriate physical node based on access plan
 */
function selectPhysicalNode(
	tableRef: TableReferenceNode,
	accessPlan: BestAccessPlanResult,
	constraints: PlannerPredicateConstraint[]
): RelationalPlanNode {

	// Empty result optimization (e.g., IS NULL on NOT NULL column)
	if (accessPlan.rows === 0 && accessPlan.handledFilters.every(h => h)) {
		log('Using empty result (impossible predicate detected)');
		return createEmptyResultNode(tableRef);
	}

	// Create a default FilterInfo for the physical nodes
	const filterInfo: FilterInfo = {
		idxNum: 0,
		idxStr: 'fullscan',
		constraints: [],
		args: [],
		indexInfoOutput: {
			nConstraint: 0,
			aConstraint: [],
			nOrderBy: 0,
			aOrderBy: [],
			aConstraintUsage: [] as IndexConstraintUsage[],
			idxNum: 0,
			idxStr: 'fullscan',
			orderByConsumed: false,
			estimatedCost: accessPlan.cost,
			estimatedRows: BigInt(accessPlan.rows || 1000),
			idxFlags: 0,
			colUsed: 0n,
		}
	};

	// Convert OrderingSpec[] to the format expected by physical nodes
	const providesOrdering = accessPlan.providesOrdering?.map(spec => ({
		column: spec.columnIndex,
		desc: spec.desc
	}));

	// --- Index-aware path: use module-provided index identity ---
	if (accessPlan.indexName && accessPlan.seekColumnIndexes && accessPlan.seekColumnIndexes.length > 0) {
		return selectPhysicalNodeFromPlan(tableRef, accessPlan, constraints, filterInfo, providesOrdering);
	}

	// --- Legacy fallback: infer access method from constraints and PK definition ---
	return selectPhysicalNodeLegacy(tableRef, accessPlan, constraints, filterInfo, providesOrdering);
}

/**
 * Index-aware physical node selection using module-provided indexName and seekColumnIndexes.
 * Works for both primary key and secondary indexes.
 */
function selectPhysicalNodeFromPlan(
	tableRef: TableReferenceNode,
	accessPlan: BestAccessPlanResult,
	constraints: PlannerPredicateConstraint[],
	filterInfo: FilterInfo,
	providesOrdering: { column: number; desc: boolean }[] | undefined
): RelationalPlanNode {
	const advertisement = extractAdvertisement(accessPlan);
	const seekCols = accessPlan.seekColumnIndexes!;
	// Map accessPlan.indexName to physical node indexName ('_primary_' → 'primary')
	const physicalIndexName = accessPlan.indexName === '_primary_' ? 'primary' : accessPlan.indexName!;
	// idxStr uses the raw name (scan-plan builder maps '_primary_' → 'primary')
	const idxStrName = accessPlan.indexName!;

	// Build a map of constraints by column index for quick lookup
	const constraintsByCol = new Map<number, PlannerPredicateConstraint[]>();
	for (const c of constraints) {
		if (!constraintsByCol.has(c.columnIndex)) constraintsByCol.set(c.columnIndex, []);
		constraintsByCol.get(c.columnIndex)!.push(c);
	}

	// Determine handled columns
	const handledByCol = new Set<number>();
	constraints.forEach((c, i) => {
		if (accessPlan.handledFilters[i] === true) handledByCol.add(c.columnIndex);
	});

	// Check if all seek columns have equality constraints (=, single-value IN, or multi-value IN)
	const eqBySeekCol = new Map<number, PlannerPredicateConstraint>();
	let allEquality = true;
	for (const colIdx of seekCols) {
		const colConstraints = constraintsByCol.get(colIdx) ?? [];
		const eqConstraint = colConstraints.find(c =>
			(c.op === '=' || (c.op === 'IN' && Array.isArray(c.value) && (c.value as unknown[]).length > 0)) &&
			handledByCol.has(c.columnIndex)
		);
		if (eqConstraint) {
			eqBySeekCol.set(colIdx, eqConstraint);
		} else {
			allEquality = false;
			break;
		}
	}

	if (allEquality && eqBySeekCol.size === seekCols.length) {
		// Collation-cover analysis: a seek over an index whose per-column collation
		// differs from the predicate's effective comparison collation is NOT a
		// complete substitute for the predicate. Decline (scan + residual) on an
		// unsafe mismatch; keep the seek and re-apply a residual when the index is a
		// provable superset (BINARY predicate over a coarser index). See
		// `index-collation-mismatch-residual-filter`.
		const cover = classifyCollationCover(
			seekCols.map(colIdx => ({ colIdx, constraint: eqBySeekCol.get(colIdx)! })),
			true,
			indexColumnCollationLookup(tableRef.tableSchema, accessPlan),
		);
		if (!cover.useIndex) {
			log('Declining index seek on %s (collation mismatch) — sequential scan + residual', physicalIndexName);
			const scan = createSeqScan(tableRef);
			return cover.residual ? new FilterNode(tableRef.scope, scan, cover.residual) : scan;
		}
		const finishSeek = (leaf: IndexSeekNode): RelationalPlanNode =>
			cover.residual ? new FilterNode(tableRef.scope, leaf, cover.residual) : leaf;

		// Check for multi-value IN on a single-column seek (simple case)
		const hasMultiValueIn = [...eqBySeekCol.values()].some(c =>
			c.op === 'IN' && Array.isArray(c.value) && (c.value as unknown[]).length > 1
		);

		if (hasMultiValueIn && seekCols.length === 1) {
			// Multi-seek: IN on single-column index
			const colIdx = seekCols[0];
			const inConstraint = eqBySeekCol.get(colIdx)!;
			const rawValues = inConstraint.value as unknown as SqlValue[];

			let seekKeys: ScalarPlanNode[];
			if (Array.isArray(inConstraint.valueExpr)) {
				// Mixed-binding IN (from OR collapse): some values are dynamic, so the
				// runtime scan-layer dedup/NULL-skip stays authoritative — keep the raw
				// list and let it perform set-membership at execution time.
				seekKeys = inConstraint.valueExpr;
			} else {
				// Pure-literal IN: collapse duplicate literals and drop NULLs so the
				// advertised inCount reflects the effective distinct non-null seek count.
				const effectiveValues = reduceLiteralSeekValues(rawValues);
				if (effectiveValues.length === 0) {
					// Every seek key is NULL ⇒ no row can match. Emit an empty result
					// rather than a zero-key multi-seek (inCount=0 would parse back to no
					// equalityKeys and degrade to an unbounded full-index walk).
					log('IN-list is entirely NULL literals on %s — using empty result', physicalIndexName);
					return createEmptyResultNode(tableRef);
				}
				seekKeys = effectiveValues.map(v => literalFromValue(tableRef.scope, v));
			}

			const inConstraints: { constraint: IndexConstraint; argvIndex: number }[] = seekKeys.map((_sk, i) => ({
				constraint: { iColumn: colIdx, op: IndexConstraintOp.EQ, usable: true },
				argvIndex: i + 1,
			}));
			const fi: FilterInfo = {
				...filterInfo,
				constraints: inConstraints,
				idxStr: `idx=${idxStrName}(0);plan=5;inCount=${seekKeys.length}`,
			};

			log('Using index multi-seek on %s (IN with %d values)', physicalIndexName, seekKeys.length);
			return finishSeek(new IndexSeekNode(
				tableRef.scope,
				tableRef,
				fi,
				physicalIndexName,
				seekKeys,
				false,
				providesOrdering,
				accessPlan.cost,
				advertisement,
			));
		}

		if (hasMultiValueIn && seekCols.length > 1) {
			// Composite IN multi-seek: generate cross-product of all column values
			const columnValues: { colIdx: number; values: SqlValue[]; exprs?: ScalarPlanNode[] }[] = [];
			for (const colIdx of seekCols) {
				const c = eqBySeekCol.get(colIdx)!;
				if (c.op === 'IN' && Array.isArray(c.value) && (c.value as unknown[]).length > 1) {
					columnValues.push({
						colIdx,
						values: c.value as unknown as SqlValue[],
						exprs: Array.isArray(c.valueExpr) ? c.valueExpr : undefined,
					});
				} else {
					// Single equality value for this column
					const val = c.op === 'IN' && Array.isArray(c.value) ? (c.value as unknown as SqlValue[])[0] : c.value as SqlValue;
					columnValues.push({ colIdx, values: [val] });
				}
			}

			const seekWidth = seekCols.length;

			// A column is pure-literal iff its constraint carries no value expression
			// (a `valueExpr` is present only for dynamic/parameter or mixed bindings).
			// When every component is literal we can reduce the cross-product at plan
			// time; otherwise the runtime scan-layer dedup/NULL-skip is authoritative.
			const allLiteral = seekCols.every(colIdx => eqBySeekCol.get(colIdx)!.valueExpr === undefined);

			if (allLiteral) {
				// Build the cross-product of actual literal tuples, then drop any tuple
				// with a NULL component and collapse duplicates so inCount reflects the
				// effective distinct non-null seek count.
				const valueTuples = cartesianProduct(columnValues.map(cv => cv.values));
				const effectiveTuples = reduceLiteralSeekTuples(valueTuples);
				if (effectiveTuples.length === 0) {
					// Every cross-product tuple is NULL-bearing ⇒ no row can match.
					log('Composite IN cross-product on %s is entirely NULL-bearing — using empty result', physicalIndexName);
					return createEmptyResultNode(tableRef);
				}

				const seekKeys: ScalarPlanNode[] = effectiveTuples.flatMap(tuple =>
					tuple.map(v => literalFromValue(tableRef.scope, v))
				);
				const seekConstraints: { constraint: IndexConstraint; argvIndex: number }[] = seekKeys.map((_sk, i) => ({
					constraint: { iColumn: seekCols[i % seekWidth], op: IndexConstraintOp.EQ, usable: true },
					argvIndex: i + 1,
				}));
				const fi: FilterInfo = {
					...filterInfo,
					constraints: seekConstraints,
					idxStr: `idx=${idxStrName}(0);plan=5;inCount=${effectiveTuples.length};seekWidth=${seekWidth}`,
				};

				log('Using composite index multi-seek on %s (cross-product of %d distinct non-null seeks, width %d)', physicalIndexName, effectiveTuples.length, seekWidth);
				return finishSeek(new IndexSeekNode(
					tableRef.scope,
					tableRef,
					fi,
					physicalIndexName,
					seekKeys,
					false,
					providesOrdering,
					accessPlan.cost,
					advertisement,
				));
			}

			// Dynamic/mixed composite: keep the raw cross-product over value indices and
			// let the runtime perform set-membership at execution time.
			const crossProduct = cartesianProduct(columnValues.map(cv =>
				cv.values.map((_v, i) => i)
			));

			// Build seekKeys — one ScalarPlanNode per value in flattened cross-product
			const seekKeys: ScalarPlanNode[] = crossProduct.flatMap(combo =>
				combo.map((valueIdx, colPos) => {
					const cv = columnValues[colPos];
					if (cv.exprs && cv.exprs[valueIdx]) {
						return cv.exprs[valueIdx];
					}
					return literalFromValue(tableRef.scope, cv.values[valueIdx]);
				})
			);

			// Build seek constraints: one EQ constraint per value in the flattened args
			const seekConstraints: { constraint: IndexConstraint; argvIndex: number }[] = seekKeys.map((_sk, i) => ({
				constraint: { iColumn: seekCols[i % seekWidth], op: IndexConstraintOp.EQ, usable: true },
				argvIndex: i + 1,
			}));

			const fi: FilterInfo = {
				...filterInfo,
				constraints: seekConstraints,
				idxStr: `idx=${idxStrName}(0);plan=5;inCount=${crossProduct.length};seekWidth=${seekWidth}`,
			};

			log('Using composite index multi-seek on %s (cross-product of %d seeks, width %d)', physicalIndexName, crossProduct.length, seekWidth);
			return finishSeek(new IndexSeekNode(
				tableRef.scope,
				tableRef,
				fi,
				physicalIndexName,
				seekKeys,
				false,
				providesOrdering,
				accessPlan.cost,
				advertisement,
			));
		}

		// A literal NULL in any seek column makes the (row-value) equality UNKNOWN ⇒
		// no row can match. Emit an empty result rather than a doomed point-seek so
		// EXPLAIN stays honest (EmptyResult, not a degraded IndexSeek/SeqScan). A
		// dynamic `valueExpr` is left to the scan-layer runtime guard (Part A).
		if ([...eqBySeekCol.values()].some(isLiteralNullEquality)) {
			log('Equality seek on %s has a literal NULL key — using empty result', physicalIndexName);
			return createEmptyResultNode(tableRef);
		}

		// Standard equality seek on all seek columns
		const seekKeys: ScalarPlanNode[] = seekCols.map(colIdx => {
			const c = eqBySeekCol.get(colIdx)!;
			if (c.valueExpr && !Array.isArray(c.valueExpr)) return c.valueExpr;
			const val = c.op === 'IN' && Array.isArray(c.value) ? (c.value as unknown as SqlValue[])[0] : (c.value as SqlValue);
			return literalFromValue(tableRef.scope, val);
		});

		const eqConstraints: { constraint: IndexConstraint; argvIndex: number }[] = seekCols.map((colIdx, i) => ({
			constraint: { iColumn: colIdx, op: IndexConstraintOp.EQ, usable: true },
			argvIndex: i + 1,
		}));
		const fi: FilterInfo = {
			...filterInfo,
			constraints: eqConstraints,
			idxStr: `idx=${idxStrName}(0);plan=2`,
		};

		log('Using index seek on %s (equality)', physicalIndexName);
		return finishSeek(new IndexSeekNode(
			tableRef.scope,
			tableRef,
			fi,
			physicalIndexName,
			seekKeys,
			false,
			providesOrdering,
			accessPlan.cost,
			advertisement,
		));
	}

	// Check for prefix-equality + trailing-range pattern
	if (!allEquality && seekCols.length > 1) {
		const prefixEqCols: number[] = [];
		let trailingRangeCol: number | undefined;
		for (const colIdx of seekCols) {
			const colConstraints = constraintsByCol.get(colIdx) ?? [];
			const eqConstraint = colConstraints.find(c =>
				(c.op === '=' || (c.op === 'IN' && Array.isArray(c.value) && (c.value as unknown[]).length === 1)) &&
				handledByCol.has(c.columnIndex));
			if (eqConstraint) {
				prefixEqCols.push(colIdx);
			} else {
				const hasRange = colConstraints.some(c =>
					['>', '>=', '<', '<='].includes(c.op) && handledByCol.has(c.columnIndex));
				if (hasRange) trailingRangeCol = colIdx;
				break;
			}
		}

		if (prefixEqCols.length > 0 && trailingRangeCol !== undefined) {
			// A literal NULL in any prefix-equality column makes every row-value
			// comparison UNKNOWN ⇒ no match. Emit an empty result rather than relying
			// on the runtime prefix walk breaking on the first row. Part A does not
			// cover this path (it walks via `equalityPrefix`, not `equalityKey`), so
			// the plan-time check is the robustness guarantee here.
			const prefixHasLiteralNull = prefixEqCols.some(colIdx => {
				const c = (constraintsByCol.get(colIdx) ?? []).find(c =>
					(c.op === '=' || (c.op === 'IN' && Array.isArray(c.value) && (c.value as unknown[]).length === 1)) &&
					handledByCol.has(c.columnIndex));
				return c !== undefined && isLiteralNullEquality(c);
			});
			if (prefixHasLiteralNull) {
				log('Prefix-range seek on %s has a literal NULL prefix key — using empty result', physicalIndexName);
				return createEmptyResultNode(tableRef);
			}

			// Collation-cover: any collation mismatch on a prefix-range seek reorders
			// the walked index window (it is no longer a contiguous superset), so it
			// cannot be salvaged with a residual — decline to a scan + residual.
			{
				const consumed: ConsumedConstraint[] = [];
				for (const colIdx of prefixEqCols) {
					const c = (constraintsByCol.get(colIdx) ?? []).find(c =>
						(c.op === '=' || (c.op === 'IN' && Array.isArray(c.value) && (c.value as unknown[]).length === 1)) &&
						handledByCol.has(c.columnIndex))!;
					consumed.push({ colIdx, constraint: c });
				}
				const trailing = constraintsByCol.get(trailingRangeCol) ?? [];
				const lo = trailing.find(c => (c.op === '>' || c.op === '>=') && handledByCol.has(c.columnIndex));
				const hi = trailing.find(c => (c.op === '<' || c.op === '<=') && handledByCol.has(c.columnIndex));
				if (lo) consumed.push({ colIdx: trailingRangeCol, constraint: lo });
				if (hi) consumed.push({ colIdx: trailingRangeCol, constraint: hi });
				const cover = classifyCollationCover(consumed, false, indexColumnCollationLookup(tableRef.tableSchema, accessPlan));
				if (!cover.useIndex) {
					log('Declining prefix-range seek on %s (collation mismatch) — sequential scan + residual', physicalIndexName);
					const scan = createSeqScan(tableRef);
					return cover.residual ? new FilterNode(tableRef.scope, scan, cover.residual) : scan;
				}
			}

			const seekKeys: ScalarPlanNode[] = [];
			const allConstraints: { constraint: IndexConstraint; argvIndex: number }[] = [];
			let argv = 1;

			// Add prefix equality values
			for (const colIdx of prefixEqCols) {
				const c = (constraintsByCol.get(colIdx) ?? []).find(c =>
					(c.op === '=' || (c.op === 'IN' && Array.isArray(c.value) && (c.value as unknown[]).length === 1)) &&
					handledByCol.has(c.columnIndex))!;
				const val = c.op === 'IN' && Array.isArray(c.value) ? (c.value as unknown as SqlValue[])[0] : (c.value as SqlValue);
				seekKeys.push(c.valueExpr && !Array.isArray(c.valueExpr)
					? c.valueExpr
					: literalFromValue(tableRef.scope, val));
				allConstraints.push({ constraint: { iColumn: colIdx, op: IndexConstraintOp.EQ, usable: true }, argvIndex: argv });
				argv++;
			}

			// Add trailing range values
			const trailingConstraints = constraintsByCol.get(trailingRangeCol) ?? [];
			const lower = trailingConstraints.find(c => (c.op === '>' || c.op === '>=') && handledByCol.has(c.columnIndex));
			const upper = trailingConstraints.find(c => (c.op === '<' || c.op === '<=') && handledByCol.has(c.columnIndex));

			if (lower) {
				allConstraints.push({ constraint: { iColumn: trailingRangeCol, op: opToIndexOp(lower.op as RangeOp), usable: true }, argvIndex: argv });
				seekKeys.push(lower.valueExpr && !Array.isArray(lower.valueExpr) ? lower.valueExpr : literalFromValue(tableRef.scope, lower.value as SqlValue));
				argv++;
			}
			if (upper) {
				allConstraints.push({ constraint: { iColumn: trailingRangeCol, op: opToIndexOp(upper.op as RangeOp), usable: true }, argvIndex: argv });
				seekKeys.push(upper.valueExpr && !Array.isArray(upper.valueExpr) ? upper.valueExpr : literalFromValue(tableRef.scope, upper.value as SqlValue));
				argv++;
			}

			const fi: FilterInfo = {
				...filterInfo,
				constraints: allConstraints,
				idxStr: `idx=${idxStrName}(0);plan=7;prefixLen=${prefixEqCols.length}`,
			};

			log('Using index prefix-range seek on %s (prefix=%d cols)', physicalIndexName, prefixEqCols.length);
			return new IndexSeekNode(
				tableRef.scope,
				tableRef,
				fi,
				physicalIndexName,
				seekKeys,
				true,
				providesOrdering,
				accessPlan.cost,
				advertisement,
			);
		}
	}

	// Check for range constraints on the seek columns
	// Use the first (or only) seek column that has range constraints
	const rangeCol = seekCols.find(colIdx => {
		const colConstraints = constraintsByCol.get(colIdx) ?? [];
		return colConstraints.some(c => ['>', '>=', '<', '<='].includes(c.op) && handledByCol.has(c.columnIndex));
	});

	if (rangeCol !== undefined) {
		const colConstraints = constraintsByCol.get(rangeCol) ?? [];
		const lower = colConstraints.find(c => (c.op === '>' || c.op === '>=') && handledByCol.has(c.columnIndex));
		const upper = colConstraints.find(c => (c.op === '<' || c.op === '<=') && handledByCol.has(c.columnIndex));

		// Collation-cover: a range seek under a collation that differs from the
		// predicate's reorders the index window, so it is never a superset — decline
		// to a scan + residual on any mismatch.
		{
			const consumed: ConsumedConstraint[] = [];
			if (lower) consumed.push({ colIdx: rangeCol, constraint: lower });
			if (upper) consumed.push({ colIdx: rangeCol, constraint: upper });
			const cover = classifyCollationCover(consumed, false, indexColumnCollationLookup(tableRef.tableSchema, accessPlan));
			if (!cover.useIndex) {
				log('Declining range seek on %s (collation mismatch) — sequential scan + residual', physicalIndexName);
				const scan = createSeqScan(tableRef);
				return cover.residual ? new FilterNode(tableRef.scope, scan, cover.residual) : scan;
			}
		}

		const seekKeys: ScalarPlanNode[] = [];
		const rangeConstraints: { constraint: IndexConstraint; argvIndex: number }[] = [];

		let argv = 1;
		if (lower) {
			rangeConstraints.push({ constraint: { iColumn: rangeCol, op: opToIndexOp(lower.op as RangeOp), usable: true }, argvIndex: argv });
			seekKeys.push(lower.valueExpr && !Array.isArray(lower.valueExpr) ? lower.valueExpr : literalFromValue(tableRef.scope, lower.value as SqlValue));
			argv++;
		}
		if (upper) {
			rangeConstraints.push({ constraint: { iColumn: rangeCol, op: opToIndexOp(upper.op as RangeOp), usable: true }, argvIndex: argv });
			seekKeys.push(upper.valueExpr && !Array.isArray(upper.valueExpr) ? upper.valueExpr : literalFromValue(tableRef.scope, upper.value as SqlValue));
			argv++;
		}

		const fi: FilterInfo = {
			...filterInfo,
			constraints: rangeConstraints,
			idxStr: `idx=${idxStrName}(0);plan=3`,
		};

		log('Using index seek (range) on %s', physicalIndexName);
		return new IndexSeekNode(
			tableRef.scope,
			tableRef,
			fi,
			physicalIndexName,
			seekKeys,
			true,
			providesOrdering,
			accessPlan.cost,
			advertisement,
		);
	}

	// Check for OR_RANGE constraint on a seek column
	const orRangeConstraint = constraints.find(c =>
		c.op === 'OR_RANGE' && c.ranges && c.ranges.length > 0 &&
		seekCols.includes(c.columnIndex) && handledByCol.has(c.columnIndex)
	);

	if (orRangeConstraint && orRangeConstraint.ranges) {
		const ranges = orRangeConstraint.ranges as RangeSpec[];

		// Collation-cover: an OR_RANGE seek walks multiple index windows whose order
		// follows the index collation; any mismatch makes them non-supersets, so
		// decline to a scan + residual.
		{
			const cover = classifyCollationCover(
				[{ colIdx: orRangeConstraint.columnIndex, constraint: orRangeConstraint }],
				false,
				indexColumnCollationLookup(tableRef.tableSchema, accessPlan),
			);
			if (!cover.useIndex) {
				log('Declining OR_RANGE seek on %s (collation mismatch) — sequential scan + residual', physicalIndexName);
				const scan = createSeqScan(tableRef);
				return cover.residual ? new FilterNode(tableRef.scope, scan, cover.residual) : scan;
			}
		}

		// Build seekKeys: for each range, emit lower value then upper value
		// Encode which ops each range has in rangeOps string
		const seekKeys: ScalarPlanNode[] = [];
		const rangeOps: string[] = [];

		for (const range of ranges) {
			const parts: string[] = [];
			if (range.lower) {
				const opStr = range.lower.op === '>=' ? 'ge' : 'gt';
				parts.push(opStr);
				seekKeys.push(range.lower.valueExpr
					?? literalFromValue(tableRef.scope, range.lower.value));
			}
			if (range.upper) {
				const opStr = range.upper.op === '<=' ? 'le' : 'lt';
				parts.push(opStr);
				seekKeys.push(range.upper.valueExpr
					?? literalFromValue(tableRef.scope, range.upper.value));
			}
			rangeOps.push(parts.join(':'));
		}

		const orRangeConstraints: { constraint: IndexConstraint; argvIndex: number }[] = seekKeys.map((_sk, i) => ({
			constraint: { iColumn: orRangeConstraint.columnIndex, op: IndexConstraintOp.GE, usable: true },
			argvIndex: i + 1,
		}));

		const fi: FilterInfo = {
			...filterInfo,
			constraints: orRangeConstraints,
			idxStr: `idx=${idxStrName}(0);plan=6;rangeCount=${ranges.length};rangeOps=${rangeOps.join(',')}`,
		};

		log('Using index multi-range seek on %s (%d ranges)', physicalIndexName, ranges.length);
		return new IndexSeekNode(
			tableRef.scope,
			tableRef,
			fi,
			physicalIndexName,
			seekKeys,
			true,
			providesOrdering,
			accessPlan.cost,
			advertisement,
		);
	}

	// Ordering-only index scan
	if (providesOrdering) {
		const orderingIndexName = accessPlan.orderingIndexName ?? physicalIndexName;
		const orderingIdxStr = orderingIndexName === 'primary' ? '_primary_' : orderingIndexName;
		log('Using index scan (ordering provided by %s)', orderingIndexName);

		const orderingFilterInfo: FilterInfo = {
			...filterInfo,
			idxStr: `idx=${orderingIdxStr}(0);plan=0`,
			indexInfoOutput: {
				...filterInfo.indexInfoOutput,
				idxStr: `idx=${orderingIdxStr}(0);plan=0`,
				orderByConsumed: true,
			}
		};

		return new IndexScanNode(
			tableRef.scope,
			tableRef,
			orderingFilterInfo,
			orderingIndexName,
			providesOrdering,
			accessPlan.cost,
			advertisement,
		);
	}

	// Fall back to sequential scan
	log('Using sequential scan (index %s: no usable seek/range constraints)', physicalIndexName);
	return createSeqScan(tableRef, filterInfo, accessPlan.cost);
}

/**
 * Legacy physical node selection for backward compatibility when module
 * doesn't provide indexName/seekColumnIndexes (PK-based heuristics).
 */
function selectPhysicalNodeLegacy(
	tableRef: TableReferenceNode,
	accessPlan: BestAccessPlanResult,
	constraints: PlannerPredicateConstraint[],
	filterInfo: FilterInfo,
	providesOrdering: { column: number; desc: boolean }[] | undefined
): RelationalPlanNode {
	const advertisement = extractAdvertisement(accessPlan);
	// Analyze the access plan to determine node type
	const handledByCol = new Set<number>();
	constraints.forEach((c, i) => {
		if (accessPlan.handledFilters[i] === true) handledByCol.add(c.columnIndex);
	});
	const eqHandled = constraints.filter(c => c.op === '=');
	const hasEqualityConstraints = eqHandled.length > 0;
	const hasRangeConstraints = constraints.some(c => ['>', '>=', '<', '<='].includes(c.op) && handledByCol.has(c.columnIndex));

	const maybeRows = accessPlan.rows || 0;
	const pkCols = tableRef.tableSchema.primaryKeyDefinition ?? [];
	const eqByCol = new Map<number, PlannerPredicateConstraint>();
	for (const c of eqHandled) eqByCol.set(c.columnIndex, c);
	const coversPk = pkCols.length > 0 && pkCols.every(pk => eqByCol.has(pk.index));
	const treatAsHandledPk = coversPk && pkCols.every(pk => handledByCol.has(pk.index) || eqByCol.has(pk.index));

	if ((hasEqualityConstraints && coversPk || treatAsHandledPk) && maybeRows <= 10) {
		// A literal NULL in any PK column makes the point-seek UNKNOWN ⇒ no row can
		// match. Emit an empty result instead of a doomed seek (mirrors the
		// index-aware path; the scan-layer runtime guard covers the dynamic case).
		if (pkCols.some(pk => {
			const c = eqByCol.get(pk.index);
			return c !== undefined && isLiteralNullEquality(c);
		})) {
			log('PK equality seek has a literal NULL key — using empty result (legacy)');
			return createEmptyResultNode(tableRef);
		}

		// Collation-cover: a PK seek whose column collation differs from the
		// predicate's effective collation over/under-fetches. Keep the seek + residual
		// for a coarser PK collation; decline to a scan + residual otherwise.
		const cover = classifyCollationCover(
			pkCols.map(pk => ({ colIdx: pk.index, constraint: eqByCol.get(pk.index)! })),
			true,
			primaryKeyCollationLookup(tableRef.tableSchema),
		);
		if (!cover.useIndex) {
			log('Declining PK index seek (collation mismatch) — sequential scan + residual (legacy)');
			const scan = createSeqScan(tableRef);
			return cover.residual ? new FilterNode(tableRef.scope, scan, cover.residual) : scan;
		}

		const seekKeys: ScalarPlanNode[] = pkCols.map(pk => {
			const c = eqByCol.get(pk.index)!;
			if (c.valueExpr && !Array.isArray(c.valueExpr)) return c.valueExpr;
			return literalFromValue(tableRef.scope, c.value as SqlValue);
		});

		const eqConstraints: { constraint: IndexConstraint; argvIndex: number }[] = pkCols.map((pk, i) => ({
			constraint: { iColumn: pk.index, op: IndexConstraintOp.EQ, usable: true },
			argvIndex: i + 1,
		}));
		const fi: FilterInfo = {
			...filterInfo,
			constraints: eqConstraints,
			idxStr: 'idx=_primary_(0);plan=2',
		};

		log('Using index seek on primary key (legacy)');
		const pkSeek = new IndexSeekNode(
			tableRef.scope,
			tableRef,
			fi,
			'primary',
			seekKeys,
			false,
			providesOrdering,
			accessPlan.cost,
			advertisement,
		);
		return cover.residual ? new FilterNode(tableRef.scope, pkSeek, cover.residual) : pkSeek;
	}

	if (hasRangeConstraints) {
		const rangeCols = constraints
			.filter(c => ['>', '>=', '<', '<='].includes(c.op) && handledByCol.has(c.columnIndex))
			.sort((a, b) => a.columnIndex - b.columnIndex);

		const primaryFirstCol = (tableRef.tableSchema.primaryKeyDefinition?.[0]?.index) ?? (rangeCols[0]?.columnIndex ?? 0);
		const lower = rangeCols.find(c => c.columnIndex === primaryFirstCol && (c.op === '>' || c.op === '>='));
		const upper = rangeCols.find(c => c.columnIndex === primaryFirstCol && (c.op === '<' || c.op === '<='));

		// Collation-cover: a PK range seek under a mismatched collation reorders the
		// walked window, so decline to a scan + residual on any mismatch.
		{
			const consumed: ConsumedConstraint[] = [];
			if (lower) consumed.push({ colIdx: primaryFirstCol, constraint: lower });
			if (upper) consumed.push({ colIdx: primaryFirstCol, constraint: upper });
			const cover = classifyCollationCover(consumed, false, primaryKeyCollationLookup(tableRef.tableSchema));
			if (!cover.useIndex) {
				log('Declining PK range seek (collation mismatch) — sequential scan + residual (legacy)');
				const scan = createSeqScan(tableRef);
				return cover.residual ? new FilterNode(tableRef.scope, scan, cover.residual) : scan;
			}
		}

		const seekKeys: ScalarPlanNode[] = [];
		const rangeConstraints: { constraint: IndexConstraint; argvIndex: number }[] = [];

		let argv = 1;
		if (lower) {
			rangeConstraints.push({ constraint: { iColumn: primaryFirstCol, op: opToIndexOp(lower.op as RangeOp), usable: true }, argvIndex: argv });
			seekKeys.push(lower.valueExpr && !Array.isArray(lower.valueExpr) ? lower.valueExpr : literalFromValue(tableRef.scope, lower.value as SqlValue));
			argv++;
		}
		if (upper) {
			rangeConstraints.push({ constraint: { iColumn: primaryFirstCol, op: opToIndexOp(upper.op as RangeOp), usable: true }, argvIndex: argv });
			seekKeys.push(upper.valueExpr && !Array.isArray(upper.valueExpr) ? upper.valueExpr : literalFromValue(tableRef.scope, upper.value as SqlValue));
			argv++;
		}

		const fi: FilterInfo = {
			...filterInfo,
			constraints: rangeConstraints,
			idxStr: 'idx=_primary_(0);plan=3',
		};

		log('Using index seek (range) on primary key (legacy)');
		return new IndexSeekNode(
			tableRef.scope,
			tableRef,
			fi,
			'primary',
			seekKeys,
			true,
			providesOrdering,
			accessPlan.cost,
			advertisement,
		);
	}

	if (providesOrdering) {
		const indexName = accessPlan.orderingIndexName ?? 'primary';
		log('Using index scan (ordering provided by %s)', indexName);

		const indexIdxStr = indexName === 'primary' ? '_primary_' : indexName;
		const orderingFilterInfo: FilterInfo = {
			...filterInfo,
			idxStr: `idx=${indexIdxStr}(0);plan=0`,
			indexInfoOutput: {
				...filterInfo.indexInfoOutput,
				idxStr: `idx=${indexIdxStr}(0);plan=0`,
				orderByConsumed: true,
			}
		};

		return new IndexScanNode(
			tableRef.scope,
			tableRef,
			orderingFilterInfo,
			indexName,
			providesOrdering,
			accessPlan.cost,
			advertisement,
		);
	}

	log('Using sequential scan (no beneficial index access)');
	return createSeqScan(tableRef, filterInfo, accessPlan.cost);
}

// Narrow module context originating from grow-retrieve index-style fallback
function isIndexStyleContext(ctx: unknown): ctx is { kind: 'index-style'; accessPlan: BestAccessPlanResult; residualPredicate?: ScalarPlanNode; originalConstraints: unknown[] } {
	return !!ctx && typeof ctx === 'object' && (ctx as { kind?: string }).kind === 'index-style';
}

/**
 * Create a sequential scan node
 */
function createSeqScan(tableRef: TableReferenceNode, filterInfo?: FilterInfo, cost?: number): SeqScanNode {
	const tableRows = tableRef.estimatedRows || 1000;
	const scanCost = cost ?? seqScanCost(tableRows);

	// Create default FilterInfo if not provided
	const effectiveFilterInfo = filterInfo || {
		idxNum: 0,
		idxStr: 'fullscan',
		constraints: [],
		args: [],
		indexInfoOutput: {
			nConstraint: 0,
			aConstraint: [],
			nOrderBy: 0,
			aOrderBy: [],
			aConstraintUsage: [] as IndexConstraintUsage[],
			idxNum: 0,
			idxStr: 'fullscan',
			orderByConsumed: false,
			estimatedCost: scanCost,
			estimatedRows: BigInt(tableRows),
			idxFlags: 0,
			colUsed: 0n,
		}
	};

	const seqScan = new SeqScanNode(
		tableRef.scope,
		tableRef,
		effectiveFilterInfo,
		scanCost
	);

	return seqScan;
}

/** Compute the cartesian product of an array of arrays */
function cartesianProduct<T>(arrays: T[][]): T[][] {
	return arrays.reduce<T[][]>(
		(acc, arr) => acc.flatMap(combo => arr.map(v => [...combo, v])),
		[[]],
	);
}

type RangeOp = '>' | '>=' | '<' | '<=';

function opToIndexOp(op: RangeOp): IndexConstraintOp {
	switch (op) {
		case '>': return IndexConstraintOp.GT;
		case '>=': return IndexConstraintOp.GE;
		case '<': return IndexConstraintOp.LT;
		case '<=': return IndexConstraintOp.LE;
	}
}

function literalFromValue(scope: Scope, value: SqlValue): LiteralNode {
	const lit: AST.LiteralExpr = { type: 'literal', value };
	return new LiteralNode(scope, lit);
}

/**
 * Build the canonical empty-relation leaf used when a predicate is provably
 * unsatisfiable (e.g. an IN-list whose literals are all NULL — every seek key
 * is skipped at runtime). Shared by the impossible-predicate optimization and
 * the literal-IN reduction below.
 */
function createEmptyResultNode(tableRef: TableReferenceNode): EmptyResultNode {
	const emptyFilterInfo: FilterInfo = {
		idxNum: 0,
		idxStr: 'empty',
		constraints: [],
		args: [],
		indexInfoOutput: {
			nConstraint: 0,
			aConstraint: [],
			nOrderBy: 0,
			aOrderBy: [],
			aConstraintUsage: [] as IndexConstraintUsage[],
			idxNum: 0,
			idxStr: 'empty',
			orderByConsumed: false,
			estimatedCost: 0,
			estimatedRows: 0n,
			idxFlags: 0,
			colUsed: 0n,
		}
	};
	return new EmptyResultNode(tableRef.scope, tableRef, emptyFilterInfo, 0);
}

/**
 * True when an equality constraint resolves to a *literal* SQL NULL — `col = null`
 * or single-value `col IN (null)` carrying no dynamic value expression. SQL NULL
 * equality is UNKNOWN under three-valued logic, so such a point-seek matches no
 * row; the planner emits an {@link createEmptyResultNode} instead of a doomed
 * point-seek (mirrors the all-NULL IN-list reduction in {@link reduceLiteralSeekValues}).
 *
 * A dynamic single `valueExpr` (parameter/correlated binding) is deliberately NOT
 * treated as literal: its NULL-ness is unknown at plan time and is handled by the
 * scan-layer runtime guard (`seekKeyHasNull`) instead. This mirrors the
 * literal-vs-dynamic discrimination used where `seekKeys` are materialized
 * (`c.valueExpr && !Array.isArray(c.valueExpr)` ⇒ dynamic). A dynamic single-value
 * `IN (?)` carries an *array* `valueExpr` and an `undefined` placeholder value, so
 * the effective-value check below also rejects it.
 */
function isLiteralNullEquality(c: PlannerPredicateConstraint): boolean {
	if (c.valueExpr && !Array.isArray(c.valueExpr)) return false;
	const val = c.op === 'IN' && Array.isArray(c.value)
		? (c.value as unknown as SqlValue[])[0]
		: (c.value as SqlValue);
	return val === null;
}

/**
 * Reduce a list of *literal* IN seek values to the effective distinct, non-null
 * set, so the multi-seek's advertised `inCount` matches the number of seeks the
 * runtime actually performs. Mirrors the runtime set-membership semantics in
 * `scan-layer.ts`: a NULL seek key contributes no match (skipped), and duplicate
 * seek keys collapse.
 *
 * This is a strict *subset* of the runtime dedup — it only collapses values that
 * are equal under the default binary comparator, since the column's collation is
 * unknown at plan time. The runtime remains the authority and may collapse
 * further (e.g. NOCASE case-variants that hit the same index entry). Literal-only:
 * dynamic/parameter seek values are never reduced here.
 */
function reduceLiteralSeekValues(values: readonly SqlValue[]): SqlValue[] {
	const result: SqlValue[] = [];
	for (const v of values) {
		if (v === null) continue;
		if (result.some(kept => compareSqlValues(kept, v) === 0)) continue;
		result.push(v);
	}
	return result;
}

/**
 * Composite analogue of {@link reduceLiteralSeekValues}: drop any cross-product
 * tuple with a NULL component (mirrors `scan-layer.ts`'s `seekKeyHasNull` for
 * row-value seeks — a NULL component makes the comparison NULL ⇒ no match) and
 * collapse duplicate tuples. Tuples are compared componentwise under the default
 * binary comparator; literal-only, same subset rationale as the scalar case.
 */
function reduceLiteralSeekTuples(tuples: readonly SqlValue[][]): SqlValue[][] {
	const result: SqlValue[][] = [];
	for (const tuple of tuples) {
		if (tuple.some(v => v === null)) continue;
		const isDup = result.some(kept =>
			kept.length === tuple.length && kept.every((kv, i) => compareSqlValues(kv, tuple[i]) === 0)
		);
		if (isDup) continue;
		result.push(tuple);
	}
	return result;
}

// ---------------------------------------------------------------------------
// Collation-cover analysis
//
// An IndexSeek over a secondary index (or PK) whose per-column collation differs
// from a predicate's effective comparison collation is NOT a complete substitute
// for that predicate. A NOCASE index seek for a BINARY `name = 'BOB'`, for
// instance, returns every NOCASE-equal entry (`'BOB'` AND `'Bob'`) — so the
// access path must either keep the seek and re-apply the predicate as a residual
// (when the index over-fetches a provable superset) or decline the seek and fall
// back to a scan + residual (when the index under-fetches or a range mismatch
// reorders the walked window). See `index-collation-mismatch-residual-filter`.
// ---------------------------------------------------------------------------

/**
 * Per-seek-constraint classification of how an index column's collation relates
 * to the predicate's effective comparison collation. See {@link classifyConstraintCover}.
 *
 * - `MATCH`           — collations equal; the seek fully satisfies the predicate.
 * - `COARSER_SAFE`    — equality op whose index collation is a provable superset of
 *                       the predicate's (BINARY predicate over a non-BINARY index):
 *                       the seek over-fetches a superset, so a residual recovers the
 *                       exact matches.
 * - `MISMATCH_UNSAFE` — anything else (a finer index that under-fetches, or any
 *                       range/prefix mismatch that reorders the walked window): the
 *                       seek cannot be made correct with a residual.
 */
type CollationCover = 'MATCH' | 'COARSER_SAFE' | 'MISMATCH_UNSAFE';

/** A constraint consumed by a seek, paired with the table column index it seeks. */
interface ConsumedConstraint {
	colIdx: number;
	constraint: PlannerPredicateConstraint;
}

/** Aggregate cover decision for a seek's consumed constraints. */
interface CollationCoverDecision {
	/** Whether the index seek may still be used (true) or must fall back to a scan (false). */
	useIndex: boolean;
	/** Residual predicate to re-apply above the leaf, or undefined when none is needed. */
	residual?: ScalarPlanNode;
}

/**
 * Resolve a predicate constraint's effective comparison collation at plan time,
 * mirroring the runtime resolution in `emitComparisonOp` (binary.ts) and `emitIn`
 * (subquery.ts): a comparison takes the right operand's collation, else the left's,
 * else BINARY; an IN takes the condition (LHS) operand's collation; a BETWEEN takes
 * the tested expression's collation. The result is normalized.
 */
function effectivePredicateCollation(constraint: PlannerPredicateConstraint): string {
	const src = constraint.sourceExpression;
	if (src instanceof BinaryOpNode) {
		return normalizeCollationName(src.right.getType().collationName ?? src.left.getType().collationName ?? 'BINARY');
	}
	if (src instanceof InNode) {
		return normalizeCollationName(src.condition.getType().collationName ?? 'BINARY');
	}
	if (src instanceof BetweenNode) {
		// BETWEEN is `expr >= lo AND expr <= hi`; each comparison resolves to the
		// tested-expression (LHS) collation. A `COLLATE` on a *bound* is dropped
		// during constant folding / constraint extraction (the bound is reduced to a
		// bare literal before this rule runs — see the `collate-on-between-bound`
		// folding bug), so only the expr collation can ever reach this point.
		return normalizeCollationName(src.expr.getType().collationName ?? 'BINARY');
	}
	// OR_RANGE carries an OR BinaryOpNode source (handled above); any other shape
	// defaults to BINARY, which only ever drives a (safe) decline on mismatch.
	return 'BINARY';
}

/**
 * Build a collation lookup for the columns of a module-provided index. Secondary
 * index columns carry their own (already-normalized) collation; the primary key
 * (`_primary_`/`primary`) falls back to the table column's declared collation.
 */
function indexColumnCollationLookup(
	tableSchema: TableSchema,
	accessPlan: BestAccessPlanResult
): (colIdx: number) => string {
	const indexName = accessPlan.indexName;
	const isPrimary = indexName === '_primary_' || indexName === 'primary';
	const index = isPrimary ? undefined : tableSchema.indexes?.find(i => i.name === indexName);
	return (colIdx: number): string => {
		if (isPrimary) {
			return normalizeCollationName(tableSchema.columns[colIdx]?.collation ?? 'BINARY');
		}
		const idxCol = index?.columns.find(c => c.index === colIdx);
		return normalizeCollationName(idxCol?.collation ?? 'BINARY');
	};
}

/**
 * Build a collation lookup for primary-key columns (used by the legacy seek path,
 * which addresses the PK directly without a module-provided index identity).
 */
function primaryKeyCollationLookup(tableSchema: TableSchema): (colIdx: number) => string {
	return (colIdx: number): string =>
		normalizeCollationName(tableSchema.columns[colIdx]?.collation ?? 'BINARY');
}

/** Cover relation for a single seek column. See {@link CollationCover}. */
function classifyConstraintCover(predColl: string, indexColl: string, isEquality: boolean): CollationCover {
	if (predColl === indexColl) return 'MATCH';
	// BINARY equality ⟹ equal under any collation, so a non-BINARY index over-fetches
	// a superset that an equality residual can recover. NOCASE/RTRIM are mutually
	// incomparable and a finer index under-fetches — neither is salvageable.
	if (isEquality && predColl === 'BINARY' && indexColl !== 'BINARY') {
		return 'COARSER_SAFE';
	}
	return 'MISMATCH_UNSAFE';
}

/**
 * Classify a seek's consumed constraints by the collation-cover relation and derive
 * an aggregate decision:
 *  - any `MISMATCH_UNSAFE` → decline the seek; the caller scans and re-applies the
 *    AND of *all* consumed constraints as a residual (so the scan stays filtered).
 *  - else all `MATCH` → use the seek with no residual.
 *  - else (some `COARSER_SAFE`) → use the seek but re-apply the AND of the
 *    `COARSER_SAFE` constraints as a residual to discard the over-fetched rows.
 *
 * `isEquality` gates the `COARSER_SAFE` class: a coarser index can only over-fetch a
 * *superset* for an equality/IN seek. For a range/prefix-range/OR_RANGE seek a
 * collation mismatch reorders the index, so the walked window is not a superset and
 * any mismatch is `MISMATCH_UNSAFE`.
 */
function classifyCollationCover(
	consumed: ConsumedConstraint[],
	isEquality: boolean,
	collationForColumn: (colIdx: number) => string
): CollationCoverDecision {
	const allResiduals: ScalarPlanNode[] = [];
	const coarserResiduals: ScalarPlanNode[] = [];
	let anyUnsafe = false;

	for (const { colIdx, constraint } of consumed) {
		allResiduals.push(constraint.sourceExpression);
		const predColl = effectivePredicateCollation(constraint);
		const indexColl = collationForColumn(colIdx);
		const cover = classifyConstraintCover(predColl, indexColl, isEquality);
		if (cover === 'COARSER_SAFE') {
			coarserResiduals.push(constraint.sourceExpression);
		} else if (cover === 'MISMATCH_UNSAFE') {
			anyUnsafe = true;
		}
	}

	if (anyUnsafe) {
		return { useIndex: false, residual: combineResidualExpressions(allResiduals) };
	}
	if (coarserResiduals.length > 0) {
		return { useIndex: true, residual: combineResidualExpressions(coarserResiduals) };
	}
	return { useIndex: true };
}

/**
 * AND-combine residual `sourceExpression`s into one predicate, de-duplicating by
 * identity (a BETWEEN yields two constraints sharing one source node). Mirrors the
 * `combineParts`/`combineResiduals` shape in constraint-extractor.ts.
 */
function combineResidualExpressions(exprs: ScalarPlanNode[]): ScalarPlanNode | undefined {
	const unique: ScalarPlanNode[] = [];
	for (const e of exprs) {
		if (!unique.includes(e)) unique.push(e);
	}
	if (unique.length === 0) return undefined;
	let acc = unique[0];
	for (let i = 1; i < unique.length; i++) {
		const right = unique[i];
		const ast: AST.BinaryExpr = { type: 'binary', operator: 'AND', left: acc.expression, right: right.expression };
		acc = new BinaryOpNode(acc.scope, ast, acc, right);
	}
	return acc;
}
