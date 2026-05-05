/**
 * Rule: Subquery Decorrelation
 *
 * Transforms correlated EXISTS and IN subqueries in WHERE-clause FilterNode
 * predicates into equivalent semi/anti joins, enabling hash join selection
 * and eliminating per-row re-execution of the inner query.
 *
 * Transformations:
 *   Filter[EXISTS(correlated)](outer)  →  SemiJoin[corr_pred](outer, inner)
 *   Filter[NOT EXISTS(correlated)](outer) → AntiJoin[corr_pred](outer, inner)
 *   Filter[col IN (correlated subquery)](outer) → SemiJoin[col = inner.col](outer, inner)
 *
 * Applicability:
 * - FilterNode with top-level ExistsNode, NOT ExistsNode, or InNode (subquery variant)
 * - Subquery is correlated (references outer attributes)
 * - Correlation predicate is a simple equi-join condition (col = col across inner/outer)
 *
 * NOT IN is deferred due to NULL semantics complexity.
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, ScalarPlanNode, RelationalPlanNode } from '../../nodes/plan-node.js';
import { isRelationalNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { FilterNode } from '../../nodes/filter.js';
import { JoinNode, type JoinType } from '../../nodes/join-node.js';
import { ExistsNode, InNode } from '../../nodes/subquery.js';
import { UnaryOpNode } from '../../nodes/scalar.js';
import { BinaryOpNode } from '../../nodes/scalar.js';
import { ColumnReferenceNode } from '../../nodes/reference.js';
import { isCorrelatedSubquery } from '../../cache/correlation-detector.js';
import { PlanNodeType } from '../../nodes/plan-node-type.js';

const log = createLogger('optimizer:rule:subquery-decorrelation');

interface DecorrelationCandidate {
	/** The EXISTS/IN node (or NOT EXISTS) */
	subqueryNode: ExistsNode | InNode;
	/** 'semi' or 'anti' */
	joinType: JoinType;
	/** The scalar node in the filter predicate that matched (ExistsNode, UnaryOpNode wrapping ExistsNode, or InNode) */
	predicateNode: ScalarPlanNode;
}

/**
 * Split an AND-tree into conjuncts.
 */
function splitConjuncts(pred: ScalarPlanNode): ScalarPlanNode[] {
	const result: ScalarPlanNode[] = [];
	const stack: ScalarPlanNode[] = [pred];
	while (stack.length) {
		const n = stack.pop()!;
		if (n instanceof BinaryOpNode && n.expression.operator === 'AND') {
			stack.push(n.left, n.right);
		} else {
			result.push(n);
		}
	}
	return result;
}

/**
 * Combine conjuncts back into an AND-tree.
 */
function combineConjuncts(conjuncts: ScalarPlanNode[]): ScalarPlanNode | null {
	if (conjuncts.length === 0) return null;
	return conjuncts.reduce((acc, cur) =>
		new BinaryOpNode(
			cur.scope,
			{ type: 'binary', operator: 'AND', left: acc.expression, right: cur.expression },
			acc,
			cur
		)
	);
}

/**
 * Identify a decorrelation candidate from a single conjunct.
 */
function identifyCandidate(node: ScalarPlanNode): DecorrelationCandidate | null {
	// EXISTS(subquery)
	if (node instanceof ExistsNode) {
		if (isCorrelatedSubquery(node.subquery)) {
			return { subqueryNode: node, joinType: 'semi', predicateNode: node };
		}
		return null;
	}

	// NOT EXISTS(subquery)
	if (node instanceof UnaryOpNode && node.expression.operator === 'NOT') {
		if (node.operand instanceof ExistsNode) {
			const exists = node.operand;
			if (isCorrelatedSubquery(exists.subquery)) {
				return { subqueryNode: exists, joinType: 'anti', predicateNode: node };
			}
		}
		return null;
	}

	// col IN (correlated subquery)
	if (node instanceof InNode && node.source && !node.values) {
		if (isCorrelatedSubquery(node.source)) {
			return { subqueryNode: node, joinType: 'semi', predicateNode: node };
		}
		return null;
	}

	return null;
}

/**
 * Collect attribute IDs defined by a relational subtree.
 */
function collectDefinedAttrIds(node: PlanNode): Set<number> {
	const ids = new Set<number>();
	function walk(n: PlanNode): void {
		if (isRelationalNode(n)) {
			for (const attr of n.getAttributes()) {
				ids.add(attr.id);
			}
		}
		for (const child of n.getChildren()) {
			walk(child);
		}
	}
	walk(node);
	return ids;
}

/**
 * Returns true if the plan tree contains any column reference to an
 * attribute id in `attrIds`. Used to detect leftover correlation in
 * residual inner-only predicates (which may include nested subqueries).
 */
