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
import type { TableSchema } from '../../../schema/table.js';
import { ColumnReferenceNode } from '../../nodes/reference.js';
import { PlanNodeType } from '../../nodes/plan-node-type.js';
import type { SupportAssessment } from '../../../vtab/module.js';
import type { BestAccessPlanRequest, BestAccessPlanResult, OrderingSpec } from '../../../vtab/best-access-plan.js';
import { extractConstraints, createTableInfoFromNode, extractConstraintsForTable, type TableInfo, type PredicateConstraint } from '../../analysis/constraint-extractor.js';
import { normalizePredicate } from '../../analysis/predicate-normalizer.js';
import { seqScanCost } from '../../cost/index.js';
import { SortNode } from '../../nodes/sort.js';
import { ProjectNode } from '../../nodes/project-node.js';
import { AliasNode } from '../../nodes/alias-node.js';
import { extractOrderingFromSortKeys } from '../../framework/physical-utils.js';
import { LimitOffsetNode, constantNumber } from '../../nodes/limit-offset.js';
import { PlanNode as _PlanNode } from '../../nodes/plan-node.js';
import { PlanNodeType as _PlanNodeType } from '../../nodes/plan-node-type.js';
import { LiteralNode } from '../../nodes/scalar.js';
import { collectBindingsInPlan } from '../../analysis/binding-collector.js';
import { splitConjuncts } from '../../analysis/predicate-conjuncts.js';
import { combineResidualExpressions, orderingClaimSurvivesCollation } from '../access/rule-select-access-path.js';
import { type IndexStyleContext, isIndexStyleContext } from '../shared/index-style-context.js';
import { rebuildChain } from '../shared/access-leaf.js';
import { safeToEvaluateTwice } from '../shared/evaluate-twice.js';
import { LimitChoiceNode } from '../../nodes/limit-choice-node.js';
import { PlanNodeCharacteristics } from '../../framework/characteristics.js';
import { hasRelationalDescendant } from '../../analysis/scalar-subqueries.js';

const log = createLogger('optimizer:rule:grow-retrieve');

/**
 * The row count for a `BestAccessPlanRequest`: the measured count, or `undefined` when
 * nothing has measured it. Never a fabricated number.
 *
 * `TableReferenceNode.estimatedRows` is `plannedRowCount(tableSchema, …)` — the module's
 * own count (`VirtualTableModule.getRowCount`), an exact count observed during execution,
 * or `ANALYZE`'s, ranked there — where a real `0` means "measured, empty" and `undefined`
 * means "nobody knows".
 *
 * `context.stats.tableRows()` is deliberately NOT consulted here. `CatalogStatsProvider`
 * reads that same `plannedRowCount` and, finding nothing, falls back to
 * `NaiveStatsProvider`'s fixed 1000 — so routing through it would hand the module a
 * made-up size indistinguishable from a real 1000-row `ANALYZE` result, and lock out
 * every module that can size itself better (`quereus-store` keeps a live row count).
 * A module with no way to size itself applies its own default instead; that default is
 * now the sole fallback.
 */
function measuredRows(tableRef: TableReferenceNode): number | undefined {
	return tableRef.estimatedRows;
}

