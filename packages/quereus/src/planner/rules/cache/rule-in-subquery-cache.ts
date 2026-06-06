/**
 * Rule: IN-Subquery Cache
 *
 * Required Characteristics:
 * - Node must be an InNode with a subquery source (not a value list)
 * - Source must be uncorrelated (no outer attribute references)
 * - Source must be deterministic and read-only (functional)
 * - Source must not already be cached
 *
 * Applied When:
 * - IN subquery source would be re-executed for every outer row in a filter predicate
 *
 * Benefits: Materializes the subquery result once and replays from cache on subsequent
 * evaluations, reducing O(N * K) CTE/subquery evaluations to O(K + N * K_cached)
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { InNode } from '../../nodes/subquery.js';
import { CacheNode } from '../../nodes/cache-node.js';
import { CapabilityDetectors, CachingAnalysis, PlanNodeCharacteristics } from '../../framework/characteristics.js';
import { isCorrelatedSubquery } from '../../cache/correlation-detector.js';
import { PlanNodeType } from '../../nodes/plan-node-type.js';

const log = createLogger('optimizer:rule:in-subquery-cache');

export function ruleInSubqueryCache(node: PlanNode, context: OptContext): PlanNode | null {
	// Guard: must be an InNode with a subquery source
	if (node.nodeType !== PlanNodeType.In) {
		return null;
	}

	const inNode = node as InNode;
	if (!inNode.source) {
		return null; // Value-list IN, nothing to cache
	}

	const source = inNode.source;

	// Gate: source must not already be cached
	if (CapabilityDetectors.isCached(source) && source.isCached()) {
		log('IN-subquery source already cached, skipping');
		return null;
	}

	// Gate: source must be uncorrelated (no outer attribute references)
	if (isCorrelatedSubquery(source)) {
		log('IN-subquery is correlated, skipping cache wrapping');
		return null;
	}

	// Gate: source must be deterministic and read-only
	if (!PlanNodeCharacteristics.isFunctional(source)) {
		log('IN-subquery source is not functional, skipping cache wrapping');
		return null;
	}

	log('Wrapping uncorrelated IN-subquery source in CacheNode');

	const cacheThreshold = Math.min(
		CachingAnalysis.getCacheThreshold(source),
		context.tuning.cte.maxCacheThreshold
	);

	const cachedSource = new CacheNode(
		source.scope,
		source,
		'memory',
		cacheThreshold
	);

	return new InNode(
		inNode.scope,
		inNode.expression,
		inNode.condition,
		cachedSource,
		inNode.values
	);
}
