import type { RelationalPlanNode, UnaryRelationalNode } from '../nodes/plan-node.js';
import { PlanNodeType } from '../nodes/plan-node-type.js';
import type { AggregateNode } from '../nodes/aggregate-node.js';
import type { StreamAggregateNode } from '../nodes/stream-aggregate.js';
import type { HashAggregateNode } from '../nodes/hash-aggregate.js';
import type { ValuesNode } from '../nodes/values-node.js';
import { constantNumber, type LimitOffsetNode } from '../nodes/limit-offset.js';

/**
 * True when `relation` is guaranteed to produce at least one row on every execution,
 * judged from its shape alone. Conservative: `false` whenever unsure. A scalar subquery
 * over a relation this rejects is announced nullable, because finding no row yields NULL.
 *
 * Accepted shapes:
 * - an aggregate with no grouping keys (logical `Aggregate` and its physical
 *   `StreamAggregate` / `HashAggregate` forms) — exactly one row whatever its input, so a
 *   filter below it does not matter;
 * - `SingleRow` (a select with no FROM) and a `Values` with at least one row;
 * - a row-preserving wrapper over an accepted relation: `Project`, `Alias`, `Sort`,
 *   `Distinct`, `Cache` (the optimizer wraps uncorrelated scalar subqueries in one), and
 *   `LimitOffset` whose limit is absent or a constant ≥ 1 and whose offset is absent or
 *   the constant 0.
 *
 * Everything else is rejected — notably a `Filter` above an aggregate (HAVING), a grouped
 * aggregate, a table access, a join, a set operation. The physical aggregates and `Cache`
 * are listed so the answer is the same before and after optimization; a rewrite into a
 * shape not listed can only turn `true` into `false`, the sound direction.
 */
export function alwaysYieldsARow(relation: RelationalPlanNode): boolean {
	switch (relation.nodeType) {
		case PlanNodeType.Aggregate:
		case PlanNodeType.StreamAggregate:
		case PlanNodeType.HashAggregate:
			return (relation as AggregateNode | StreamAggregateNode | HashAggregateNode).groupBy.length === 0;
		case PlanNodeType.SingleRow:
			return true;
		case PlanNodeType.Values:
			return (relation as ValuesNode).rows.length > 0;
		case PlanNodeType.LimitOffset:
			return keepsFirstRow(relation as LimitOffsetNode) && alwaysYieldsARow((relation as LimitOffsetNode).source);
		case PlanNodeType.Project:
		case PlanNodeType.Alias:
		case PlanNodeType.Sort:
		case PlanNodeType.Distinct:
		case PlanNodeType.Cache:
			return alwaysYieldsARow((relation as UnaryRelationalNode).source);
		default:
			return false;
	}
}

/** Whether a LIMIT/OFFSET passes through the first row of a non-empty input. */
function keepsFirstRow(node: LimitOffsetNode): boolean {
	if (node.offset !== undefined && constantNumber(node.offset) !== 0) return false;
	if (node.limit === undefined) return true;
	const limit = constantNumber(node.limit);
	return limit !== undefined && limit >= 1;
}