export function ruleGrowRetrieve(node: PlanNode, context: OptContext): PlanNode | null {
	// This rule runs in a TOP-DOWN pass, looking for any relational operation
	// above a RetrieveNode that can be pushed into the module's execution boundary

	// Must be a relational node to be growable
	if (!isRelationalNode(node)) {
		return null;
	}

	// A LIMIT the user wrote sits above the Sort it bounds. Visiting it first (the pass is
	// top-down) is the only point where both are in hand; a decline falls through and the
	// Sort's own limit-free attempt below still runs when the pass reaches it.
	if (node instanceof LimitOffsetNode) {
		const absorbed = tryLimitedSortAbsorb(node, context);
		if (absorbed) return absorbed;
	}

	// Find the RetrieveNode child (if any)
	const retrieveChild = findRetrieveChild(node);
	if (!retrieveChild) {
		// Special case: Sort can absorb its ordering into a Retrieve reachable
		// through commuting unary operators (Project, Filter, Alias), provided the
		// access plan can satisfy the requested ordering. See
		// trySortAbsorbViaIndexOrdering for details.
		if (node instanceof SortNode) {
			return trySortAbsorbViaIndexOrdering(node, context);
		}
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
			assessment = fallbackIndexSupports(node, context, tableRef, retrieveChild.moduleCtx);

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
		// NOTE: the Filter built below never executes — `ruleSelectAccessPath`'s index-style
		// branch physicalizes from moduleCtx alone and never reads `Retrieve.source`. It is
		// written anyway because two later readers walk it: `collectBindingsInPlan` (below)
		// gathers correlated bindings from it, and `trySortAbsorbViaIndexOrdering` sweeps it
		// for constraints when deciding whether a Sort can be absorbed. Any rule that writes
		// a predicate into a committed Retrieve's `source` expecting it to EXECUTE will lose
		// it (see rule-predicate-pushdown's guard).
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

	// If index-style with a residual predicate that contains ANY subquery, keep the
	// residual above the Retrieve as a FilterNode so the bottom-up physical pass still
	// covers the subquery's own plan tree (and structural rules like subquery
	// decorrelation can process it). Burying it in moduleCtx.residualPredicate leaves
	// the subquery's inner Retrieve outside the region select-access-path visits, so it
	// stays unphysicalized and emitRetrieve throws. Correlation is irrelevant: a
	// self-contained IN (SELECT …)/EXISTS/scalar subquery carries an inner Retrieve just
	// the same. Clear the residual from the context to avoid double-application in
	// select-access-path. See tickets/complete/grow-retrieve-noncorrelated-subquery-residual.
	let moduleCtx = assessment.ctx;
	let residualAbove: ScalarPlanNode | undefined;

	if (isIndexStyleContext(moduleCtx) && moduleCtx.residualPredicate
		&& predicateContainsSubquery(moduleCtx.residualPredicate)) {
		residualAbove = moduleCtx.residualPredicate;
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
 * Drop constraints that repeat one already present. A re-grow unions the committed
 * context's constraints with those re-extracted from the incoming node, and the same
 * predicate node commonly appears in both.
 *
 * Identity is (sourceExpression, columnIndex, op) — NOT `sourceExpression` alone: a
 * BETWEEN decomposes into a lower and an upper bound that share one source node, so
 * keying on the node would drop half the range (`id between 51 and 150` would delete
 * everything from 51 up). Do not "simplify" this back to expression identity.
 *
 * Duplicates are not merely untidy: the module claims the first copy and the second
 * falls through to `reattachUnconsumedConstraints`, which re-applies it as a redundant
 * residual Filter and shifts the cost estimate enough to flip join strategies.
 */
function dedupeConstraints(constraints: PredicateConstraint[]): PredicateConstraint[] {
	const rolesByExpression = new Map<ScalarPlanNode, Set<string>>();
	return constraints.filter(constraint => {
		let roles = rolesByExpression.get(constraint.sourceExpression);
		if (!roles) rolesByExpression.set(constraint.sourceExpression, roles = new Set());
		const role = `${constraint.columnIndex}:${constraint.op}`;
		if (roles.has(role)) return false;
		roles.add(role);
		return true;
	});
}

/**
 * The predicate the physical leaf must still apply once the module has taken what it
 * can: the extractor's own residual, plus the source expression of every constraint the
 * module declined, plus the residual the displaced context was enforcing (nothing else
 * re-applies that one — the new context replaces it wholesale).
 *
 * The committed residual is contributed conjunct-by-conjunct rather than whole, skipping
 * any conjunct that is also a constraint's source expression: the re-probe already covers
 * those, either by seeking them or by re-adding them here. Keeping the committed copy as
 * well would apply the same predicate twice — correct, but a wasted evaluation per row and
 * a cost shift of exactly the kind `dedupeConstraints` exists to avoid.
 *
 * `combineResidualExpressions` supplies the rest of the de-duplication by identity, which
 * is what collapses the two bounds of a declined BETWEEN back into their one source node.
 */
function assembleResidual(
	extractionResidual: ScalarPlanNode | undefined,
	constraints: readonly PredicateConstraint[],
	handledFilters: readonly boolean[],
	committedResidual: ScalarPlanNode | undefined,
): ScalarPlanNode | undefined {
	const constraintExprs = new Set<ScalarPlanNode>(constraints.map(c => c.sourceExpression));

	const parts: ScalarPlanNode[] = extractionResidual ? [extractionResidual] : [];
	constraints.forEach((constraint, i) => {
		if (!handledFilters[i]) parts.push(constraint.sourceExpression);
	});
	if (committedResidual) {
		parts.push(...splitConjuncts(committedResidual).filter(c => !constraintExprs.has(c)));
	}

	const residual = combineResidualExpressions(parts);
	log('Residual over %d constraint(s): %s', constraints.length, residual ? 'yes' : 'none');
	return residual;
}

/**
 * Fallback assessment for index-style modules using getBestAccessPlan
 * Translates various operations to index constraints
 *
 * INVARIANT — an `IndexStyleContext` may only be replaced by one that enforces a
 * SUPERSET of what it enforced. This function returns a brand-new context that
 * *replaces* `existingCtx` wholesale, and once a Retrieve carries such a context it is
 * the sole authority for what the table access applies (`ruleSelectAccessPath` never
 * reads `Retrieve.source`). So the re-probe must request at least the constraints the
 * committed context already claims, and must carry its residual forward — otherwise a
 * conjunct the displaced plan was seeking is silently dropped and the query returns rows
 * the WHERE excluded. Both halves are enforced below:
 *  - constraints: `committedConstraints` is unioned into `request.filters` on every arm,
 *    and anything the new plan declines is residualized instead (so correctness does not
 *    depend on the module answering the second probe the way it answered the first);
 *  - ordering: `equippedOrdering` is re-requested and the no-clobber guard declines a
 *    plan that does not provide it.
 */
function fallbackIndexSupports(
	node: PlanNode,
	context: OptContext,
	tableRef: TableReferenceNode,
	existingCtx?: unknown
): SupportAssessment | undefined {

	const vtabModule = tableRef.vtabModule;
	const tableSchema = tableRef.tableSchema;

	// If the RetrieveNode we are growing over already carries an index-style
	// context that provides an ordering (e.g. a reverse plan absorbed from a
	// Sort by trySortAbsorbViaIndexOrdering), we must re-derive a
	// direction-matching plan here. A plain no-ordering re-probe can return an
	// oppositely-ordered plan (a module that serves DESC by reverse-scanning an
	// ascending index yields the forward plan when ordering is not requested);
	// equipping that plan silently clobbers the absorbed reverse plan while the
	// Sort has already been dropped, so rows stream in the wrong direction. See
	// `fix/quereus-reverse-order-sort-absorb-desync`.
	const equippedOrdering: readonly OrderingSpec[] | undefined =
		isIndexStyleContext(existingCtx)
			&& existingCtx.accessPlan.providesOrdering
			&& existingCtx.accessPlan.providesOrdering.length > 0
			? existingCtx.accessPlan.providesOrdering
			: undefined;

	// What the CURRENTLY COMMITTED plan is enforcing. A re-probe replaces moduleCtx
	// wholesale, so anything here left out of the new request/residual is silently
	// dropped — `Retrieve.source` is not an execution channel once a ctx exists.
	const committedConstraints: PredicateConstraint[] =
		isIndexStyleContext(existingCtx) ? [...existingCtx.originalConstraints] : [];
	const committedResidual: ScalarPlanNode | undefined =
		isIndexStyleContext(existingCtx) ? existingCtx.residualPredicate : undefined;

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
		estimatedRows: measuredRows(tableRef)
	};

	// Extract information based on node type
	let residualPredicate: ScalarPlanNode | undefined;
	let plannerConstraints: PredicateConstraint[] = committedConstraints;

	if (node instanceof FilterNode) {
		// Extract constraints from filter predicate
		const tableInfo: TableInfo = createTableInfoFromNode(tableRef, tableSchema.name);
		const normalizedPredicate = normalizePredicate(node.predicate);
		const extraction = extractConstraints(normalizedPredicate, [tableInfo]);

		// Declining is always safe, committed context or not: the Filter stays above the
		// Retrieve and executes there, and the committed context is left untouched.
		if (extraction.allConstraints.length === 0) {
			log('No extractable constraints from filter predicate');
			return undefined;
		}

		plannerConstraints = dedupeConstraints([...committedConstraints, ...extraction.allConstraints]);
		residualPredicate = extraction.residualPredicate;
		log('Extracted %d constraints from Filter (%d carried from committed context)',
			extraction.allConstraints.length, committedConstraints.length);

	} else if (node.nodeType === PlanNodeType.Sort) {
		// Extract ordering requirements from Sort node
		const sort = node as unknown as SortNode;
		const ordering = extractOrderingFromSortKeys(sort.getSortKeys(), sort.source.getAttributes());
		if (!ordering) {
			log('Sort node has non-trivial expressions or NULLS LAST; cannot translate to ordering spec');
			return undefined;
		}
		request.requiredOrdering = ordering.map(o => ({ columnIndex: o.column, desc: o.desc }));
		log('Extracted ordering requirement of length %d', request.requiredOrdering.length);

	} else if (node.nodeType === PlanNodeType.LimitOffset) {
		// Extract limit + offset from LimitOffset when both are constants. We
		// surface OFFSET to the module via `request.offset` so modules pushing
		// LIMIT into the scan can stamp `scan-side limit = limit + offset` and
		// avoid underproducing the runtime LimitOffsetNode (which still applies
		// the OFFSET skip above whatever the scan emits).
		const lim = node as unknown as LimitOffsetNode;
		let limitVal: number | undefined;
		let offsetVal = 0;
		if (lim.limit && lim.limit.nodeType === _PlanNodeType.Literal) {
			const v = (lim.limit as unknown as LiteralNode).expression.value;
			if (typeof v === 'number') limitVal = Math.max(0, Math.floor(v));
		}
		if (lim.offset === undefined) {
			// NOTE: a bare `LIMIT n` (absent OFFSET) is refused here, so no module sees
			// `request.limit` by this route unless an explicit numeric OFFSET was written.
			//
			// This refusal is load-bearing: `rule-minmax-index-boundary` puts a
			// `LimitOffset(1)` with an absent OFFSET directly above an ordering-equipped
			// Retrieve, and refusing is what keeps it there. Reading an absent OFFSET as 0
			// would let the grow SWALLOW that node into `Retrieve.source`, which the
			// index-style branch of `ruleSelectAccessPath` never executes — the boundary
			// read's early stop would silently vanish and the scan would drain the table
			// (answers unchanged, cost restored to a full scan). Widen this only alongside
			// a guard for that rewrite; the "LIMITOFFSET survives directly above the access
			// leaf" case in test/optimizer/minmax-index-boundary.spec.ts is what catches it.
			limitVal = undefined;
		} else if (lim.offset.nodeType === _PlanNodeType.Literal) {
			const v = (lim.offset as unknown as LiteralNode).expression.value;
			if (typeof v === 'number') {
				offsetVal = Math.max(0, Math.floor(v));
			} else {
				// Non-numeric literal OFFSET — refuse to push the LIMIT, because we cannot
				// soundly compute `limit + offset`.
				limitVal = undefined;
			}
		} else {
			// Non-literal OFFSET (e.g. parameter) — refuse to push the LIMIT.
			limitVal = undefined;
		}
		if (limitVal === undefined) {
			log('No usable constant LIMIT (or absent / non-literal OFFSET)');
			return undefined;
		}
		// Reached by an explicit numeric OFFSET only (`limit 5 offset 0` gets here;
		// a bare `limit 5` is refused above). The probe below sends this through
		// `probeAccessPlan`, which strips it again unless truncation is provably safe.
		request.limit = limitVal;
		request.offset = offsetVal;
		log('Extracted limit=%d offset=%d', limitVal, offsetVal);

	} else {
		log('Node type %s not supported by index-style fallback', node.nodeType);
		return undefined;
	}

	// Every arm requests at least the committed context's constraints: the Filter arm
	// unions them with its own extraction, the Sort / LimitOffset arms inherit them from
	// the initializer. `handledFilters` is positional against this array, so it must be
	// the same object the residual assembly below walks.
	request.filters = plannerConstraints;

	// Carry the equipped ordering into the re-probe (unless the node type already
	// derived one, e.g. a Sort) so the module returns a direction-matching plan
	// instead of a no-ordering one that would clobber the absorbed reverse plan.
	if (equippedOrdering && !request.requiredOrdering) {
		request.requiredOrdering = equippedOrdering.map(o => ({ columnIndex: o.columnIndex, desc: o.desc }));
	}

	log('Built access plan request: %d filters, ordering: %s, limit: %s',
		request.filters.length,
		request.requiredOrdering ? 'yes' : 'no',
		request.limit ?? 'none');

	// One binding of "ask THIS module about THIS table", shared by the plan probe and the
	// baseline probe below. Both sides of the seek-versus-scan comparison being answered by
	// the same module is the whole point of `baselineScanCost`, so they read one `ask`.
	const ask = (req: BestAccessPlanRequest): BestAccessPlanResult =>
		vtabModule.getBestAccessPlan!(context.db, tableSchema, req) as BestAccessPlanResult;

	// Get access plan from module. The LimitOffset arm above is the other site that can
	// populate `request.limit`, so it goes through the same funnel: the region that could
	// still discard a row is everything below `node` (the swallowed LimitOffset's own
	// source pipeline, Retrieve included). The Filter and Sort arms carry no limit, so
	// this is a plain single probe for them.
	const accessPlan = probeAccessPlan(ask, request, plannerConstraints, node);

	// No-clobber guard: never replace an equipped ordering plan with one that does
	// not provide the same ordering (same column indexes + directions). Declining
	// here leaves the current (correct) tree in place — a redundant Filter above a
	// reverse Retrieve is safe because a Filter preserves row order, so rows still
	// emerge in the absorbed direction.
	// NOTE: the end-to-end regression that proves this guard is load-bearing lives
	// in Lamina's cross-repo suite (ordinal-seek-range-bounds.test.ts), not here —
	// the synthetic reverse-scan spec physicalizes before the re-grow can race in,
	// so it exercises trySortAbsorbViaIndexOrdering's satisfaction check but not
	// this clobber. If you refactor this branch, run Lamina's suite too, or add a
	// Quereus-native repro that re-grows over an already-reverse-equipped Retrieve.
	// NOTE: a Retrieve equipped under a LIMIT (the min/max boundary read, or a user LIMIT
	// above an absorbed Sort) re-grows its chain Filter WITHOUT that limit, so a backend
	// with expensive row reads answers unordered and this declines — the Filter stays as
	// a re-check of predicates the seek already claimed (`FILTER b = 1` over the `ix_bc`
	// seek in quereus-store's plan-time-limit.spec.ts). Correct, and it runs only on the
	// rows the LIMIT pulls; if that re-check ever shows up as cost, drop a chain Filter
	// whose every constraint the committed plan already handles instead of re-probing.
	if (equippedOrdering && !planDeliversOrdering(tableSchema, accessPlan, equippedOrdering, plannerConstraints)) {
		log('Re-probe would clobber equipped ordering; declining grow to preserve absorbed plan');
		return undefined;
	}

	// Check if the plan is beneficial
	const handlesAnyFilter = request.filters.length > 0 &&
		accessPlan.handledFilters.some(handled => handled);
	// Only count ordering as a benefit when the plan provides the SAME columns and
	// directions that were requested — a wrong-direction (or wrong-column)
	// providesOrdering of equal length must not let a Sort be grown into (and thus
	// dropped by) this Retrieve. Direction-aware, not length-only.
	const providesOrdering = request.requiredOrdering
		? planDeliversOrdering(tableSchema, accessPlan, request.requiredOrdering, plannerConstraints)
		: false;

	// Accept the plan if it handles filters OR provides required ordering
	if (!handlesAnyFilter && !providesOrdering) {
		log('Access plan provides no benefit');
		return undefined;
	}

	// Growing a Sort or a LimitOffset SWALLOWS it — the node lands in `Retrieve.source`,
	// which the index-style branch of `ruleSelectAccessPath` never reads. Such a grow is
	// only sound when the plan actually provides the ordering that was requested, so a
	// handled filter alone must not license it. Before the committed constraints were
	// unioned into `request.filters` these arms sent no filters at all and
	// `handlesAnyFilter` was therefore always false for them; this keeps that.
	if (!(node instanceof FilterNode) && !providesOrdering) {
		log('Growing %s would swallow it without the plan providing its ordering; declining', node.nodeType);
		return undefined;
	}

	// Seek-versus-scan. The baseline is quoted by the SAME module that quoted the seek, so
	// both numbers are priced against one table size — see `baselineScanCost`. Only this
	// branch reads it: when the plan provides the requested ordering that is the benefit
	// being bought, and no baseline probe is paid for.
	//
	// NOTE: declining below does NOT yield the sequential scan this comparison assumes.
	// With no index-style context on the Retrieve, `rule-predicate-pushdown` pushes the
	// same predicate into `Retrieve.source` and `ruleSelectAccessPath`'s no-context branch
	// rebuilds the identical seek, with the absorbed Filter re-stacked above it — so a
	// decline costs the seek AND a second evaluation of the predicate per surviving row.
	// Verified with the shipped memory backend: `id in (<60 keys>)` over a 10-row ANALYZEd
	// table plans as FILTER over INDEXSEEK. Tracked as
	// `bug-declined-push-down-is-rebuilt-as-seek-plus-duplicate-filter`; do not re-file.
	if (!providesOrdering) {
		const seqCost = baselineScanCost(ask, request);
		if (accessPlan.cost >= seqCost) {
			log('Access plan cost (%d) not better than sequential scan (%d)', accessPlan.cost, seqCost);
			return undefined;
		}
		log('Index-style fallback beneficial: cost %d vs %d seq scan', accessPlan.cost, seqCost);
	} else {
		log('Index-style fallback beneficial: plan provides the required ordering');
	}

	residualPredicate = assembleResidual(
		residualPredicate, plannerConstraints, accessPlan.handledFilters, committedResidual);

	// Store context for later use in ruleSelectAccessPath. A re-grow over a
	// Retrieve whose ordering already absorbed a Sort must keep the
	// load-bearing marker — the Sort is gone either way.
	//
	// NOTE: accepted tradeoff — the Sort arm above also drops a Sort (`select * from t
	// order by id` reaches it: no Project, Filter or Alias between Sort and Retrieve) yet
	// deliberately does NOT mark it, unlike `trySortAbsorbViaIndexOrdering`. Marking it is
	// the conservative reading but costs a real optimization — the leaf under
	// `join (select * from big order by v) z` would stop qualifying for an
	// index-nested-loop seek, which test/optimizer/index-nested-loop.spec.ts pins as
	// firing. Sound because the two conditions never coincide: an ordering a consumer
	// observes has no emission-order-changing rewrite above it (nothing sits above a
	// top-level ordered scan), and the shapes that do have one are subquery ORDER BYs,
	// which SQL does not guarantee through a join — the LIMIT case that would make one
	// meaningful is already refused by the peel gate in rules/join/index-nested-loop.ts.
	// An aliased `join (select * from big b order by b.v) z` takes the absorb path instead,
	// so it is marked and gets no seek; it got none while its Sort stayed either. So does
	// any Sort under a constant LIMIT (`tryLimitedSortAbsorb` runs first), which the peel
	// gate refuses anyway.
	// Revisit if a rewrite ever reorders a leaf whose ordering the query genuinely observes.
	const indexCtx: IndexStyleContext = {
		kind: 'index-style',
		accessPlan,
		residualPredicate,
		originalConstraints: [...plannerConstraints],
		...(isIndexStyleContext(existingCtx) && existingCtx.orderingLoadBearing
			? { orderingLoadBearing: true } : {}),
	};

	return {
		cost: accessPlan.cost,
		ctx: indexCtx
	};
}

/**
 * True when `provided` satisfies `required` position-for-position — same column
 * indexes and same descending flags for every required position (the plan may
 * provide extra trailing ordering, so `provided` need only be at least as long).
 * Used both to gate the sort-absorb satisfaction check and to guard a re-grow
 * from clobbering an already-equipped ordering plan. Comparing the ordering as
 * data (columnIndex + desc) keeps a single representation — see the `OrderingSpec`
 * shape in `best-access-plan.ts`.
 */
function orderingMatches(
	provided: readonly OrderingSpec[] | undefined,
	required: readonly OrderingSpec[],
): boolean {
	if (!provided || provided.length < required.length) return false;
	for (let i = 0; i < required.length; i++) {
		if (provided[i].columnIndex !== required[i].columnIndex || provided[i].desc !== required[i].desc) {
			return false;
		}
	}
	return true;
}

/**
 * True when `plan` can stand in for a Sort on `required`. Every site that lets a Sort go
 * asks this, because a module's claim alone is not enough: see
 * {@link orderingClaimSurvivesCollation}.
 */
function planDeliversOrdering(
	tableSchema: TableSchema,
	plan: BestAccessPlanResult,
	required: readonly OrderingSpec[],
	constraints: readonly PredicateConstraint[],
): boolean {
	return orderingMatches(plan.providesOrdering, required)
		&& orderingClaimSurvivesCollation(tableSchema, plan, constraints);
}

/** A row bound a caller already knows, to be handed to the module as LIMIT/OFFSET. */
export interface RowsWanted {
	/** Rows the caller can consume. */
	limit: number;
	/** Rows discarded before those — a module may only stop after `limit + offset`. */
	offset: number;
}

/**
 * Whether a module may stop producing after `limit + offset` rows.
 *
 * `BestAccessPlanRequest.limit` is a truncation contract, not a pricing hint — its
 * sibling `offset` explicitly invites a module to stamp `scan-side limit = limit +
 * offset` — so it may only be sent when nothing between the module's scan and the
 * LimitOffset can discard a row. Filtering above a truncated scan UNDERPRODUCES:
 * `min(c)` over a scan stopped at one row whose `c` is then filtered out returns NULL
 * rather than the minimum.
 *
 * A row survives to the limit when every Filter it passes through is one the access
 * plan already claimed — a claimed constraint cannot reject a row the module produced
 * under it. So every conjunct of every Filter below the Sort must match, by node
 * identity, the `sourceExpression` of a constraint the plan reported handled.
 *
 * Deliberately conservative in three ways, because the failure mode is a wrong answer
 * and the cost of declining is only the pricing this ticket set out to improve:
 *  - a conjunct that never became a constraint at all is invisible to the residual
 *    assembly, so this tests the Filters themselves rather than `residualPredicate`;
 *  - identity matching means a constraint synthesized from something other than the
 *    conjunct it came from (an OR_RANGE union, say) simply fails to cover it;
 *  - the walk descends into every child, so a Filter inside a subquery — which is not
 *    between the scan and the limit at all — declines rather than being reasoned about.
 *
 * Only `FilterNode` discards rows in the region this walks: the chain between the Sort
 * and the Retrieve admits Project, Filter and Alias alone, and a module pipeline under
 * `Retrieve.source` is built from Project and Filter. A row-discarding node type reaching
 * that region would need adding here.
 */
function truncationIsSafe(
	source: PlanNode,
	constraints: readonly PredicateConstraint[],
	handledFilters: readonly boolean[],
): boolean {
	// One expression can yield SEVERAL constraints — a BETWEEN yields its `>=` and its
	// `<=` from the same node — and they can be claimed independently: `where b > 0 and b
	// between 1 and 5` lets the module take the earlier `b > 0` as its lower bound and
	// only the BETWEEN's upper half. `assembleResidual` then puts the whole BETWEEN back
	// in the residual Filter, so covering it off the claimed half alone would license a
	// truncation the residual can still underproduce. An expression covers a conjunct only
	// when EVERY constraint it produced was claimed.
	const claimed = new Set<ScalarPlanNode>();
	const unclaimed = new Set<ScalarPlanNode>();
	constraints.forEach((c, i) => {
		(handledFilters[i] ? claimed : unclaimed).add(c.sourceExpression);
	});
	const covers = (conjunct: ScalarPlanNode): boolean =>
		claimed.has(conjunct) && !unclaimed.has(conjunct);

	const survivesEveryFilter = (node: PlanNode): boolean => {
		if (node instanceof FilterNode && !splitConjuncts(node.predicate).every(covers)) {
			return false;
		}
		return node.getChildren().every(survivesEveryFilter);
	};
	return survivesEveryFilter(source);
}

/**
 * Probe `getBestAccessPlan`, honouring the truncation contract on `request.limit`.
 *
 * EVERY site that populates `request.limit` goes through here — that single funnel is
 * what keeps the field's documented "licence, not a hint" contract true. A request
 * carrying a limit is probed WITH it, and the plan that comes back is kept only when
 * {@link truncationIsSafe} holds for the constraints that plan actually claimed;
 * otherwise the limit is stripped and the module is asked again.
 *
 * Probing limit-free first cannot work: a module that vetoes its ordered arm on
 * whole-table pricing answers with an unordered plan, the caller's ordering check fails,
 * and it gives up before a second phase could run — which is precisely the case the
 * bound exists to fix. Validating afterwards costs at most one extra probe, and none at
 * all when the request carries no limit. `getBestAccessPlan` is pure at plan time, so a
 * discarded probe leaves nothing behind.
 *
 * `subtree` is the region between the module's scan and the LIMIT — everything that
 * could still discard a row the module produced. `constraints` is `request.filters` in
 * its planner-side form: `handledFilters` is positional against it, and only that form
 * carries the `sourceExpression` the safety check matches on.
 */
function probeAccessPlan(
	ask: (request: BestAccessPlanRequest) => BestAccessPlanResult,
	request: BestAccessPlanRequest,
	constraints: readonly PredicateConstraint[],
	subtree: PlanNode,
): BestAccessPlanResult {
	const plan = ask(request);
	if (request.limit === undefined || request.limit === null) return plan;
	if (truncationIsSafe(subtree, constraints, plan.handledFilters)) return plan;
	log('Limit is not truncation-safe for this subtree; re-probing without it');
	return ask({ ...request, limit: undefined, offset: undefined });
}

/**
 * What a plain whole-table read of this table costs, quoted by the SAME module that
 * quoted the seek being compared against it.
 *
 * The seek-versus-scan veto in `fallbackIndexSupports` (`accessPlan.cost >= seqCost`)
 * compares two numbers, and they have to be priced against one table size. Deriving the baseline from
 * `seqScanCost(request.estimatedRows ?? 1000)` did not: `estimatedRows` is the catalog's
 * measurement — `undefined` when nobody ran `ANALYZE`, and a stale `0` when `ANALYZE` ran
 * before the table was filled — while a module that keeps a live row count (e.g.
 * `quereus-store`) prices its seek arm against the real size. On any table where the two
 * disagree the honest seek lost to a made-up scan, the grow was declined, and the
 * predicate was re-enforced in a `Filter` above the seek that had already bounded the rows.
 *
 * Asking the module instead is symmetric by construction: whatever size it used to price
 * the seek, it used the same one here. No new module interface, and no re-fabricated 1000
 * on the request — that would reinstate the bug `ask-the-backend-before-guessing-its-size`
 * removed and blind every self-sizing module again.
 *
 * The probe strips filters, ordering, limit and offset. Ordering too, not just filters:
 * the veto only fires when `!providesOrdering` (ordering is scored as a benefit
 * separately), so the baseline must be the plain scan the seek is actually competing with.
 *
 * `seqScanCost` stays as the non-finite fallback. `BestAccessPlanResult.cost` is a
 * required `number`, so the branch should be unreachable; keeping it means a module
 * answering `NaN` degrades to exactly the old behavior instead of vetoing on a comparison
 * with `NaN`.
 *
 * `getBestAccessPlan` is pure at plan time, so the discarded probe leaves nothing behind —
 * the same property `probeAccessPlan` above already relies on.
 *
 * NOTE: this costs one extra `getBestAccessPlan` call per grow attempt that reaches the
 * seek-versus-scan veto (an index-style module whose plan does not provide the requested
 * ordering). Measured as free — no gated bench counter moved and all four ratio guards
 * held — but a module with an expensive `getBestAccessPlan` pays it twice per such
 * attempt; if that ever shows up in a profile, memoize the filter-free answer per table
 * per optimizer pass.
 */
function baselineScanCost(
	ask: (request: BestAccessPlanRequest) => BestAccessPlanResult,
	request: BestAccessPlanRequest,
): number {
	const baseline = ask({
		...request,
		filters: [],
		requiredOrdering: undefined,
		limit: undefined,
		offset: undefined,
	});
	if (Number.isFinite(baseline.cost)) return baseline.cost;
	log('Module quoted a non-finite baseline cost; falling back to the engine model');
	return seqScanCost(request.estimatedRows ?? 1000);
}

/**
 * Attempt to absorb a Sort whose Retrieve is reachable through a chain of
 * commuting unary operators (Project, Filter, Alias). When the table's access
 * plan can satisfy the required ordering — e.g., a composite index where leading
 * columns are equality-bound by an upstream Filter and trailing columns
 * provide the ORDER BY direction — the Sort can be elided entirely:
 * Retrieve produces rows in the requested order, and Project/Filter/Alias
 * preserve row order on the way back up. An Alias renames the relation but keeps
 * attribute ids, so sort keys above it still resolve to table columns.
 *
 * Three entry points:
 *  - `ruleGrowRetrieve`'s Sort visit, for a Sort the user wrote (or an earlier rule left);
 *  - `ruleGrowRetrieve`'s LimitOffset visit ({@link tryLimitedSortAbsorb}), for a Sort
 *    under a constant LIMIT, asked with that bound before the Sort visit asks without it
 *    (a placeholder LIMIT goes through the same prepare / build steps instead, via
 *    {@link tryRuntimeLimitChoice});
 *  - `rules/aggregate/rule-minmax-index-boundary.ts`, which synthesizes a throwaway
 *    Sort purely to ask this question and commits nothing when the answer is null.
 *
 * Because the last two discard a null answer and carry on, this must stay
 * side-effect-free: it probes `getBestAccessPlan` and either returns a NEW tree or
 * null, never mutating the tree it was handed and never recording anything on
 * `context`. A caller that gets null must be able to discard its probe input and
 * leave the plan untouched.
 *
 * `rowsWanted` is how a caller that already knows the LIMIT tells the module about
 * it: `rule-minmax-index-boundary` for the `LimitOffset(1)` it is about to wrap on,
 * and the LimitOffset visit for a LIMIT and OFFSET the user wrote as plan-time
 * constants. A placeholder LIMIT (`limit ?`) reaches the module as the series of bounds
 * {@link largestOrderedBound} probes, and the plan is chosen at run time.
 */
export function trySortAbsorbViaIndexOrdering(
	sort: SortNode,
	context: OptContext,
	rowsWanted?: RowsWanted,
): PlanNode | null {
	const prepared = prepareSortAbsorb(sort, context);
	if (!prepared) return null;

	const accessPlan = orderedPlanFor(prepared, rowsWanted);
	if (!accessPlan) {
		log('Access plan does not satisfy required ordering; leaving Sort in place');
		return null;
	}
	return buildAbsorbed(prepared, accessPlan);
}

/**
 * Everything a Sort absorb asks the module and rebuilds the tree from, gathered once so
 * the module can be asked repeatedly, with different row bounds, without re-walking the
 * subtree.
 */
interface PreparedSortAbsorb {
	/** Project / Filter / Alias nodes between the Sort and the Retrieve, top first. */
	readonly chain: readonly (ProjectNode | FilterNode | AliasNode)[];
	readonly retrieveNode: RetrieveNode;
	/** The Sort's source: the region between the module's scan and the Sort. */
	readonly subtree: RelationalPlanNode;
	readonly tableSchema: TableSchema;
	/** The limit-free request; a row bound is spread onto it per probe. */
	readonly request: BestAccessPlanRequest;
	/** `request.filters` in planner-side form (see {@link probeAccessPlan}). */
	readonly constraints: readonly PredicateConstraint[];
	readonly requiredOrdering: readonly OrderingSpec[];
	readonly ask: (request: BestAccessPlanRequest) => BestAccessPlanResult;
}

/**
 * Walk down from the Sort to its Retrieve and build the limit-free request, or null when
 * the Sort cannot be absorbed at all: the chain holds a node other than Project / Filter /
 * Alias, the module has no `getBestAccessPlan`, or a sort key is not a plain table column.
 */
function prepareSortAbsorb(sort: SortNode, context: OptContext): PreparedSortAbsorb | null {
	// Walk down through commuting unary operators to find the RetrieveNode.
	const chain: (ProjectNode | FilterNode | AliasNode)[] = [];
	let current: PlanNode = sort.source;
	while (true) {
		if (current instanceof RetrieveNode) break;
		if (current instanceof ProjectNode || current instanceof FilterNode || current instanceof AliasNode) {
			chain.push(current);
			current = current.source;
			continue;
		}
		log('Sort source chain interrupted by unsupported node type %s', current.nodeType);
		return null;
	}
	const retrieveNode = current as RetrieveNode;
	const tableRef = retrieveNode.tableRef;
	if (!tableRef?.tableSchema) return null;
	const vtabModule = tableRef.vtabModule;
	if (!vtabModule?.getBestAccessPlan) return null;

	const requiredOrdering = sortKeysAsTableOrdering(sort, tableRef);
	if (!requiredOrdering) return null;

	// Collect filters anywhere in the subtree below Sort (chain Filters or
	// Filters already pushed into Retrieve.source). The second argument is a display
	// name only — `createTableInfoFromNode` canonicalizes the relation KEY for a
	// TableReferenceNode through `planner/analysis/relation-key.ts` regardless, so this
	// agrees with `createTableInfosFromPlan` by construction.
	const tInfo: TableInfo = createTableInfoFromNode(
		tableRef,
		`${tableRef.tableSchema.schemaName}.${tableRef.tableSchema.name}`
	);
	const constraints = extractConstraintsForTable(sort.source as RelationalPlanNode, tInfo.relationKey);

	const tableSchema = tableRef.tableSchema;
	const request: BestAccessPlanRequest = {
		columns: tableSchema.columns.map((col, index) => ({
			index,
			name: col.name,
			type: col.logicalType,
			isPrimaryKey: col.primaryKey || false,
			isUnique: col.primaryKey || false,
		})),
		filters: constraints,
		requiredOrdering,
		estimatedRows: measuredRows(tableRef),
	};

	return {
		chain,
		retrieveNode,
		subtree: sort.source,
		tableSchema,
		request,
		constraints,
		requiredOrdering,
		ask: req => vtabModule.getBestAccessPlan!(context.db, tableSchema, req) as BestAccessPlanResult,
	};
}

/** The sort keys as table-column ordering, matched by attribute id, or null when one is not a plain table column. */
function sortKeysAsTableOrdering(sort: SortNode, tableRef: TableReferenceNode): OrderingSpec[] | null {
	const tableAttrIndex = tableRef.getAttributeIndex();
	const requiredOrdering: OrderingSpec[] = [];
	for (const key of sort.getSortKeys()) {
		// Explicit NULLS FIRST/LAST is not currently propagated to the access
		// plan — refuse to absorb so the Sort runtime can honor the request.
		if (key.nulls) {
			log('Sort key has explicit NULLS %s; cannot absorb', key.nulls);
			return null;
		}
		if (key.expression.nodeType !== PlanNodeType.ColumnReference) {
			log('Non-trivial sort expression; cannot absorb');
			return null;
		}
		const colRef = key.expression as ColumnReferenceNode;
		const tableColIdx = tableAttrIndex.get(colRef.attributeId) ?? -1;
		if (tableColIdx < 0) {
			log('Sort key not directly mappable to table column; cannot absorb');
			return null;
		}
		requiredOrdering.push({ columnIndex: tableColIdx, desc: key.direction === 'desc' });
	}
	return requiredOrdering;
}

/**
 * Ask the module for the prepared request under `rowsWanted` (absent: limit-free), and
 * return the plan only when it can stand in for the Sort.
 *
 * `probeAccessPlan` sends the bound and re-asks without it if the plan that comes back
 * is not truncation-safe; the region it validates is everything below the Sort, which
 * is exactly what sits between the module's scan and the LimitOffset the caller wraps on.
 *
 * Every requested ordering position must be provided by the SAME column and direction,
 * not merely matched on length: a length-only check would let an ascending
 * providesOrdering of equal length wrongly drop a DESC Sort.
 */
function orderedPlanFor(prepared: PreparedSortAbsorb, rowsWanted?: RowsWanted): BestAccessPlanResult | undefined {
	const request = rowsWanted
		? { ...prepared.request, limit: rowsWanted.limit, offset: rowsWanted.offset }
		: prepared.request;
	const plan = probeAccessPlan(prepared.ask, request, prepared.constraints, prepared.subtree);
	return planDeliversOrdering(prepared.tableSchema, plan, prepared.requiredOrdering, prepared.constraints)
		? plan
		: undefined;
}

/**
 * The Sort's subtree with the Sort dropped and the Retrieve equipped with `accessPlan`,
 * which must be a plan {@link orderedPlanFor} returned for `prepared`.
 */
function buildAbsorbed(prepared: PreparedSortAbsorb, accessPlan: BestAccessPlanResult): RelationalPlanNode {
	const { chain, retrieveNode, constraints } = prepared;

	// Build residual predicate from any constraints the access plan didn't handle.
	// rule-select-access-path's index-style branch trusts moduleCtx.residualPredicate
	// rather than rebuilding from retrieveNode.source, so this must be set.
	const residualPredicate = assembleResidual(undefined, constraints, accessPlan.handledFilters, undefined);

	// Equip the Retrieve with index-style context so rule-select-access-path
	// uses this plan. Existing source pipeline (which may already contain
	// pushed-down filters) is preserved. The dropped Sort makes the plan's
	// ordering load-bearing: the physical leaf's emission order is now the only
	// thing producing the requested ORDER BY, so leaf rewrites that change
	// emission order must see the marker and decline or put that order back.
	const indexCtx: IndexStyleContext = {
		kind: 'index-style',
		accessPlan,
		residualPredicate,
		originalConstraints: [...constraints],
		orderingLoadBearing: true,
	};
	const newRetrieve = retrieveNode.withPipeline(retrieveNode.source, indexCtx, retrieveNode.bindings);

	// Rebuild the chain on top of the equipped Retrieve, dropping the Sort.
	let result: RelationalPlanNode = newRetrieve;
	for (let i = chain.length - 1; i >= 0; i--) {
		const chainNode = chain[i];
		const oldChildren = chainNode.getChildren();
		const newChildren = oldChildren.map((c, idx) => idx === 0 ? result : c);
		result = chainNode.withChildren(newChildren) as RelationalPlanNode;
	}

	log('Absorbed Sort into Retrieve via index ordering for %s', prepared.tableSchema.name);
	return result;
}

/**
 * Absorb the Sort under a user-written LIMIT, telling the module how many rows are
 * wanted, so a backend with expensive row reads can price an ordered seek as the
 * `limit + offset` rows it reads rather than as every row the predicate matches.
 *
 * A LIMIT and OFFSET that are both constants are sent as they are. When either is a
 * placeholder (or any other expression), {@link tryRuntimeLimitChoice} plans both the
 * ordered read and the scan-then-sort and the runtime picks between them.
 *
 * The LimitOffset is never swallowed: it stays above the rebuilt chain and executes
 * there. Only the Sort goes, exactly as on the Sort visit; the bound changes what the
 * module is asked, not what the plan does with the answer.
 *
 * NOTE: this asks `getBestAccessPlan` before the Sort visit could offer a Sort sitting
 * directly on the Retrieve to `supports()`, so a module implementing both now gets the
 * index-style absorb for `order by … limit n` where it used to be asked to take the Sort
 * whole (the Project / Filter / Alias chain case already went this way). No in-tree module
 * implements both; if one does, skip this attempt when the module has `supports()`.
 */
function tryLimitedSortAbsorb(limitNode: LimitOffsetNode, context: OptContext): PlanNode | null {
	if (!limitNode.limit) return null;
	const sort = sortUnderLimit(limitNode.source);
	if (!sort) return null;

	const rowsWanted = constantRowsWanted(limitNode.limit, limitNode.offset);
	const replacement = rowsWanted
		? trySortAbsorbViaIndexOrdering(sort, context, rowsWanted)
		: tryRuntimeLimitChoice(sort, limitNode.limit, limitNode.offset, context);
	if (!replacement) return null;

	log('Absorbed Sort under %s', limitNode.toString());
	const newSource = rebuildChain(limitNode.source, sort, replacement as RelationalPlanNode);
	return limitNode.withChildren([newSource, ...limitNode.getChildren().slice(1)]);
}

/**
 * The LIMIT and OFFSET as plan-time row counts, or `undefined` when either is not a
 * constant. Truncated as the runtime's `toRowCount` does; a negative or NULL constant
 * never gets this far, since `buildRowCountExpression` rejects it at prepare time.
 */
function constantRowsWanted(limitExpr: ScalarPlanNode, offsetExpr: ScalarPlanNode | undefined): RowsWanted | undefined {
	const limit = constantNumber(limitExpr);
	const offset = offsetExpr ? constantNumber(offsetExpr) : 0;
	if (limit === undefined || offset === undefined) return undefined;
	return { limit: Math.trunc(limit), offset: Math.trunc(offset) };
}

/**
 * For a LIMIT whose value is known only at run time: plan both the ordered read and the
 * original Sort, under a {@link LimitChoiceNode} that runs the ordered one when the
 * actual `limit + offset` is at most the largest bound the module still prices it as the
 * cheaper plan for ({@link largestOrderedBound}). Null when there is nothing to choose:
 *
 *  - the limit-free plan already delivers the ordering, so the Sort visit absorbs it
 *    unconditionally (every parity backend lands here, and its plan is unchanged);
 *  - the module prefers scan-then-sort even for one row, e.g. under a filter it cannot
 *    claim, where the ordered read could not stop early anyway.
 *
 * Both branches hold the Sort's subtree (one rebuilt over the equipped Retrieve, one
 * verbatim), so a subtree that is unsafe to hold twice declines ({@link branchesCanShare}).
 * Declining costs only reads: today's scan-then-sort plan stays.
 *
 * NOTE: this file is ~1250 lines. If it grows further, move the sort-absorb group
 * (`trySortAbsorbViaIndexOrdering` through `bisectOrderedBound`) into its own module,
 * taking the probe helpers it shares with the Retrieve growth path (`probeAccessPlan`,
 * `planDeliversOrdering`) into a shared one.
 */
function tryRuntimeLimitChoice(
	sort: SortNode,
	limit: ScalarPlanNode,
	offset: ScalarPlanNode | undefined,
	context: OptContext,
): RelationalPlanNode | null {
	if (!safeToEvaluateTwice(limit) || (offset && !safeToEvaluateTwice(offset))) return null;
	const prepared = prepareSortAbsorb(sort, context);
	if (!prepared || !branchesCanShare(prepared)) return null;

	if (orderedPlanFor(prepared)) return null;
	const bound = largestOrderedBound(prepared);
	if (!bound) {
		log('No row bound makes the ordered read cheaper; keeping scan-then-sort');
		return null;
	}

	log('Planning both branches; ordered when limit + offset <= %d', bound.rows);
	return new LimitChoiceNode(sort.scope, buildAbsorbed(prepared, bound.plan), sort, limit, offset, bound.rows);
}

/**
 * Whether the Sort's subtree may appear in both branches of a {@link LimitChoiceNode}.
 * The branches share its nodes (the verbatim one entirely, the rebuilt one everything but
 * the chain and the Retrieve), so:
 *  - nothing in it may write;
 *  - no scalar in it may hold a subquery, whose body would then hang off a predicate both
 *    branches share;
 *  - no chain node may mint an attribute id (a computed projection): the rebuilt copy
 *    would originate the same id a second time, which the plan validator rejects.
 */
function branchesCanShare(prepared: PreparedSortAbsorb): boolean {
	if (PlanNodeCharacteristics.subtreeHasSideEffects(prepared.subtree)) return false;
	if (subtreeHoldsSubquery(prepared.subtree)) return false;
	return prepared.chain.every(node => {
		const sourceIds = new Set(node.source.getAttributes().map(attr => attr.id));
		return node.getAttributes().every(attr => sourceIds.has(attr.id));
	});
}

/** True when some scalar below `root` has a relational descendant, i.e. holds a subquery. */
function subtreeHoldsSubquery(root: RelationalPlanNode): boolean {
	const stack: PlanNode[] = [root];
	while (stack.length > 0) {
		const node = stack.pop()!;
		for (const child of node.getChildren()) {
			if (isRelationalNode(child)) stack.push(child);
			else if (hasRelationalDescendant(child as ScalarPlanNode)) return true;
		}
	}
	return false;
}

/** Highest bound {@link largestOrderedBound} probes; past it the ordered plan is assumed to hold. */
const ORDERED_BOUND_CAP = 2 ** 30;

/** A row bound and the ordered plan the module returned for it. */
interface OrderedBound {
	readonly rows: number;
	readonly plan: BestAccessPlanResult;
}

/**
 * The largest `limit` (at offset 0) for which the module still answers with a plan that
 * delivers the ordering, with that plan; undefined when even one row does not.
 *
 * Doubles the bound until the ordered plan is lost or {@link ORDERED_BOUND_CAP} is
 * reached, then bisects between the last bound that kept it and the first that lost it.
 * Under the store's pricing the ordered cost rises with the bound and the scan's does
 * not, so the answer is monotone; a module whose answer is not only gets a worse
 * threshold, never a wrong result, because both branches return the same rows.
 *
 * The plan kept is the one at the boundary: below it every ordered plan is cheap, and at
 * it picking the wrong one would cost the most. It is also the licence the emitter keeps:
 * that plan may stop after `rows` rows, so the ordered branch runs only when
 * `limit + offset <= rows`.
 *
 * NOTE: about `2 * log2(rows) + 2` probes — around 40 for a million-row table. If a
 * module's `getBestAccessPlan` is expensive enough to show up at prepare time, memoize
 * per table per pass or stop the bisection early.
 */
function largestOrderedBound(prepared: PreparedSortAbsorb): OrderedBound | undefined {
	const atOne = orderedPlanFor(prepared, { limit: 1, offset: 0 });
	if (!atOne) return undefined;

	let kept: OrderedBound = { rows: 1, plan: atOne };
	let lost: number | undefined;
	while (lost === undefined && kept.rows < ORDERED_BOUND_CAP) {
		const rows = kept.rows * 2;
		const plan = orderedPlanFor(prepared, { limit: rows, offset: 0 });
		if (plan) kept = { rows, plan };
		else lost = rows;
	}
	return lost === undefined ? kept : bisectOrderedBound(prepared, kept, lost);
}

/** Narrow `kept` (delivers the ordering) toward `lost` (does not) until they are adjacent. */
function bisectOrderedBound(prepared: PreparedSortAbsorb, kept: OrderedBound, lost: number): OrderedBound {
	while (lost - kept.rows > 1) {
		const rows = Math.floor((kept.rows + lost) / 2);
		const plan = orderedPlanFor(prepared, { limit: rows, offset: 0 });
		if (plan) kept = { rows, plan };
		else lost = rows;
	}
	return kept;
}

/**
 * The Sort a LIMIT bounds, reached only through nodes that pass every row on unchanged
 * and in order (Project, Alias). A Filter or Distinct between them discards rows AFTER
 * the ordering, so the ordered read would have to run past the limit to fill it; the
 * bound would be wrong to send, and the walk stops there.
 */
function sortUnderLimit(source: RelationalPlanNode): SortNode | undefined {
	let current: RelationalPlanNode = source;
	while (current instanceof ProjectNode || current instanceof AliasNode) {
		current = current.source;
	}
	return current instanceof SortNode ? current : undefined;
}

/**
 * Check whether a scalar residual predicate embeds ANY subquery. Every subquery
 * node (`IN (SELECT …)`, `EXISTS`, scalar subquery, and any future ANY/ALL/row
 * variant) hangs a RelationalPlanNode — with its own RetrieveNode — beneath a scalar
 * predicate, so "contains a relational descendant" is exactly "contains a subquery".
 * Detecting it structurally rather than by node class keeps this robust as new
 * subquery node types are added. Such a residual must stay in the region the
 * bottom-up physical pass covers, whether or not the subquery is correlated: a
 * self-contained subquery buries an unphysicalized Retrieve just the same as a
 * correlated one.
 */
function predicateContainsSubquery(expr: PlanNode): boolean {
	for (const child of expr.getChildren()) {
		if (isRelationalNode(child) || predicateContainsSubquery(child)) {
			return true;
		}
	}
	return false;
}
