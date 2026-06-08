import { createLogger } from '../../../common/logger.js';
import type { PlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { DistinctNode } from '../../nodes/distinct-node.js';
import { keysOf } from '../../util/fd-utils.js';

const log = createLogger('optimizer:rule:distinct-elimination');

/**
 * Rule: DISTINCT Elimination
 *
 * When a DistinctNode's source already guarantees unique rows, the DISTINCT is
 * redundant and can be removed.
 *
 * Uniqueness is read through the single `keysOf` surface, which reconciles all
 * three places a uniqueness fact can live (declared `RelationType.keys`, the
 * physical FD set, and `RelationType.isSet`): a non-empty key set ⟺ the source
 * is already a set ⟺ DISTINCT is a no-op. This closes the gap where a
 * `select distinct x, y` (which proves only the all-columns/`isSet` key, not a
 * smaller FD/declared key) was invisible to the FD-only checks — so an outer
 * `select distinct x, y from (select distinct x, y …)` now drops the redundant
 * outer DISTINCT.
 */
export function ruleDistinctElimination(node: PlanNode, _context: OptContext): PlanNode | null {
	if (!(node instanceof DistinctNode)) return null;

	// A non-empty key set proves the source already produces unique rows. This
	// covers logical keys, FD-derived keys, the at-most-one-row empty key, and
	// the all-columns/`isSet` key — all via the unified surface.
	if (keysOf(node.source).length > 0) {
		log('Eliminating redundant DISTINCT: source has a proven unique key');
		return node.source;
	}

	return null;
}
