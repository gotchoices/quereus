import type { PlanNode } from '../nodes/plan-node.js';
import { DML_NODE_TYPES } from '../nodes/plan-node-type.js';
import type { InsertNode } from '../nodes/insert-node.js';
import type { UpdateNode } from '../nodes/update-node.js';
import type { DeleteNode } from '../nodes/delete-node.js';
import type { DmlExecutorNode } from '../nodes/dml-executor-node.js';

/** A plan node that performs a base-table write — one of {@link DML_NODE_TYPES}. */
export type DmlPlanNode = InsertNode | UpdateNode | DeleteNode | DmlExecutorNode;

export function isDmlPlanNode(node: PlanNode): node is DmlPlanNode {
	return DML_NODE_TYPES.has(node.nodeType);
}

/**
 * The first base-table write found anywhere in `plan` — a `from` source, a scalar /
 * `exists` / `in` subquery, a compound arm, a `returning` source, a data-modifying CTE,
 * or a write through a view (whose `ViewMutation` node wraps base-table DML) — or
 * `undefined` for a plan that writes nothing.
 *
 * Reads plan node types, not `physical.readonly`: a call to a function registered with
 * side effects is not a write.
 */
export function findPlanWrite(plan: PlanNode): DmlPlanNode | undefined {
	// Iterative worklist, as in `PlanNodeCharacteristics.subtreeHasSideEffects`, so a
	// deep plan cannot overflow the native call stack. `seen` because the plan is a
	// DAG: every reference to a CTE shares that CTE's subtree, so a chain of CTEs each
	// reading the previous one twice would otherwise be walked 2^depth times.
	const stack: PlanNode[] = [plan];
	const seen = new Set<PlanNode>();
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (seen.has(node)) continue;
		seen.add(node);
		if (isDmlPlanNode(node)) return node;
		stack.push(...node.getChildren());
	}
	return undefined;
}
