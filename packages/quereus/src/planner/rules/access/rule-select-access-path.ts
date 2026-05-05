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
import { SeqScanNode, IndexScanNode, IndexSeekNode, EmptyResultNode } from '../../nodes/table-access-nodes.js';
import { seqScanCost } from '../../cost/index.js';
import type { ColumnMeta, BestAccessPlanRequest, BestAccessPlanResult } from '../../../vtab/best-access-plan.js';
import { FilterInfo } from '../../../vtab/filter-info.js';
import type { IndexConstraint, IndexConstraintUsage } from '../../../vtab/index-info.js';
import type { SqlValue } from '../../../common/types.js';
import type { Scope } from '../../scopes/scope.js';
import { TableReferenceNode } from '../../nodes/reference.js';
import { FilterNode } from '../../nodes/filter.js';
import { extractConstraintsForTable, type PredicateConstraint as PlannerPredicateConstraint, type RangeSpec, createTableInfoFromNode } from '../../analysis/constraint-extractor.js';
import { LiteralNode } from '../../nodes/scalar.js';
import type * as AST from '../../../parser/ast.js';
import { IndexConstraintOp } from '../../../common/constants.js';

const log = createLogger('optimizer:rule:select-access-path');

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
		const physicalLeaf: RelationalPlanNode = selectPhysicalNode(retrieveNode.tableRef, accessPlan, originalConstraints) as unknown as RelationalPlanNode;
		if (retrieveNode.moduleCtx.residualPredicate) {
			return new FilterNode(retrieveNode.scope, physicalLeaf, retrieveNode.moduleCtx.residualPredicate);
		}
		return physicalLeaf;
	}

	// Check if module supports query-based execution via supports() method
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
		} else {
			log('Pipeline not supported by module - falling back to sequential scan');
			return createSeqScan(retrieveNode.tableRef);
		}
	}

	// Check if module supports index-based execution via getBestAccessPlan() method
	if (vtabModule.getBestAccessPlan && typeof vtabModule.getBestAccessPlan === 'function') {
		log('Module has getBestAccessPlan() method - using index-based execution for %s', tableSchema.name);

		return createIndexBasedAccess(retrieveNode, context);
	}

	// Fall back to sequential scan if module has no access planning support
	log('No access planning support, using sequential scan for %s', tableSchema.name);
	return createSeqScan(retrieveNode.tableRef);
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
	const physicalLeaf: RelationalPlanNode = selectPhysicalNode(retrieveNode.tableRef, accessPlan, constraints) as unknown as RelationalPlanNode;

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
): SeqScanNode | IndexScanNode | IndexSeekNode | EmptyResultNode {

	// Empty result optimization (e.g., IS NULL on NOT NULL column)
	if (accessPlan.rows === 0 && accessPlan.handledFilters.every(h => h)) {
		log('Using empty result (impossible predicate detected)');
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
): SeqScanNode | IndexScanNode | IndexSeekNode {
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
		// Check for multi-value IN on a single-column seek (simple case)
		const hasMultiValueIn = [...eqBySeekCol.values()].some(c =>
			c.op === 'IN' && Array.isArray(c.value) && (c.value as unknown[]).length > 1
		);

		if (hasMultiValueIn && seekCols.length === 1) {
			// Multi-seek: IN on single-column index
			const colIdx = seekCols[0];
			const inConstraint = eqBySeekCol.get(colIdx)!;
			const inValues = inConstraint.value as unknown as SqlValue[];

			// Use valueExpr nodes when available (mixed-binding IN from OR collapse),
			// otherwise construct literal nodes from values
			const seekKeys: ScalarPlanNode[] = Array.isArray(inConstraint.valueExpr)
				? inConstraint.valueExpr
				: inValues.map(v => literalFromValue(tableRef.scope, v));

			const inConstraints: { constraint: IndexConstraint; argvIndex: number }[] = inValues.map((_v, i) => ({
				constraint: { iColumn: colIdx, op: IndexConstraintOp.EQ, usable: true },
				argvIndex: i + 1,
			}));
			const fi: FilterInfo = {
				...filterInfo,
				constraints: inConstraints,
				idxStr: `idx=${idxStrName}(0);plan=5;inCount=${inValues.length}`,
			};

			log('Using index multi-seek on %s (IN with %d values)', physicalIndexName, inValues.length);
			return new IndexSeekNode(
				tableRef.scope,
				tableRef,
				fi,
				physicalIndexName,
				seekKeys,
				false,
				providesOrdering,
				accessPlan.cost
			);
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

			// Compute cross-product of value indices
			const crossProduct = cartesianProduct(columnValues.map(cv =>
				cv.values.map((_v, i) => i)
			));
			const seekWidth = seekCols.length;

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
			return new IndexSeekNode(
				tableRef.scope,
				tableRef,
				fi,
				physicalIndexName,
				seekKeys,
				false,
				providesOrdering,
				accessPlan.cost
			);
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
		return new IndexSeekNode(
			tableRef.scope,
			tableRef,
			fi,
			physicalIndexName,
			seekKeys,
			false,
			providesOrdering,
			accessPlan.cost
		);
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
				accessPlan.cost
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
			accessPlan.cost
		);
	}

	// Check for OR_RANGE constraint on a seek column
	const orRangeConstraint = constraints.find(c =>
		c.op === 'OR_RANGE' && c.ranges && c.ranges.length > 0 &&
		seekCols.includes(c.columnIndex) && handledByCol.has(c.columnIndex)
	);

	if (orRangeConstraint && orRangeConstraint.ranges) {
		const ranges = orRangeConstraint.ranges as RangeSpec[];

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
			accessPlan.cost
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
			accessPlan.cost
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
): SeqScanNode | IndexScanNode | IndexSeekNode {
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
		return new IndexSeekNode(
			tableRef.scope,
			tableRef,
			fi,
			'primary',
			seekKeys,
			false,
			providesOrdering,
			accessPlan.cost
		);
	}

	if (hasRangeConstraints) {
		const rangeCols = constraints
			.filter(c => ['>', '>=', '<', '<='].includes(c.op) && handledByCol.has(c.columnIndex))
			.sort((a, b) => a.columnIndex - b.columnIndex);

		const primaryFirstCol = (tableRef.tableSchema.primaryKeyDefinition?.[0]?.index) ?? (rangeCols[0]?.columnIndex ?? 0);
		const lower = rangeCols.find(c => c.columnIndex === primaryFirstCol && (c.op === '>' || c.op === '>='));
		const upper = rangeCols.find(c => c.columnIndex === primaryFirstCol && (c.op === '<' || c.op === '<='));

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
			accessPlan.cost
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
			accessPlan.cost
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
