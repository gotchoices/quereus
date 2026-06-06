import type { CacheNode } from '../../planner/nodes/cache-node.js';
import type { Instruction, InstructionRun, RuntimeContext } from '../types.js';
import type { Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitCallFromPlan } from '../emitters.js';
import { streamWithCache, createCacheState, type SharedCacheConfig } from '../cache/shared-cache.js';
import { buffered, traced } from '../async-util.js';
import { isLoggingEnabled } from '../../common/logger.js';

/**
 * Usage example for other emitters needing caching (NLJ inner caching, CTE materialization):
 *
 * ```typescript
 * import { streamWithCache, createCacheState } from '../cache/shared-cache.js';
 *
 * // In your emitter:
 * const cacheState = createCacheState();
 * const config = { threshold: 10000, strategy: 'memory', name: 'NLJ-inner' };
 *
 * // In your run function:
 * yield* streamWithCache(sourceIterable, config, cacheState);
 * ```
 */

/**
 * Emits a smart cache instruction that materializes input on first iteration
 * and serves subsequent iterations from cached results.
 *
 * Now uses the shared cache utility to avoid code duplication.
 */
export function emitCache(plan: CacheNode, ctx: EmissionContext): Instruction {
	// Create cache state using shared utility
	const cacheState = createCacheState();
	const config: SharedCacheConfig = {
		threshold: plan.threshold,
		strategy: plan.strategy,
		name: `CacheNode-${plan.id}`
	};

	async function* run(rctx: RuntimeContext, sourceCallback: (innerCtx: RuntimeContext) => AsyncIterable<Row>): AsyncIterable<Row> {
		let sourceIterable = sourceCallback(rctx);

		// Optional: Add buffering for large threshold caches to improve performance
		if (plan.threshold > 50000) {
			sourceIterable = buffered(sourceIterable, Math.min(plan.threshold / 10, 5000));
		}

		// Optional: Add tracing in debug mode
		if (isLoggingEnabled('runtime:cache')) {
			sourceIterable = traced(sourceIterable, `cache-${plan.id}`,
				(row, index) => `row ${index}: [${row.length} columns]`);
		}

		yield* streamWithCache(sourceIterable, config, cacheState);
	}

	const sourceInstruction = emitCallFromPlan(plan.source, ctx);

	return {
		params: [sourceInstruction],
		run: run as InstructionRun,
		note: `cache(${plan.strategy}, threshold=${plan.threshold})`
	};
}
