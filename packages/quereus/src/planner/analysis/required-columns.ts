/**
 * Required-column analysis: for every table scan in a finished plan, the table columns
 * the plan reads from the rows that scan emits. Delivered to the module as
 * `FilterInfo.requiredColumns` (see `vtab/filter-info.ts` and docs/module-authoring.md
 * § "Required columns"), so a column store can skip assembling the rest.
 *
 * A column is read when either
 *  - some `ColumnReferenceNode` anywhere in the plan names its attribute — a projection,
 *    an unclaimed residual filter, a join condition, a sort key, an aggregate argument,
 *    a correlated reference from a subquery; or
 *  - an operator consumes whole rows of a relation that carries it (`distinct`, a set
 *    operation, a DML statement, the statement's own result, or any operator this file
 *    does not model).
 *
 * Attribute ids are unique to the relation that mints them and are carried unchanged by
 * operators that pass a column through, so one plan-wide set of referenced ids answers
 * the first question for every scan at once, in any traversal order — a correlated
 * reference from a later sibling counts the same as one from an ancestor. The second is a
 * top-down walk that marks a relation "read whole" and pushes the mark down only through
 * the operators listed in {@link childDemands}, which emit their inputs' rows unchanged;
 * every other operator marks all of its relational inputs read whole. That default is
 * what keeps the analysis sound when an operator is added without updating this file.
 *
 * Every expression an operator evaluates is one of its children (OPT-009 in
 * docs/invariants.md), so walking `getChildren()` reaches every reference. A scan this
 * walk never reaches is left unstamped, which means "every column".
 */

import type { PlanNode } from '../nodes/plan-node.js';
import { isRelationalNode } from '../nodes/plan-node.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import { TableAccessNode, EmptyResultNode } from '../nodes/table-access-nodes.js';
import { FilterNode } from '../nodes/filter.js';
import { SortNode } from '../nodes/sort.js';
import { LimitOffsetNode } from '../nodes/limit-offset.js';
import { AliasNode } from '../nodes/alias-node.js';
import { CacheNode } from '../nodes/cache-node.js';
import { ProjectNode } from '../nodes/project-node.js';
import { AggregateNode } from '../nodes/aggregate-node.js';
import { StreamAggregateNode } from '../nodes/stream-aggregate.js';
import { HashAggregateNode } from '../nodes/hash-aggregate.js';
import { JoinNode } from '../nodes/join-node.js';
import { BloomJoinNode } from '../nodes/bloom-join-node.js';
import { MergeJoinNode } from '../nodes/merge-join-node.js';
import type { EquiJoinPair } from '../nodes/join-utils.js';

/** One child of a node and whether the node consumes that child's rows whole. */
type ChildDemand = readonly [child: PlanNode, wholeRow: boolean];

/**
 * Every scan the walk reaches in `root`, mapped to the column indexes the plan reads
 * from it — or to undefined when it reads every column, because an operator consumes its
 * rows whole or because every column is referenced. A scan the walk never reaches is
 * not in the map, and reads every column too.
 *
 * The answer is relative to `root` being the whole statement: run a subtree on its own
 * and its output becomes a reader, so recompute from that subtree first.
 */
export function computeRequiredColumns(root: PlanNode): Map<TableAccessNode, ReadonlySet<number> | undefined> {
	const { referencedAttrIds, scans } = walkPlan(root);
	const result = new Map<TableAccessNode, ReadonlySet<number> | undefined>();
	for (const [scan, wholeRow] of scans) {
		result.set(scan, wholeRow ? undefined : readColumnsOf(scan, referencedAttrIds));
	}
	return result;
}

/**
 * `root` with every scan's `FilterInfo.requiredColumns` set to what
 * {@link computeRequiredColumns} says of it — added, changed, or removed — so stamping a
 * plan that was already stamped against a different root (a subtree about to run on its
 * own) leaves no stale, too-narrow set behind. Run on the finished plan by the
 * `required-columns` optimizer pass; returns `root` itself when no stamp changes.
 *
 * Only the nodes on a path to a changed scan are re-minted, each once — a subtree shared
 * by several parents (a CTE body) stays shared. Iterative post-order so a deep plan
 * cannot overflow the native stack.
 */
export function stampRequiredColumns(root: PlanNode): PlanNode {
	const required = computeRequiredColumns(root);
	for (const [scan, columns] of required) {
		if (sameColumns(scan.filterInfo.requiredColumns, columns)) required.delete(scan);
	}
	if (required.size === 0) return root;

	const rebuilt = new Map<PlanNode, PlanNode>();
	const stack: Array<{ node: PlanNode; expanded: boolean }> = [{ node: root, expanded: false }];
	while (stack.length > 0) {
		const top = stack[stack.length - 1];
		if (rebuilt.has(top.node)) {
			stack.pop();
			continue;
		}
		const children = top.node.getChildren();
		if (!top.expanded) {
			top.expanded = true;
			for (const child of children) {
				if (!rebuilt.has(child)) stack.push({ node: child, expanded: false });
			}
			continue;
		}
		stack.pop();
		rebuilt.set(top.node, rebuildNode(top.node, children, rebuilt, required));
	}
	return rebuilt.get(root)!;
}

