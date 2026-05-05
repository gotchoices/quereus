/**
 * Rule: Filter Merge
 *
 * Merges adjacent Filter nodes into a single Filter with an AND-combined predicate.
 *
 * Filter(pred_outer) → Filter(pred_inner) → source
 * becomes:
 * Filter(pred_outer AND pred_inner) → source
 *
 * Always safe: the conjunction is semantically identical.
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { PlanNodeType } from '../../nodes/plan-node-type.js';
import { FilterNode } from '../../nodes/filter.js';
import { BinaryOpNode } from '../../nodes/scalar.js';
import type * as AST from '../../../parser/ast.js';

const log = createLogger('optimizer:rule:filter-merge');

export function ruleFilterMerge(node: PlanNode, _context: OptContext): PlanNode | null {
	if (node.nodeType !== PlanNodeType.Filter) return null;
	let current = node as FilterNode;

	if (current.source.nodeType !== PlanNodeType.Filter) return null;

	// Iteratively absorb all adjacent filters (handles triple+ stacks in one visit)
	let predicate = current.predicate;
	while (current.source.nodeType === PlanNodeType.Filter) {
		const inner = current.source as FilterNode;
		const ast: AST.BinaryExpr = {
			type: 'binary',
			operator: 'AND',
			left: predicate.expression,
			right: inner.predicate.expression,
		};
		predicate = new BinaryOpNode(current.scope, ast, predicate, inner.predicate);
		current = inner;
	}

	log('Merged adjacent filters into single AND predicate');
	return new FilterNode((node as FilterNode).scope, current.source, predicate);
}
