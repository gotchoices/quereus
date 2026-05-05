/**
 * Rule: Grow Retrieve
 *
 * Structural sliding rule that maximizes the query segment each virtual table module can execute.
 * This is a bottom-up transformation that slides RetrieveNode boundaries upward to encompass
 * as much of the query pipeline as each module can handle.
 *
 * Applied When:
 * - Node is a unary relational operation (Filter, Project, Sort, LimitOffset)
 * - Child is a RetrieveNode
 * - Virtual table module supports executing the expanded pipeline
 *
 * Benefits:
 * - Maximizes push-down opportunities for query-based modules
 * - Provides fallback support for index-style modules via constraint extraction
 * - Establishes optimal module execution boundaries before cost-based optimization
 */

import { createLogger } from '../../../common/logger.js';
import { isRelationalNode, type PlanNode, type RelationalPlanNode, type ScalarPlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { RetrieveNode } from '../../nodes/retrieve-node.js';
import { FilterNode } from '../../nodes/filter.js';
import type { TableReferenceNode } from '../../nodes/reference.js';
import { PlanNodeType } from '../../nodes/plan-node-type.js';
import type { SupportAssessment } from '../../../vtab/module.js';
import type { BestAccessPlanRequest, BestAccessPlanResult } from '../../../vtab/best-access-plan.js';
import { extractConstraints, createTableInfoFromNode, type TableInfo, type PredicateConstraint } from '../../analysis/constraint-extractor.js';
import { normalizePredicate } from '../../analysis/predicate-normalizer.js';
import { seqScanCost } from '../../cost/index.js';
import { SortNode } from '../../nodes/sort.js';
import { extractOrderingFromSortKeys } from '../../framework/physical-utils.js';
import { LimitOffsetNode } from '../../nodes/limit-offset.js';
import { PlanNode as _PlanNode } from '../../nodes/plan-node.js';
import { PlanNodeType as _PlanNodeType } from '../../nodes/plan-node-type.js';
import { LiteralNode, BinaryOpNode } from '../../nodes/scalar.js';
import { collectBindingsInPlan } from '../../analysis/binding-collector.js';
import type * as AST from '../../../parser/ast.js';
import { ExistsNode, InNode } from '../../nodes/subquery.js';
import { isCorrelatedSubquery } from '../../cache/correlation-detector.js';

const log = createLogger('optimizer:rule:grow-retrieve');

/**
 * Context data stored in RetrieveNode.moduleCtx for index-style fallback
 */
interface IndexStyleContext {
	kind: 'index-style';
	accessPlan: BestAccessPlanResult;
	residualPredicate?: PlanNode;
	originalConstraints: PredicateConstraint[];
}

function isIndexStyleContext(ctx: unknown): ctx is IndexStyleContext {
	return !!ctx && typeof ctx === 'object' && (ctx as { kind?: string }).kind === 'index-style';
}

export function ruleGrowRetrieve(node: PlanNode, context: OptContext): PlanNode | null {
	// This rule runs in a TOP-DOWN pass, looking for any relational operation
	// above a RetrieveNode that can be pushed into the module's execution boundary

	// Must be a relational node to be growable
	if (!isRelationalNode(node)) {
		return null;
	}

	// Find the RetrieveNode child (if any)
	const retrieveChild = findRetrieveChild(node);
	if (!retrieveChild) {
		return null;
	}

	const tableRef = retrieveChild.tableRef;

	// Guard: ensure we have required properties
	if (!tableRef?.tableSchema) {
		log('RetrieveNode missing tableRef or tableSchema');
		return null;
	}

	const tableSchema = tableRef.tableSchema;
	const vtabModule = tableRef.vtabModule;

	log('Evaluating growth for %s over table %s', node.nodeType, tableSchema.name);

	// If no vtabModule, can't grow
	if (!vtabModule) {
		log('No vtabModule available for table %s', tableSchema.name);
		return null;
	}

	// Create candidate pipeline by sliding the operation into the retrieve boundary
	// This replaces the RetrieveNode child with its source in the parent operation
	const candidatePipeline = replaceRetrieveWithSource(node, retrieveChild);

	// Try module's supports() method first (if available)
	let assessment: SupportAssessment | undefined;

	if (vtabModule.supports && typeof vtabModule.supports === 'function') {
		// Query-based module: let it decide if it can handle the pipeline
		log('Testing module.supports() for %s pipeline', node.nodeType);
		assessment = vtabModule.supports(candidatePipeline);

		if (assessment) {
			log('Module supports expanded pipeline (cost: %d)', assessment.cost);
		} else {
			log('Module declined expanded pipeline');
		}
	}

	// If module doesn't have supports() or declined, try index-style fallback
	// but ONLY for operations we know can be translated to index constraints
	if (!assessment && vtabModule.getBestAccessPlan && typeof vtabModule.getBestAccessPlan === 'function') {
		if (canTranslateToIndexConstraints(node)) {
			log('Testing index-style fallback for %s', node.nodeType);
			assessment = fallbackIndexSupports(node, candidatePipeline, context, tableRef);

			if (assessment) {
				log('Index-style fallback supports pipeline (cost: %d)', assessment.cost);
			} else {
				log('Index-style fallback declined pipeline');
			}
		} else {
			log('Node type %s cannot be translated to index constraints', node.nodeType);
		}
	}

	if (!assessment) {
		// Module cannot handle the expanded pipeline
		return null;
	}

	// Determine how to slide depending on assessment origin
	let newPipeline: RelationalPlanNode;
	let newBindings = [...(retrieveChild.bindings ?? []), ...collectBindingsInPlan(node, retrieveChild.tableRef)];

	if (isIndexStyleContext(assessment.ctx)) {
		// Index-style fallback: only place supported fragments under Retrieve; keep residuals above
		newPipeline = candidatePipeline as RelationalPlanNode;
		if (node instanceof FilterNode) {
			const tableInfo: TableInfo = createTableInfoFromNode(retrieveChild.tableRef, tableSchema.name);
			const extraction = extractConstraints(normalizePredicate(node.predicate), [tableInfo]);
			const supported = extraction.supportedPredicateByTable?.get(tableInfo.relationKey);
			if (supported) {
				newPipeline = new FilterNode(
					retrieveChild.source.scope,
					(candidatePipeline as FilterNode).source,
					supported
				) as unknown as RelationalPlanNode;
				newBindings = [...(retrieveChild.bindings ?? []), ...collectBindingsInPlan(newPipeline, retrieveChild.tableRef)];
			}
		}
	} else {
		// Query-based module with supports(): move the entire node into the module boundary
		newPipeline = candidatePipeline as RelationalPlanNode;
	}

	// If index-style with a residual predicate that contains correlated subqueries,
	// keep the residual above the Retrieve as a FilterNode so structural rules
	// (e.g., subquery decorrelation) can still process it. Clear the residual from
	// the context to avoid double-application in select-access-path.
	let moduleCtx = assessment.ctx;
	let residualAbove: ScalarPlanNode | undefined;

	if (isIndexStyleContext(moduleCtx) && moduleCtx.residualPredicate
		&& predicateContainsCorrelatedSubquery(moduleCtx.residualPredicate as ScalarPlanNode)) {
		residualAbove = moduleCtx.residualPredicate as ScalarPlanNode;
		moduleCtx = { ...moduleCtx, residualPredicate: undefined };
	}

	const grownRetrieve = new RetrieveNode(
		node.scope,
		newPipeline,
		retrieveChild.tableRef,
		moduleCtx,
		newBindings
	);

	log('Grew retrieve pipeline for table %s: %s → %s',
		tableSchema.name, retrieveChild.source.nodeType, candidatePipeline.nodeType);

	if (residualAbove) {
		log('Keeping residual predicate above grown Retrieve');
		return new FilterNode(node.scope, grownRetrieve, residualAbove);
	}

	return grownRetrieve;
}

/**
 * Find a RetrieveNode among the children of this node
 */
function findRetrieveChild(node: PlanNode): RetrieveNode | undefined {
	const children = node.getChildren();
	for (const child of children) {
		if (child instanceof RetrieveNode) {
			return child;
		}
	}
	return undefined;
}

/**
 * Replace the RetrieveNode child with its source in the parent operation
 */
function replaceRetrieveWithSource(parent: PlanNode, retrieveNode: RetrieveNode): PlanNode {
	const children = parent.getChildren();
	const newChildren = children.map(child =>
		child === retrieveNode ? retrieveNode.source : child
	);
	return parent.withChildren(newChildren);
}

/**
 * Check if this node type can be translated to index constraints
 * This is used for the fallback when modules don't implement supports()
 */
function canTranslateToIndexConstraints(node: PlanNode): boolean {
	switch (node.nodeType) {
		case PlanNodeType.Filter:
			// Filters can be translated to predicates
			return true;
		case PlanNodeType.Sort:
			// Sort can be translated to ordering requirements
			return true;
		case PlanNodeType.LimitOffset:
			// Limit can be passed to index access
			return true;
		default:
			// Other operations (Project, Aggregate, etc.) can't be
			// meaningfully translated to index constraints
			return false;
	}
}

/**
 * Fallback assessment for index-style modules using getBestAccessPlan
 * Translates various operations to index constraints
 */
function fallbackIndexSupports(
	node: PlanNode,
	candidatePipeline: PlanNode,
	context: OptContext,
	tableRef: TableReferenceNode
): SupportAssessment | undefined {

	const vtabModule = tableRef.vtabModule;
	const tableSchema = tableRef.tableSchema;

	// Build BestAccessPlanRequest based on node type
	const request: BestAccessPlanRequest = {
		columns: tableSchema.columns.map((col, index) => ({
			index,
			name: col.name,
			type: col.logicalType,
			isPrimaryKey: col.primaryKey || false,
			isUnique: col.primaryKey || false
		})),
		filters: [],
		requiredOrdering: undefined,
		limit: undefined,
		estimatedRows: tableRef.estimatedRows || context.stats.tableRows(tableSchema) || 1000
	};

	// Extract information based on node type
	let residualPredicate: PlanNode | undefined;
	let plannerConstraints: PredicateConstraint[] | undefined;

	if (node instanceof FilterNode) {
		// Extract constraints from filter predicate
		const tableInfo: TableInfo = createTableInfoFromNode(tableRef, tableSchema.name);
		const normalizedPredicate = normalizePredicate(node.predicate);
		const extraction = extractConstraints(normalizedPredicate, [tableInfo]);

		if (extraction.allConstraints.length === 0) {
			log('No extractable constraints from filter predicate');
			return undefined;
		}

		plannerConstraints = extraction.allConstraints;
		request.filters = plannerConstraints;
		residualPredicate = extraction.residualPredicate;
		log('Extracted %d constraints from Filter', plannerConstraints.length);

	} else if (node.nodeType === PlanNodeType.Sort) {
		// Extract ordering requirements from Sort node
		const sort = node as unknown as SortNode;
		const ordering = extractOrderingFromSortKeys(sort.getSortKeys(), sort.source.getAttributes());
		if (!ordering) {
			log('Sort node has non-trivial expressions; cannot translate to ordering spec');
			return undefined;
		}
		request.requiredOrdering = ordering.map(o => ({ columnIndex: o.column, desc: o.desc }));
		log('Extracted ordering requirement of length %d', request.requiredOrdering.length);

	} else if (node.nodeType === PlanNodeType.LimitOffset) {
		// Extract limit from LimitOffset node when constant
		const lim = node as unknown as LimitOffsetNode;
		if (lim.limit && lim.limit.nodeType === _PlanNodeType.Literal) {
			const limitVal = (lim.limit as unknown as LiteralNode).expression.value;
			if (typeof limitVal === 'number') {
				request.limit = Math.max(0, Math.floor(limitVal));
				log('Extracted limit value: %d', request.limit);
			}
		}
		// We ignore OFFSET for now (modules can implement it internally if desired)
		if (!request.limit) {
			log('No usable constant LIMIT found');
			return undefined;
		}

	} else {
		log('Node type %s not supported by index-style fallback', node.nodeType);
		return undefined;
	}

	log('Built access plan request: %d filters, ordering: %s, limit: %s',
		request.filters.length,
		request.requiredOrdering ? 'yes' : 'no',
		request.limit ?? 'none');

	// Get access plan from module
	const accessPlan = vtabModule.getBestAccessPlan!(context.db, tableSchema, request);

	// Check if the plan is beneficial
	const handlesAnyFilter = request.filters.length > 0 &&
		accessPlan.handledFilters.some(handled => handled);
	const providesOrdering = request.requiredOrdering &&
		accessPlan.providesOrdering;

	// Calculate baseline cost
	const estimatedRows = request.estimatedRows ?? 1000;
	const seqCost = seqScanCost(estimatedRows);

	// Accept the plan if it handles filters OR provides required ordering
	if (!handlesAnyFilter && !providesOrdering) {
		log('Access plan provides no benefit');
		return undefined;
	}

	if (accessPlan.cost >= seqCost && !providesOrdering) {
		log('Access plan cost (%d) not better than sequential scan (%d)', accessPlan.cost, seqCost);
		return undefined;
	}

	log('Index-style fallback beneficial: cost %d vs %d seq scan', accessPlan.cost, seqCost);

	// Compute full residual: extraction residual + source expressions of unhandled constraints.
	// The extractor marks constraints it can decompose (e.g., LIKE), but the module may not
	// handle them.  Those unhandled constraints must be preserved as a residual filter.
	if (plannerConstraints && plannerConstraints.length > 0) {
		const unhandledExprs: ScalarPlanNode[] = [];
		for (let i = 0; i < plannerConstraints.length; i++) {
			if (!accessPlan.handledFilters[i] && plannerConstraints[i].sourceExpression) {
				unhandledExprs.push(plannerConstraints[i].sourceExpression);
			}
		}
		if (unhandledExprs.length > 0) {
			const parts: ScalarPlanNode[] = residualPredicate ? [residualPredicate as ScalarPlanNode, ...unhandledExprs] : unhandledExprs;
			if (parts.length === 1) {
				residualPredicate = parts[0];
			} else {
				let acc: ScalarPlanNode = parts[0];
				for (let i = 1; i < parts.length; i++) {
					const right = parts[i];
					const ast: AST.BinaryExpr = { type: 'binary', operator: 'AND', left: acc.expression, right: right.expression };
					acc = new BinaryOpNode(acc.scope, ast, acc, right);
				}
				residualPredicate = acc;
			}
			log('Added %d unhandled constraint expressions to residual', unhandledExprs.length);
		}
	}

	// Store context for later use in ruleSelectAccessPath
	const indexCtx: IndexStyleContext = {
		kind: 'index-style',
		accessPlan,
		residualPredicate,
		originalConstraints: plannerConstraints ? [...plannerConstraints] : []
	};

	return {
		cost: accessPlan.cost,
		ctx: indexCtx
	};
}

/**
 * Check if a scalar expression tree contains any correlated EXISTS or IN subqueries.
 * These need to remain in the plan tree for subquery decorrelation to process them.
 */
function predicateContainsCorrelatedSubquery(expr: PlanNode): boolean {
	if (expr instanceof ExistsNode) {
		return isCorrelatedSubquery(expr.subquery);
	}
	if (expr instanceof InNode && expr.source) {
		return isCorrelatedSubquery(expr.source);
	}
	for (const child of expr.getChildren()) {
		if (predicateContainsCorrelatedSubquery(child)) {
			return true;
		}
	}
	return false;
}
