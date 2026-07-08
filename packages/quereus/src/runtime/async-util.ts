/**
 * Async stream utilities for processing async iterables
 * Used by CacheNode emitter, NestedLoopJoin inner side, and other streaming operations
 */

import type { MaybePromise, Row } from '../common/types.js';
import { createLogger } from '../common/logger.js';
import { getAsyncIterator } from './utils.js';

const log = createLogger('runtime:async-util');

/**
 * Resolve a possibly-pending value and apply `fn`, WITHOUT a microtask hop on
 * the synchronous common case.
 *
 * Scalar sub-programs (a filter predicate, a projected column, a join
 * condition) run through a sub-scheduler that completes synchronously and
 * returns a concrete value whenever no instruction in the sub-program is itself
 * async — which is the overwhelmingly common case. But `await value` still
 * schedules a microtask even when `value` is not a thenable (per spec,
 * `await x` ≡ `await Promise.resolve(x)`), so a per-row/per-column
 * `await subprogram(rctx)` pays that tick N times for nothing. Branching on
 * `instanceof Promise` keeps the hot path fully synchronous and only defers
 * when the value is genuinely pending.
 *
 * The result is itself `MaybePromise<R>`: when the input is concrete, `fn` runs
 * inline and the mapped value is returned directly; only a genuinely pending
 * input chains through `.then`. Callers that need the plain value must still
 * branch at the extraction point (`r instanceof Promise ? await r : r`) — that
 * final `await` then runs only on the rare async path, never on the hot path.
 *
 * NOTE: pure-extraction sites (no mapping — e.g. collecting projected columns
 * into a row array) inline the same `instanceof Promise` branch directly rather
 * than wrapping an identity `fn` here; a value-returning helper cannot host the
 * caller's `await` without reintroducing the very hop this avoids.
 */
export function resolveMaybe<T, R>(value: MaybePromise<T>, fn: (v: T) => R): MaybePromise<R> {
	return value instanceof Promise ? value.then(fn) : fn(value);
}

/**
 * Transform rows using a mapping function
 */
export async function* mapRows<T extends Row, R>(
	src: AsyncIterable<T>,
	fn: (row: T) => R
): AsyncIterable<R> {
	for await (const row of src) {
		yield fn(row);
	}
}

/**
 * Filter rows using a predicate function
 */
export async function* filterRows<T>(
	src: AsyncIterable<T>,
	pred: (row: T) => MaybePromise<boolean>
): AsyncIterable<T> {
	for await (const row of src) {
		const include = await pred(row);
		if (include) {
			yield row;
		}
	}
}

/**
 * Duplicate an async iterable into two independent streams
 * This materializes chunks internally as needed
 */
export function tee<T>(src: AsyncIterable<T>): [AsyncIterable<T>, AsyncIterable<T>] {
	const buffer: T[] = [];
	let srcIterator: AsyncIterator<T> | null = null;
	let srcDone = false;
	let consumer1Index = 0;
	let consumer2Index = 0;

	async function fillBuffer(targetIndex: number): Promise<void> {
		if (srcDone || buffer.length > targetIndex) {
			return;
		}

		if (!srcIterator) {
			srcIterator = getAsyncIterator(src);
		}

		while (buffer.length <= targetIndex && !srcDone) {
			const result = await srcIterator.next();
			if (result.done) {
				srcDone = true;
			} else {
				buffer.push(result.value);
			}
		}
	}

	const stream1: AsyncIterable<T> = {
		async *[Symbol.asyncIterator]() {
			while (true) {
				await fillBuffer(consumer1Index);

				if (consumer1Index >= buffer.length) {
					if (srcDone) break;
					continue;
				}

				yield buffer[consumer1Index];
				consumer1Index++;

				// Clean up buffer when both consumers have passed this point
				const minIndex = Math.min(consumer1Index, consumer2Index);
				if (minIndex > 100) { // Keep some buffer for efficiency
					buffer.splice(0, minIndex - 100);
					consumer1Index -= (minIndex - 100);
					consumer2Index -= (minIndex - 100);
				}
			}
		}
	};

	const stream2: AsyncIterable<T> = {
		async *[Symbol.asyncIterator]() {
			while (true) {
				await fillBuffer(consumer2Index);

				if (consumer2Index >= buffer.length) {
					if (srcDone) break;
					continue;
				}

				yield buffer[consumer2Index];
				consumer2Index++;

				// Clean up buffer when both consumers have passed this point
				const minIndex = Math.min(consumer1Index, consumer2Index);
				if (minIndex > 100) { // Keep some buffer for efficiency
					buffer.splice(0, minIndex - 100);
					consumer1Index -= (minIndex - 100);
					consumer2Index -= (minIndex - 100);
				}
			}
		}
	};

	return [stream1, stream2];
}