function referencesAnyAttr(node: PlanNode, attrIds: Set<number>): boolean {
	if (node instanceof ColumnReferenceNode && attrIds.has(node.attributeId)) {
		return true;
	}
	for (const child of node.getChildren()) {
		if (referencesAnyAttr(child, attrIds)) return true;
	}
	return false;
}

/**
 * For an EXISTS subquery, extract the inner relational source and separate
 * the correlation predicate from inner-only predicates.
 *
 * The subquery tree is typically:
 *   Project → Filter[mixed_predicates] → inner_scan
 * or just:
 *   Filter[mixed_predicates] → inner_scan
 * or the predicates may be pushed into a Retrieve.
 *
 * We walk down through Project nodes (which don't affect the relational shape
 * for EXISTS) and look for FilterNode(s) that contain correlation conditions.
 */
function extractExistsCorrelation(
	subqueryRoot: RelationalPlanNode,
	outerAttrIds: Set<number>
): {
	innerSource: RelationalPlanNode;
	correlationCondition: ScalarPlanNode;
	residualInnerFilter: ScalarPlanNode | null;
} | null {
	// Walk through Project nodes to find the core relation
	let current: RelationalPlanNode = subqueryRoot;

	// Skip Project and Alias nodes (EXISTS doesn't care about projection or aliasing)
	while (current.nodeType === PlanNodeType.Project || current.nodeType === PlanNodeType.Alias) {
		const children = current.getChildren();
		const source = children[0];
		if (!isRelationalNode(source)) break;
		current = source;
	}

	// Now we expect a FilterNode with the correlation condition
	if (!(current instanceof FilterNode)) {
		// No filter found — correlation may be embedded deeper (not a simple pattern)
		return null;
	}

	const filter = current;
	const innerSource = filter.source;
	const innerAttrIds = collectDefinedAttrIds(innerSource);

	// Split predicate into conjuncts and classify each
	const conjuncts = splitConjuncts(filter.predicate);
	const correlationConjuncts: ScalarPlanNode[] = [];
	const innerOnlyConjuncts: ScalarPlanNode[] = [];

	for (const conj of conjuncts) {
		if (isEquiCorrelation(conj, outerAttrIds, innerAttrIds)) {
			correlationConjuncts.push(conj);
		} else {
			innerOnlyConjuncts.push(conj);
		}
	}

	if (correlationConjuncts.length === 0) {
		// No simple equi-correlation found
		return null;
	}

	// Safety: residual inner-only conjuncts must not still reference outer
	// attributes. If they do (e.g. a correlated predicate that didn't match
	// the strict equi-pattern, such as `outer.x = cast(inner.y as real)` or
	// `outer.x > inner.y`), decorrelation cannot be safely applied without
	// preserving the correlation, so abort.
	for (const conj of innerOnlyConjuncts) {
		if (referencesAnyAttr(conj, outerAttrIds)) return null;
	}

	const correlationCondition = combineConjuncts(correlationConjuncts)!;
	const residualInnerFilter = combineConjuncts(innerOnlyConjuncts);

	return { innerSource, correlationCondition, residualInnerFilter };
}

/**
 * Check if a scalar node is a simple equi-join between outer and inner attributes.
 * Matches: outer.col = inner.col (or inner.col = outer.col)
 */
function isEquiCorrelation(
	node: ScalarPlanNode,
	outerAttrIds: Set<number>,
	innerAttrIds: Set<number>
): boolean {
	if (!(node instanceof BinaryOpNode)) return false;
	if (node.expression.operator !== '=') return false;
	if (!(node.left instanceof ColumnReferenceNode) || !(node.right instanceof ColumnReferenceNode)) return false;

	const leftId = node.left.attributeId;
	const rightId = node.right.attributeId;

	return (outerAttrIds.has(leftId) && innerAttrIds.has(rightId)) ||
		   (outerAttrIds.has(rightId) && innerAttrIds.has(leftId));
}

/**
 * For an IN subquery, extract the inner relational source and build the
 * equi-join condition (outer.col = inner.firstCol) plus any existing
 * correlation conditions within the subquery.
 */
