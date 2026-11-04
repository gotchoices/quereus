/**
 * Rule: a LIMIT above a key-set semi join can favour the ordered walk
 *
 *   LimitOffset (literal LIMIT, literal or absent OFFSET)
 *     └─ (Alias | Project | Filter)*
 *          └─ KeySetSemiJoin whose seek branch must sort (`seekRestoresTargetOrder`)
 *
 * The seek branch has to read and sort every matching row before it can emit one,
 * while the scan branch streams in order and stops once the limit is met. The
 * node's break-even compares the two as if both ran to completion, so under a limit
 * it keeps seeking long after the walk has become the cheaper read.
 *
 * With `L` rows wanted and `K` keys spread evenly, a walk stops after `L / K` of its
 * whole cost, so seeking is worth it while `seekCost(K) <= baselineCost * L / K`. The
 * key count is only known at runtime, so this rule solves that for the largest `K`
 * and lowers `breakEvenKeys` to it. Everything comes from the costs the module
 * already quoted (`KeySetCostLine`): no row count is needed and no second cost model
 * appears. Runtime still makes the choice.
 *
 * A node whose seek streams is left alone. Under `seekPreservesTargetOrder` the seek
 * emits in walk order and stops as early as the walk does, and with no order to serve
 * the seek streams too, so a limit gives no reason to walk.
 *
 * NOTE: the even spread is an estimate, and a Filter between the limit and the node
 * makes the walk read more than estimated, as does a writing Project, which makes the
 * limit drain its source. Either error costs reads, never a row, and is bounded by
 * today's full walk. Revisit if a measured query picks badly.
 *
 * NOTE: only a literal LIMIT gets here, and the node learns nothing of a bound known
 * only at runtime. Over 1000 evenly spread keys in 2000 rows, `limit ?` bound to 1 reads
 * 1000 rows where the literal reads 2. If parameterized limits over large key sets show
 * up slow, hand the node the bound at runtime and make the same comparison there.
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, RelationalPlanNode, ScalarPlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { LimitOffsetNode } from '../../nodes/limit-offset.js';
import { AliasNode } from '../../nodes/alias-node.js';
import { ProjectNode } from '../../nodes/project-node.js';
import { FilterNode } from '../../nodes/filter.js';
import { KeySetSemiJoinNode, seekRestoresTargetOrder, type KeySetPushdown } from '../../nodes/key-set-semi-join-node.js';
import { planTimeLiteralValue } from '../../analysis/predicate-shape.js';
import { rebuildChain } from '../shared/access-leaf.js';

const log = createLogger('optimizer:rule:key-set-seek-row-bound');

/**
 * `limit + offset`, when both are plan-time literals. An OFFSET may be the literal
 * null the builder writes for an absent one (as does `rule-minmax-index-boundary`).
 * A limit of zero or less never opens its source, so it has nothing to tune.
 */
function literalRowBound(node: LimitOffsetNode): number | undefined {
	const limit = node.limit && planTimeLiteralValue(node.limit);
	if (typeof limit !== 'number' || limit <= 0) return undefined;
	const offset = literalOffset(node.offset);
	return offset === undefined ? undefined : limit + offset;
}

function literalOffset(offset: ScalarPlanNode | undefined): number | undefined {
	if (!offset) return 0;
	const value = planTimeLiteralValue(offset);
	if (value === null) return 0;
	return typeof value === 'number' ? Math.max(0, value) : undefined;
}

/** Each wrapper here passes rows on in order, one row out per row in at most. */
function peelToKeySetJoin(chainRoot: RelationalPlanNode): KeySetSemiJoinNode | null {
	let cursor = chainRoot;
	while (cursor instanceof AliasNode || cursor instanceof ProjectNode || cursor instanceof FilterNode) {
		cursor = cursor.source;
	}
	return cursor instanceof KeySetSemiJoinNode ? cursor : null;
}

/**
 * The largest key count, no greater than the current break-even, whose seek is worth
 * it for `rowBound` rows, or 0 when none is. The inequality is
 * `seekCost(K) <= baselineCost * rowBound / K` multiplied through by `K`.
 */
function boundedBreakEven({ breakEvenKeys, costLine }: KeySetPushdown, rowBound: number): number {
	const { seekAt2, slope, baselineCost } = costLine;
	for (let keys = breakEvenKeys; keys >= 1; keys--) {
		if ((seekAt2 + slope * (keys - 2)) * keys <= baselineCost * rowBound) return keys;
	}
	return 0;
}

export function ruleKeySetSeekRowBound(node: PlanNode, _context: OptContext): PlanNode | null {
	if (!(node instanceof LimitOffsetNode)) return null;

	const rowBound = literalRowBound(node);
	if (rowBound === undefined) return null;

	const join = peelToKeySetJoin(node.source);
	if (!join || !seekRestoresTargetOrder(join.target, join.pushdown)) return null;

	const breakEvenKeys = boundedBreakEven(join.pushdown, rowBound);
	if (breakEvenKeys === join.pushdown.breakEvenKeys) return null;

	const bounded = new KeySetSemiJoinNode(
		join.scope,
		join.target,
		join.keySource,
		join.targetAttrId,
		join.keyAttrId,
		{ ...join.pushdown, breakEvenKeys },
	);
	log('Lowered break-even via %s from %d to %d for a bound of %d rows',
		join.pushdown.indexName, join.pushdown.breakEvenKeys, breakEvenKeys, rowBound);
	return node.withChildren([rebuildChain(node.source, join, bounded), ...node.getChildren().slice(1)]);
}
