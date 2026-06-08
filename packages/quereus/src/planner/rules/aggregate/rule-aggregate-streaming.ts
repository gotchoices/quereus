/**
 * Rule: Aggregate Physical Selection
 *
 * Cost-based selection between StreamAggregateNode and HashAggregateNode.
 *
 * Decision logic:
 * - No GROUP BY → always StreamAggregate (no hash needed for scalar aggregate)
 * - Already sorted → always StreamAggregate (no sort overhead, preserves ordering)
 * - Unsorted → choose cheaper of sort+stream vs hash based on cost model
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, ScalarPlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { StreamAggregateNode } from '../../nodes/stream-aggregate.js';
import { HashAggregateNode } from '../../nodes/hash-aggregate.js';
import { SortNode } from '../../nodes/sort.js';
import { PlanNodeType } from '../../nodes/plan-node-type.js';
import { ColumnReferenceNode } from '../../nodes/reference.js';
import {
	PlanNodeCharacteristics,
	CapabilityDetectors,
	type AggregationCapable
} from '../../framework/characteristics.js';
import { sortCost, streamAggregateCost, hashAggregateCost } from '../../cost/index.js';

const log = createLogger('optimizer:rule:aggregate-physical');

export function ruleAggregatePhysical(node: PlanNode, _context: OptContext): PlanNode | null {
	if (!CapabilityDetectors.isAggregating(node)) {
		return null;
	}

	log('Applying aggregate physical selection rule to node %s', node.id);

	const aggregateNode = node as AggregationCapable;
	const groupingKeys = aggregateNode.getGroupingKeys();
	const aggregateExpressions = aggregateNode.getAggregateExpressions();
	const source = aggregateNode.getSource();

	if (!aggregateNode.canStreamAggregate()) {
		log('Node cannot use streaming aggregation, skipping');
		return null;
	}

	// Advertise exactly the logical AggregateNode's output schema (groupBy + aggregates).
	// The emitter only ever yields those columns; source values are exposed solely through
	// the runtime row descriptor context (for HAVING / correlated reads), never as output
	// attributes. Appending source attributes here would declare columns the node never emits.
	const finalAttrs = node.getAttributes().slice();
	const aggregates = aggregateExpressions.map(agg => ({
		expression: agg.expr,
		alias: agg.alias
	}));

	// No GROUP BY — always use stream aggregate (single accumulator, no hash map needed)
	if (groupingKeys.length === 0) {
		const result = new StreamAggregateNode(
			node.scope, source, groupingKeys, aggregates, undefined, finalAttrs
		);
		log('Scalar aggregate → StreamAggregate');
		return result;
	}

	// Check if source already provides the required ordering
	const sourceOrdering = PlanNodeCharacteristics.getOrdering(source);
	const alreadySorted = isOrderedForGrouping(sourceOrdering, groupingKeys, source.getAttributeIndex());

	if (alreadySorted) {
		// Already sorted → always stream aggregate (no sort cost, preserves ordering for downstream)
		const result = new StreamAggregateNode(
			node.scope, source, groupingKeys, aggregates, undefined, finalAttrs
		);
		log('Already sorted → StreamAggregate');
		return result;
	}

	// Cost-based decision: sort+stream vs hash
	const inputRows = source.estimatedRows ?? 1000;
	const estimatedGroups = Math.max(1, Math.floor(inputRows / 10));

	const streamCostTotal = sortCost(inputRows) + streamAggregateCost(inputRows, estimatedGroups);
	const hashCostTotal = hashAggregateCost(inputRows, estimatedGroups);

	log('Cost comparison: sort+stream=%.2f, hash=%.2f (inputRows=%d, groups=%d)',
		streamCostTotal, hashCostTotal, inputRows, estimatedGroups);

	if (hashCostTotal < streamCostTotal) {
		const result = new HashAggregateNode(
			node.scope, source, groupingKeys, aggregates, undefined, finalAttrs
		);
		log('Unsorted → HashAggregate (cheaper)');
		return result;
	} else {
		const sortKeys = groupingKeys.map(expr => ({
			expression: expr,
			direction: 'asc' as const,
			nulls: undefined
		}));
		const sortedSource = new SortNode(node.scope, source, sortKeys);
		const result = new StreamAggregateNode(
			node.scope, sortedSource, groupingKeys, aggregates, undefined, finalAttrs
		);
		log('Unsorted → Sort+StreamAggregate (cheaper)');
		return result;
	}
}

/** Backwards-compatible export name */
export const ruleAggregateStreaming = ruleAggregatePhysical;

/**
 * Check if source ordering matches grouping requirements for streaming
 */
function isOrderedForGrouping(
	ordering: { column: number; desc: boolean }[] | undefined,
	groupingKeys: readonly ScalarPlanNode[],
	sourceAttrIndex: ReadonlyMap<number, number>
): boolean {
	if (!ordering || ordering.length === 0) {
		return false;
	}

	const groupColumns: number[] = [];
	for (const key of groupingKeys) {
		if (key.nodeType !== PlanNodeType.ColumnReference) {
			return false;
		}

		const colRef = key as unknown as ColumnReferenceNode;
		const idx = sourceAttrIndex.get(colRef.attributeId) ?? -1;
		if (idx < 0) {
			return false;
		}

		groupColumns.push(idx);
	}

	if (groupColumns.length > ordering.length) {
		return false;
	}

	for (let i = 0; i < groupColumns.length; i++) {
		if (ordering[i].column !== groupColumns[i]) {
			return false;
		}
	}

	return true;
}
