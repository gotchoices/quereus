/**
 * Shared cache utilities based on the existing working cache emitter
 * Provides reusable caching patterns for CacheNode, NLJ inner caching, and CTE materialization
 */

import type { Row } from '../../common/types.js';
import { createLogger } from '../../common/logger.js';

const log = createLogger('runtime:cache:shared');

/**
 * Cache strategy for handling overflow
 */
export type CacheStrategy = 'memory' | 'spill';

/**
 * Configuration for shared cache behavior
 */
export interface SharedCacheConfig {
	/** Maximum rows before abandoning cache */
	threshold: number;
	/** Strategy when threshold exceeded */
	strategy: CacheStrategy;
	/** Optional identifier for logging */
	name?: string;
}

/**
 * Cache state for a shared cache instance
 * Based on the proven closure pattern from the existing cache emitter
 */
export interface CacheState {
	/** Cached result rows (undefined if not cached or abandoned) */
	cachedResult?: Row[];
	/** Whether caching was abandoned due to threshold */
	cacheAbandoned: boolean;
	/** Number of times cache has been consumed */
	consumeCount: number;
}

/**
 * Create a cache state object
 */
export function createCacheState(): CacheState {
	return {
		cachedResult: undefined,
		cacheAbandoned: false,
		consumeCount: 0
	};
}

/**
 * Shared cache implementation using the proven streaming-first pattern
 * This is extracted from the existing working cache emitter
 */
export async function* streamWithCache(
	sourceIterable: AsyncIterable<Row>,
	config: SharedCacheConfig,
	state: CacheState
): AsyncIterable<Row> {
	const { threshold, name = 'cache' } = config;

	// If we already have cached data, return copies (same deep-copy as build path)
	if (state.cachedResult) {
		state.consumeCount++;
		log('Serving %s from cache (access #%d, %d rows)',
			name, state.consumeCount, state.cachedResult.length);
		for (const row of state.cachedResult) {
			yield [...row] as Row;
		}
		return;
	}

	// If we previously abandoned caching, just stream through
	if (state.cacheAbandoned) {
		log('%s cache abandoned due to previous threshold exceed, streaming directly', name);
		yield* sourceIterable;
		return;
	}

	// First time - pipeline results while building cache
	log('Building %s cache with threshold %d while pipelining', name, threshold);
	let cache: Row[] | undefined = [];

	// Pipeline while caching (proven pattern from existing emitter)
	for await (const row of sourceIterable) {
		// Always yield immediately (streaming-first)
		yield row;

		// Try to cache if we haven't exceeded threshold
		if (cache) {
			if (cache.length < threshold) {
				// Cache the row (deep copy to avoid reference issues)
				cache.push([...row] as Row);
			} else {
				// Hit threshold - dump cache and abandon caching
				log('%s cache threshold %d exceeded at row %d, dumping cache and continuing to pipeline',
					name, threshold, cache.length);
				cache = undefined;
			}
		}
	}

	// If we finished without exceeding threshold, cache is ready
	if (cache) {
		log('%s cache built successfully with %d rows', name, cache.length);
		state.cachedResult = cache;
	} else {
		state.cacheAbandoned = true;
	}
}

/**
 * Factory function to create a reusable cache function
 * Returns a function that can be called multiple times with different sources
 */
export function createCacheFunction(config: SharedCacheConfig) {
	const state = createCacheState();

	return async function* cachedIterable(source: AsyncIterable<Row>): AsyncIterable<Row> {
		yield* streamWithCache(source, config, state);
	};
}

/**
 * Helper to wrap an async iterable with caching using the proven pattern
 * This is the main utility that other components should use
 */
export function withSharedCache(
	source: AsyncIterable<Row>,
	config: SharedCacheConfig
): {
	iterable: AsyncIterable<Row>;
	state: CacheState;
} {
	const state = createCacheState();

	const iterable = {
		async *[Symbol.asyncIterator](): AsyncIterator<Row> {
			yield* streamWithCache(source, config, state);
		}
	};

	return { iterable, state };
}

/**
 * Get cache effectiveness metrics
 */
export function getCacheMetrics(state: CacheState): {
	isCached: boolean;
	isAbandoned: boolean;
	consumeCount: number;
	cachedRows?: number;
} {
	return {
		isCached: !!state.cachedResult,
		isAbandoned: state.cacheAbandoned,
		consumeCount: state.consumeCount,
		cachedRows: state.cachedResult?.length
	};
}

/**
 * Clear cache state (useful for testing or manual cache invalidation)
 */
export function clearCache(state: CacheState): void {
	state.cachedResult = undefined;
	state.cacheAbandoned = false;
	state.consumeCount = 0;
}
