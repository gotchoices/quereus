/**
 * Shared helpers for rules that recognize and rewrite `ScalarSubqueryNode`s
 * embedded in projection scalar expression trees (`rule-fanout-lookup-join`,
 * `rule-scalar-agg-decorrelation`).
 */

import type { PlanNode, ScalarPlanNode } from '../nodes/plan-node.js';
import { ScalarSubqueryNode } from '../nodes/subquery.js';

/**
 * Collect every `ScalarSubqueryNode` reachable in a projection's scalar
 * expression tree, in deterministic pre-order. A recognized subquery is a leaf
 * for this walk: we push it and do NOT descend into its relational body, so a
 * subquery nested *inside* another subquery's correlation predicate remains part
 * of its enclosing branch child rather than being collected separately.
 * (The relational body is filtered out by the `typeClass === 'scalar'` guard
 * regardless, but stopping early keeps the intent explicit.)
 */
export function collectScalarSubqueries(expr: ScalarPlanNode, out: ScalarSubqueryNode[]): void {
	if (expr instanceof ScalarSubqueryNode) {
		out.push(expr);
		return;
	}
	for (const child of expr.getChildren()) {
		if (child.getType().typeClass === 'scalar') {
			collectScalarSubqueries(child as ScalarPlanNode, out);
		}
	}
}

/**
 * Rebuild a projection's scalar expression with each recognized
 * `ScalarSubqueryNode` replaced by its substitute expression, leaving the
 * wrapping expression (`coalesce(<substitute>, 0)`) intact. For a bare-subquery
 * projection the root itself is in the map and is returned directly; for a
 * wrapped subquery the tree is rebuilt via `withChildren` with only the matched
 * inner node substituted. Returns the input unchanged when no descendant is a
 * recognized subquery.
 */
export function substituteSubqueries(
	expr: ScalarPlanNode,
	replacements: ReadonlyMap<ScalarSubqueryNode, ScalarPlanNode>,
): ScalarPlanNode {
	if (expr instanceof ScalarSubqueryNode) {
		return replacements.get(expr) ?? expr;
	}
	const children = expr.getChildren();
	if (children.length === 0) return expr;

	const newChildren: PlanNode[] = [];
	let changed = false;
	for (const child of children) {
		if (child.getType().typeClass === 'scalar') {
			const replaced = substituteSubqueries(child as ScalarPlanNode, replacements);
			newChildren.push(replaced);
			if (replaced !== child) changed = true;
		} else {
			newChildren.push(child);
		}
	}
	if (!changed) return expr;
	return expr.withChildren(newChildren) as ScalarPlanNode;
}
