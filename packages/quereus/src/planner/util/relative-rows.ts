/**
 * A join side's row count for RELATIVE comparison — defined even where nobody
 * measured anything.
 *
 * A never-analyzed table's scan reports `undefined` (see `row-estimates.ts`), and
 * that blank propagates: a Filter over it, a join over that, an aggregate over the
 * join all read `undefined` too, so a consumer that defaults the blank side flat
 * forgets that a filter has already narrowed it. This walker instead starts the
 * unknown LEAF at the shared no-statistics default and carries that figure up
 * through each operator with the operator's own shared formula, so a filtered
 * side of an unknown table compares smaller than the unfiltered table beside it.
 *
 * The figure is relative, not an estimate the plan records: only join selection
 * reads it, to compare candidates against each other. Everywhere else an unknown
 * stays `undefined`, so the gates that deliberately refuse on unknown keep
 * refusing.
 *
 * Lives apart from `row-estimates.ts` because it dispatches on node classes, and
 * those node modules import `row-estimates.ts`.
 */

import type { RelationalPlanNode } from '../nodes/plan-node.js';
import { DEFAULT_FILTER_SELECTIVITY, FilterNode } from '../nodes/filter.js';
import { JoinNode } from '../nodes/join-node.js';
import { BloomJoinNode } from '../nodes/bloom-join-node.js';
import { MergeJoinNode } from '../nodes/merge-join-node.js';
import { AggregateNode } from '../nodes/aggregate-node.js';
import { HashAggregateNode } from '../nodes/hash-aggregate.js';
import { StreamAggregateNode } from '../nodes/stream-aggregate.js';
import { joinPhysicalRows } from '../nodes/join-utils.js';
import { costedRows, filterRowsFrom, physicalSourceRows } from './row-estimates.js';

/**
 * Rows `side` is priced at in a relative comparison: its physical estimate when
 * known, else `unknownLeafRows` at each unknown leaf carried up through the
 * side's operators. Floored at one row through `costedRows`, so a measured (or
 * relayed) 0 prices the way every cost site prices it.
 */
export function relativeRows(side: RelationalPlanNode, unknownLeafRows: number): number {
	return costedRows(relayedRows(side, unknownLeafRows), unknownLeafRows);
}

function relayedRows(node: RelationalPlanNode, unknownLeafRows: number): number {
	const known = physicalSourceRows(node.physical, node);
	if (known !== undefined) return known;

	if (node instanceof FilterNode) {
		return filterRowsFrom(
			relayedRows(node.source, unknownLeafRows),
			node.selectivity ?? DEFAULT_FILTER_SELECTIVITY,
		) ?? unknownLeafRows;
	}
	// Key coverage (`analyzeJoinKeyCoverage`) is not re-derived: the heuristic
	// alone is close enough for a figure that is only ever compared.
	if (node instanceof JoinNode || node instanceof BloomJoinNode || node instanceof MergeJoinNode) {
		return joinPhysicalRows(
			node.joinType,
			undefined,
			relayedRows(node.left, unknownLeafRows),
			relayedRows(node.right, unknownLeafRows),
		) ?? unknownLeafRows;
	}
	if (node instanceof AggregateNode || node instanceof HashAggregateNode || node instanceof StreamAggregateNode) {
		return node.rowsFrom(relayedRows(node.source, unknownLeafRows)) ?? unknownLeafRows;
	}
	// Any other single-relation node (Alias, Project, Sort, Cache, Distinct,
	// LimitOffset, …) at most passes its source's rows through: an upper bound,
	// which is all a relative comparison needs.
	const relations = node.getRelations();
	if (relations.length === 1) return relayedRows(relations[0], unknownLeafRows);
	return unknownLeafRows;
}
