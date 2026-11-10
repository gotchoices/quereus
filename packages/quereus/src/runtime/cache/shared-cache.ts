/**
 * Shared cache utilities based on the existing working cache emitter
 * Provides reusable caching patterns for CacheNode, NLJ inner caching, and CTE materialization
 */

import type { Row } from '../../common/types.js';
import { createLogger } from '../../common/logger.js';

const log = createLogger('runtime:cache:shared');
const warnLog = log.extend('warn');

/**
 * Cache strategy selected by the planner. Only `'memory'` is implemented:
 * `'spill'` is accepted but not yet acted on (no spill-to-disk exists), so it
 * buffers in memory exactly like `'memory'`.
 */
export type CacheStrategy = 'memory' | 'spill';

/**
 * Configuration for shared cache behavior
 */
export interface SharedCacheConfig {
	/**
	 * Row count past which the build logs a misestimate warning. A soft guard,
	 * not a cap: the buffer keeps growing past it, so a cached source still runs
	 * at most once per execution whatever its size.
	 */
	threshold: number;
	/** Planner-selected strategy; `'spill'` is not yet acted on (see {@link CacheStrategy}) */
	strategy: CacheStrategy;
	/** Optional identifier for logging */
	name?: string;
	/**
	 * When true, fully drain + commit the buffer before yielding any row, so a
	 * short-circuiting consumer (e.g. IN early-exit) cannot abort the build.
	 * Defaults to the streaming-first behaviour (yield each row as it arrives,
	 * commit only after the source drains to completion).
	 */
	eager?: boolean;
}

/**
 * Cache state for a shared cache instance
 * Based on the proven closure pattern from the existing cache emitter
 */
export interface CacheState {
	/** Cached result rows (undefined until a build pass drains the source to completion) */
	cachedResult?: Row[];
	/** Number of times cache has been consumed */
	consumeCount: number;
}

/**
 * Create a cache state object
 */
export function createCacheState(): CacheState {
	return {
		cachedResult: undefined,
		consumeCount: 0
	};
}

/**
 * Append a copy of `row` to the build buffer, warning once when the buffer
 * first grows past the configured threshold.
 *
 * NOTE: buffers are unbounded, like hash-join build sides and shared-CTE
 * materialization. If memory pressure from large buffers ever shows up, the
 * answer is a shared memory budget or spill for all of them, not a cap on this
 * one — a cap re-runs the source once per pass (quadratic re-reads, repeated
 * writes for a DML-bearing source).
 */
function bufferRow(buffer: Row[], row: Row, config: SharedCacheConfig, name: string): void {
	if (buffer.length === config.threshold) {
		warnLog('%s cache exceeded its threshold of %d rows (estimate was low); still buffering',
			name, config.threshold);
	}
	// Copy so a consumer mutating a yielded row cannot corrupt the buffer
	buffer.push([...row] as Row);
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
		// NOTE: copies each row per replay; if replay allocation shows up in
		// profiles, audit consumers for in-place row mutation and switch to frozen
		// shared rows.
		for (const row of state.cachedResult) {
			yield [...row] as Row;
		}
		return;
	}

	// First time, eager mode - drain the source fully, commit, THEN yield.
	// A consumer that breaks on the first row (e.g. IN early-exit) still causes
	// the whole drain + commit here, so every later evaluation replays from cache
	// instead of re-opening the source. The build cannot be short-circuited.
	if (config.eager) {
		log('Building %s cache eagerly (full drain before yield), warning past %d rows', name, threshold);
		const buffer: Row[] = [];
		for await (const row of sourceIterable) {
			bufferRow(buffer, row, config, name);
		}
		// Drained fully - commit before yielding any row.
		// (If the source threw mid-drain we never reach here: nothing is committed,
		//  so the next eval retries fresh.)
		log('%s eager cache built successfully with %d rows', name, buffer.length);
		state.cachedResult = buffer;
		for (const row of buffer) yield [...row] as Row;
		return;
	}

	// First time (streaming-first) - pipeline results while building cache
	log('Building %s cache while pipelining, warning past %d rows', name, threshold);
	const buffer: Row[] = [];
	for await (const row of sourceIterable) {
		yield row;
		bufferRow(buffer, row, config, name);
	}

	// Commit only once the source drains: a consumer that stops early leaves
	// nothing committed, and the next pass re-runs the source.
	log('%s cache built successfully with %d rows', name, buffer.length);
	state.cachedResult = buffer;
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
	consumeCount: number;
	cachedRows?: number;
} {
	return {
		isCached: !!state.cachedResult,
		consumeCount: state.consumeCount,
		cachedRows: state.cachedResult?.length
	};
}

/**
 * Clear cache state (useful for testing or manual cache invalidation)
 */
export function clearCache(state: CacheState): void {
	state.cachedResult = undefined;
	state.consumeCount = 0;
}
