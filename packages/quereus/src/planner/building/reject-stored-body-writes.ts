import type { PlanNode } from '../nodes/plan-node.js';
import { DML_NODE_TYPES } from '../nodes/plan-node-type.js';
import type { InsertNode } from '../nodes/insert-node.js';
import type { UpdateNode } from '../nodes/update-node.js';
import type { DeleteNode } from '../nodes/delete-node.js';
import { DmlExecutorNode } from '../nodes/dml-executor-node.js';
import { quereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

/** The objects whose body Quereus stores and evaluates again on every reference. */
export type StoredBodyKind = 'view' | 'materialized view' | 'maintained table' | 'assertion';

type DmlPlanNode = InsertNode | UpdateNode | DeleteNode | DmlExecutorNode;

function isDmlPlanNode(node: PlanNode): node is DmlPlanNode {
	return DML_NODE_TYPES.has(node.nodeType);
}

/**
 * Refuses a stored body whose plan contains a base-table write at any depth — a
 * `from` source, a scalar / `exists` / `in` subquery, a compound arm, or a write
 * through a view (whose `ViewMutation` node wraps base-table DML). Every evaluation
 * of the stored object would re-drive that write.
 *
 * Reads plan node types, not `physical.readonly`: a call to a function registered
 * with side effects is the supported way to give a stored body an effect, and must
 * stay accepted.
 *
 * Sited on the plan rather than the syntax tree because every builder position that
 * admits nested DML funnels into the insert / update / delete builders, which always
 * produce one of {@link DML_NODE_TYPES}; a nesting position added later is covered
 * without touching this check.
 */
export function rejectStoredBodyWrites(plan: PlanNode, kind: StoredBodyKind, name: string): void {
	// Iterative worklist, as in `PlanNodeCharacteristics.subtreeHasSideEffects`, so a
	// deep body cannot overflow the native call stack. `seen` because the plan is a
	// DAG: every reference to a CTE shares that CTE's subtree, so a chain of CTEs each
	// reading the previous one twice would otherwise be walked 2^depth times.
	const stack: PlanNode[] = [plan];
	const seen = new Set<PlanNode>();
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (seen.has(node)) continue;
		seen.add(node);
		if (isDmlPlanNode(node)) {
			throwStoredBodyWrite(node, kind, name);
		}
		stack.push(...node.getChildren());
	}
}

function throwStoredBodyWrite(node: DmlPlanNode, kind: StoredBodyKind, name: string): never {
	const verb = (node instanceof DmlExecutorNode ? node.operation : node.nodeType).toUpperCase();
	const article = verb === 'DELETE' ? 'a' : 'an';
	const subject = kind.charAt(0).toUpperCase() + kind.slice(1);
	quereusError(
		`${subject} '${name}' body contains ${article} ${verb} on '${node.table.tableSchema.name}' — ${redriveAdvice(kind)}, or call a function registered with side effects if the write is intended.`,
		StatusCode.ERROR,
	);
}

/** Nothing "uses" an assertion — it runs at commit — so it gets its own reason and remedy. */
function redriveAdvice(kind: StoredBodyKind): string {
	return kind === 'assertion'
		? 'an assertion is re-evaluated at commit, which would re-drive the write. Move the mutation into the statement that changes the data'
		: `a stored body is re-evaluated on every reference, which would re-drive the write. Move the mutation into the statement that uses this ${kind}`;
}