function extractInCorrelation(
	inNode: InNode,
	outerAttrIds: Set<number>
): {
	innerSource: RelationalPlanNode;
	correlationCondition: ScalarPlanNode;
	residualInnerFilter: ScalarPlanNode | null;
} | null {
	if (!inNode.source) return null;

	// The IN condition references outer.col = inner.firstColumn
	// The IN subquery source may itself have correlated filters
	const subqueryRoot = inNode.source;

	// The left side of IN must be a column reference from the outer
	if (!(inNode.condition instanceof ColumnReferenceNode)) {
		// Non-column IN conditions are more complex; skip for now
		return null;
	}

	const outerColRef = inNode.condition;
	if (!outerAttrIds.has(outerColRef.attributeId)) {
		// The left side of IN doesn't reference the outer — unusual, skip
		return null;
	}

	// The inner subquery's first column is the comparison target
	const innerAttrs = subqueryRoot.getAttributes();
	if (innerAttrs.length === 0) return null;
	const innerFirstAttr = innerAttrs[0];

	// Build the equi-join condition: outer.col = inner.firstCol
	// We need a BinaryOpNode with = between the outer column ref and an inner column ref
	const innerColRef = new ColumnReferenceNode(
		outerColRef.scope,
		outerColRef.expression,  // reuse expression for formatting
		innerFirstAttr.type,
		innerFirstAttr.id,
		0 // column index in the inner relation
	);

	const equiCondition = new BinaryOpNode(
		outerColRef.scope,
		{ type: 'binary', operator: '=', left: outerColRef.expression, right: innerColRef.expression },
		outerColRef,
		innerColRef
	);

	// Walk through the subquery to find any additional correlation filters
	let current: RelationalPlanNode = subqueryRoot;

	// Skip Project and Alias nodes
	while (current.nodeType === PlanNodeType.Project || current.nodeType === PlanNodeType.Alias) {
		const children = current.getChildren();
		const source = children[0];
		if (!isRelationalNode(source)) break;
		current = source;
	}

	// If there's a filter with additional correlation, extract it
	if (current instanceof FilterNode) {
		const innerAttrIds = collectDefinedAttrIds(current.source);
		const conjuncts = splitConjuncts(current.predicate);
		const additionalCorrelation: ScalarPlanNode[] = [];
		const innerOnly: ScalarPlanNode[] = [];

		for (const conj of conjuncts) {
			if (isEquiCorrelation(conj, outerAttrIds, innerAttrIds)) {
				additionalCorrelation.push(conj);
			} else {
				innerOnly.push(conj);
			}
		}

		// Safety: residual inner-only conjuncts must not still reference outer
		// attributes. See note in extractExistsCorrelation.
		for (const conj of innerOnly) {
			if (referencesAnyAttr(conj, outerAttrIds)) return null;
		}

		const allCorrelation = [equiCondition, ...additionalCorrelation];
		const correlationCondition = combineConjuncts(allCorrelation)!;
		const residualInnerFilter = combineConjuncts(innerOnly);

		return {
			innerSource: current.source,
			correlationCondition,
			residualInnerFilter,
		};
	}

	// No inner filter — the only correlation is the IN condition itself
	return {
		innerSource: current,
		correlationCondition: equiCondition,
		residualInnerFilter: null,
	};
}

export function ruleSubqueryDecorrelation(node: PlanNode, _context: OptContext): PlanNode | null {
	if (!(node instanceof FilterNode)) return null;

	const outerSource = node.source;
	const outerAttrIds = new Set(outerSource.getAttributes().map(a => a.id));

	// Split the filter predicate into conjuncts
	const conjuncts = splitConjuncts(node.predicate);

	// Find the first decorrelation candidate
	let candidateIndex = -1;
	let candidate: DecorrelationCandidate | null = null;

	for (let i = 0; i < conjuncts.length; i++) {
		candidate = identifyCandidate(conjuncts[i]);
		if (candidate) {
			candidateIndex = i;
			break;
		}
	}

	if (!candidate || candidateIndex === -1) return null;

	log('Found %s decorrelation candidate in filter predicate', candidate.joinType);

	// Extract correlation info based on subquery type
	let extraction: {
		innerSource: RelationalPlanNode;
		correlationCondition: ScalarPlanNode;
		residualInnerFilter: ScalarPlanNode | null;
	} | null = null;

	if (candidate.subqueryNode instanceof ExistsNode) {
		extraction = extractExistsCorrelation(candidate.subqueryNode.subquery, outerAttrIds);
	} else if (candidate.subqueryNode instanceof InNode) {
		extraction = extractInCorrelation(candidate.subqueryNode, outerAttrIds);
	}

	if (!extraction) {
		log('Could not extract simple equi-correlation; skipping decorrelation');
		return null;
	}

	const { innerSource, correlationCondition, residualInnerFilter } = extraction;

	// Build the inner side: if there are residual inner-only predicates, wrap in FilterNode
	let joinRight: RelationalPlanNode = innerSource;
	if (residualInnerFilter) {
		joinRight = new FilterNode(innerSource.scope, innerSource, residualInnerFilter);
	}

	// Build the semi/anti join
	const joinNode = new JoinNode(
		outerSource.scope,
		outerSource,
		joinRight,
		candidate.joinType,
		correlationCondition
	);

	log('Decorrelated %s subquery into %s JOIN', candidate.subqueryNode.nodeType, candidate.joinType.toUpperCase());

	// If there are remaining conjuncts in the original filter, wrap in a new FilterNode
	const remainingConjuncts = conjuncts.filter((_, i) => i !== candidateIndex);
	if (remainingConjuncts.length > 0) {
		const residualPredicate = combineConjuncts(remainingConjuncts)!;
		return new FilterNode(node.scope, joinNode, residualPredicate);
	}

	return joinNode;
}
