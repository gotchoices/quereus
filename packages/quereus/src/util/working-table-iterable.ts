import type { Row } from '../common/types.js';

/**
 * A reusable async iterable for working table data that can be iterated multiple times.
 * Similar to CachedIterable but for runtime-generated working table data.
 * Used primarily in recursive CTE execution where the working table needs to be
 * accessed multiple times during recursive iterations.
 *
 * Note: This class intentionally does NOT manage row context. The consumer
 * (e.g. InternalRecursiveCTERef) is responsible for installing the appropriate
 * row context via its own createRowSlot. Doing it here would conflict with the
 * shared rowDescriptor used by the recursive CTE emitter's withRowContext calls.
 */
export class WorkingTableIterable implements AsyncIterable<Row> {
	constructor(private rows: Row[]) {}

	async *[Symbol.asyncIterator](): AsyncIterator<Row> {
		for (const row of this.rows) {
			yield row;
		}
	}
}

