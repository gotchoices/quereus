/**
 * Rule: CTE Optimization
 *
 * Required Characteristics:
 * - Node must support CTE operations (CTECapable interface)
 * - Node must be relational (produces rows)
 * - Source must be cacheable for materialization
 *
 * Applied When:
 * - CTE would benefit from materialization/caching based on cost analysis
 *
 * Benefits: Reduces redundant computation for repeated CTE access
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { CTENode } from '../../nodes/cte-node.js';
import { CacheNode } from '../../nodes/cache-node.js';
import { CapabilityDetectors, CachingAnalysis, PlanNodeCharacteristics, type CTECapable } from '../../framework/characteristics.js';

const log = createLogger('optimizer:rule:cte-optimization');

export function ruleCteOptimization(node: PlanNode, context: OptContext): PlanNode | null {
	// Guard: node must support CTE operations
	if (!CapabilityDetectors.isCTE(node)) {
		return null;
	}

	// Get CTE characteristics
	const cteNode = node as CTECapable;
	log('Optimizing CTE %s', cteNode.cteName);

	// Source is already optimized by framework
	const source = cteNode.getCTESource();

	// Heuristics for when to cache CTEs:
	// 1. CTE has materialization hint
	// 2. CTE is estimated to be reasonably sized
	// 3. CTE is not already cached
	const sourceSize = PlanNodeCharacteristics.estimatesRows(source);
	const isAlreadyCached = CapabilityDetectors.isCached(source) && source.isCached();
	const shouldCache = (
		cteNode.materializationHint === 'materialized' ||
		(sourceSize > 0 && sourceSize < context.tuning.cte.maxSizeForCaching)
	) && !isAlreadyCached;

	if (shouldCache) {
		log('Adding cache to CTE %s (estimated rows: %d)', cteNode.cteName, sourceSize);

		// Use characteristics-based cache threshold calculation
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

		// Create new CTE with cached source (specific to CTENode implementation)
		const result = new CTENode(
			node.scope,
			cteNode.cteName,
			cteNode.columns,
			cachedSource,
			cteNode.materializationHint,
			cteNode.isRecursive
		);

		log('Created CTE with caching');
		return result;
	}

	return null; // No transformation needed
}
