/**
 * Rule: a LIMIT above a key-set semi join can favour the ordered walk
 *
 *   LimitOffset (a LIMIT and any OFFSET that are safe to evaluate twice)
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
 * key count is only known at runtime, and the limit may be too, so this rule hands the
 * node the limit's expressions (`KeySetRowBound`) and the runtime makes that comparison
 * once per execution. A literal limit takes the same path as a placeholder, so the two
 * forms cannot disagree. Everything comes from the costs the module already quoted
 * (`KeySetCostLine`): no row count is needed and no second cost model appears.
 *
 * The expressions are evaluated twice per execution, by the node and by the LimitOffset,
 * and must give the same value both times without re-reading a table. So a
 * non-deterministic or writing expression, or one holding a subquery, declines and keeps
 * the unbounded threshold. A correlated limit is admitted: both evaluations read the
 * same outer row from the same runtime context.
 *
 * A node whose seek streams is left alone. Under `seekPreservesTargetOrder` the seek
 * emits in walk order and stops as early as the walk does, and with no order to serve
 * the seek streams too, so a limit gives no reason to walk.
 *
 * NOTE: the runtime comparison assumes an even spread, which is an estimate, and a
 * Filter between the limit and the node makes the walk read more than estimated, as does
 * a writing Project, which makes the limit drain its source. Either error costs reads,
 * never a row, and is bounded by a full walk. Revisit if a measured query picks badly.
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, RelationalPlanNode, ScalarPlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { PlanNodeCharacteristics } from '../../framework/characteristics.js';
import { LimitOffsetNode } from '../../nodes/limit-offset.js';
import { AliasNode } from '../../nodes/alias-node.js';
import { ProjectNode } from '../../nodes/project-node.js';
import { FilterNode } from '../../nodes/filter.js';
import { KeySetSemiJoinNode, seekRestoresTargetOrder } from '../../nodes/key-set-semi-join-node.js';
import { hasRelationalDescendant } from '../../analysis/scalar-subqueries.js';
import { rebuildChain } from '../shared/access-leaf.js';

const log = createLogger('optimizer:rule:key-set-seek-row-bound');

function safeToEvaluateTwice(expr: ScalarPlanNode): boolean {
	return PlanNodeCharacteristics.isDeterministic(expr)
		&& !PlanNodeCharacteristics.subtreeHasSideEffects(expr)
		&& !hasRelationalDescendant(expr);
}

/** Each wrapper here passes rows on in order, one row out per row in at most. */
function peelToKeySetJoin(chainRoot: RelationalPlanNode): KeySetSemiJoinNode | null {
	let cursor = chainRoot;
	while (cursor instanceof AliasNode || cursor instanceof ProjectNode || cursor instanceof FilterNode) {
		cursor = cursor.source;
	}
	return cursor instanceof KeySetSemiJoinNode ? cursor : null;
}

export function ruleKeySetSeekRowBound(node: PlanNode, _context: OptContext): PlanNode | null {
	if (!(node instanceof LimitOffsetNode) || !node.limit) return null;

	const join = peelToKeySetJoin(node.source);
	// An existing bound means a later pass re-minted this LimitOffset: already done.
	if (!join || join.rowBound || !seekRestoresTargetOrder(join.target, join.pushdown)) return null;
	if (!safeToEvaluateTwice(node.limit) || (node.offset && !safeToEvaluateTwice(node.offset))) return null;

	const bounded = new KeySetSemiJoinNode(
		join.scope,
		join.target,
		join.keySource,
		join.targetAttrId,
		join.keyAttrId,
		join.pushdown,
		{ limit: node.limit, offset: node.offset },
	);
	log('Attached a row bound to the key-set semi join via %s', join.pushdown.indexName);
	return node.withChildren([rebuildChain(node.source, join, bounded), ...node.getChildren().slice(1)]);
}