function rebuildNode(
	node: PlanNode,
	children: readonly PlanNode[],
	rebuilt: ReadonlyMap<PlanNode, PlanNode>,
	restamp: ReadonlyMap<TableAccessNode, ReadonlySet<number> | undefined>,
): PlanNode {
	const newChildren = children.map(child => rebuilt.get(child) ?? child);
	const withNewChildren = newChildren.some((child, i) => child !== children[i])
		? node.withChildren(newChildren)
		: node;
	// A seek key can hold a subquery whose own scan was stamped, so the scan's children
	// are rebuilt first and the stamp lands on the rebuilt node.
	if (node instanceof TableAccessNode && restamp.has(node) && withNewChildren instanceof TableAccessNode) {
		return withNewChildren.withRequiredColumns(restamp.get(node));
	}
	return withNewChildren;
}

function sameColumns(a: ReadonlySet<number> | undefined, b: ReadonlySet<number> | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	return a.size === b.size && [...a].every(column => b.has(column));
}

/**
 * The column indexes of `scan` named in `referencedAttrIds`, or undefined when that is
 * every column (nothing to narrow) or the scan's attributes do not line up one-to-one
 * with its table's columns (nothing safe to say).
 */
function readColumnsOf(scan: TableAccessNode, referencedAttrIds: ReadonlySet<number>): ReadonlySet<number> | undefined {
	const attrs = scan.getAttributes();
	if (attrs.length !== scan.tableSchema.columns.length) return undefined;
	const columns = new Set<number>();
	attrs.forEach((attr, index) => {
		if (referencedAttrIds.has(attr.id)) columns.add(index);
	});
	return columns.size === attrs.length ? undefined : columns;
}

/**
 * One pass over the plan: every attribute id a column reference names, and every scan
 * reached together with whether some consumer reads its rows whole.
 *
 * A node is processed at most twice — once read partially, once read whole — because
 * reaching it read whole can only add demands on its children. Iterative so a deep plan
 * cannot overflow the native stack.
 */
function walkPlan(root: PlanNode): { referencedAttrIds: Set<number>; scans: Map<TableAccessNode, boolean> } {
	const referencedAttrIds = new Set<number>();
	const scans = new Map<TableAccessNode, boolean>();
	const reachedWhole = new Map<PlanNode, boolean>();
	// The statement's own result is consumed whole.
	const stack: ChildDemand[] = [[root, true]];

	while (stack.length > 0) {
		const [node, wholeRow] = stack.pop()!;
		const prior = reachedWhole.get(node);
		if (prior === true || (prior === false && !wholeRow)) continue;
		reachedWhole.set(node, wholeRow);

		if (node instanceof ColumnReferenceNode) {
			referencedAttrIds.add(node.attributeId);
			continue;
		}
		if (node instanceof TableAccessNode) {
			if (!(node instanceof EmptyResultNode)) scans.set(node, wholeRow);
			// The scan's own child is its table reference; its other children are seek
			// keys, whose references belong to the outer rows they read.
			for (const child of node.getChildren()) {
				if (child !== node.source) stack.push([child, false]);
			}
			continue;
		}
		for (const demand of childDemands(node, wholeRow)) stack.push(demand);
	}

	return { referencedAttrIds, scans };

	function childDemands(node: PlanNode, wholeRow: boolean): ChildDemand[] {
		// Operators that emit their input rows unchanged: their inputs are read whole
		// exactly when they are.
		if (node instanceof FilterNode || node instanceof SortNode || node instanceof LimitOffsetNode
			|| node instanceof AliasNode || node instanceof CacheNode) {
			return scalarsAndRelations(node, () => wholeRow);
		}
		// Operators that read their input only through expressions — all of which are
		// children, so their references are collected as the walk descends.
		if (node instanceof ProjectNode || node instanceof AggregateNode
			|| node instanceof StreamAggregateNode || node instanceof HashAggregateNode) {
			return scalarsAndRelations(node, () => false);
		}
		// A join emits left ++ right (left only for semi/anti), so each emitted side is
		// read whole exactly when the join is. The hash and merge variants also read their
		// equi-join keys by attribute id rather than through an expression child.
		if (node instanceof JoinNode || node instanceof BloomJoinNode || node instanceof MergeJoinNode) {
			if (!(node instanceof JoinNode)) addEquiPairAttrIds(node.equiPairs);
			const emitsRight = node.joinType !== 'semi' && node.joinType !== 'anti';
			return scalarsAndRelations(node, child => wholeRow && (child === node.left || emitsRight));
		}
		// Anything else — a scalar operator over a subquery, a DML statement, a set
		// operation, distinct, a window, or an operator added after this file — reads
		// every relational input whole.
		return scalarsAndRelations(node, () => true);
	}

	function addEquiPairAttrIds(pairs: readonly EquiJoinPair[]): void {
		for (const pair of pairs) {
			referencedAttrIds.add(pair.leftAttrId);
			referencedAttrIds.add(pair.rightAttrId);
		}
	}
}

/**
 * Every child of `node` — expression children read partially (their references are what
 * counts), relational children read whole as `relationWhole` decides. `getRelations()` is
 * included because it is not always a subset of `getChildren()`.
 */
function scalarsAndRelations(node: PlanNode, relationWhole: (child: PlanNode) => boolean): ChildDemand[] {
	const demands: ChildDemand[] = [];
	for (const child of node.getChildren()) {
		demands.push([child, isRelationalNode(child) && relationWhole(child)]);
	}
	if (isRelationalNode(node)) {
		for (const relation of node.getRelations()) {
			demands.push([relation, relationWhole(relation)]);
		}
	}
	return demands;
}