/**
 * Add buffering to an async iterable with back-pressure
 */
export async function* buffered<T>(
	src: AsyncIterable<T>,
	maxBuffer: number
): AsyncIterable<T> {
	const buffer: T[] = [];
	const srcIterator = getAsyncIterator(src);
	let srcDone = false;
	let fillPromise: Promise<void> | null = null;

	// Fill buffer in background
	async function fillBuffer(): Promise<void> {
		while (buffer.length < maxBuffer && !srcDone) {
			const result = await srcIterator.next();
			if (result.done) {
				srcDone = true;
			} else {
				buffer.push(result.value);
			}
		}
	}

	// Start initial fill
	fillPromise = fillBuffer();

	try {
		while (true) {
			// Wait for buffer to have items or source to be done
			await fillPromise;

			if (buffer.length === 0 && srcDone) {
				break;
			}

			if (buffer.length > 0) {
				const item = buffer.shift()!;
				yield item;

				// Start refilling buffer if below threshold
				if (buffer.length < maxBuffer / 2 && !srcDone) {
					fillPromise = fillBuffer();
				}
			}
		}
	} finally {
		// Clean up source iterator if consumer breaks early
		if (!srcDone && srcIterator.return) {
			await srcIterator.return(undefined);
		}
	}
}

/**
 * Take only the first N items from an async iterable
 */
export async function* take<T>(src: AsyncIterable<T>, count: number): AsyncIterable<T> {
	let taken = 0;
	for await (const item of src) {
		if (taken >= count) break;
		yield item;
		taken++;
	}
}

/**
 * Skip the first N items from an async iterable
 */
export async function* skip<T>(src: AsyncIterable<T>, count: number): AsyncIterable<T> {
	let skipped = 0;
	for await (const item of src) {
		if (skipped < count) {
			skipped++;
			continue;
		}
		yield item;
	}
}

/**
 * Count the number of items in an async iterable (consumes the iterable)
 */
export async function count<T>(src: AsyncIterable<T>): Promise<number> {
	let total = 0;
	for await (const _ of src) {
		total++;
	}
	return total;
}

/**
 * Collect all items from an async iterable into an array
 * Use with caution on large iterables
 */
export async function collect<T>(src: AsyncIterable<T>): Promise<T[]> {
	const result: T[] = [];
	for await (const item of src) {
		result.push(item);
	}
	return result;
}

/**
 * Merge multiple async iterables into a single stream
 * Items are yielded as soon as they become available from any source
 */
export async function* merge<T>(...sources: AsyncIterable<T>[]): AsyncIterable<T> {
	const iterators = sources.map(src => getAsyncIterator(src));
	const pending = new Map<number, Promise<IteratorResult<T>>>();

	// Start initial reads
	for (let i = 0; i < iterators.length; i++) {
		pending.set(i, iterators[i].next());
	}

	while (pending.size > 0) {
		// Wait for the first iterator to produce a result
		const entries = Array.from(pending.entries());
		const promises = entries.map(([index, promise]) =>
			promise.then(result => ({ index, result }))
		);

		const { index, result } = await Promise.race(promises);
		pending.delete(index);

		if (!result.done) {
			yield result.value;
			// Start next read from this iterator
			pending.set(index, iterators[index].next());
		}
		// If iterator is done, it's removed from pending and won't be read again
	}
}

/**
 * Convert an array to an async iterable
 */
export async function* fromArray<T>(items: readonly T[]): AsyncIterable<T> {
	for (const item of items) {
		yield item;
	}
}

/**
 * Add logging to an async iterable for debugging
 */
export async function* traced<T>(
	src: AsyncIterable<T>,
	name: string,
	itemLogger?: (item: T, index: number) => string
): AsyncIterable<T> {
	log('Starting trace for %s', name);
	let index = 0;

	try {
		for await (const item of src) {
			if (itemLogger) {
				log('%s[%d]: %s', name, index, itemLogger(item, index));
			} else {
				log('%s[%d]: %O', name, index, item);
			}
			yield item;
			index++;
		}
		log('Completed trace for %s (%d items)', name, index);
	} catch (error) {
		log('Error in trace for %s after %d items: %s', name, index, error);
		throw error;
	}
}
