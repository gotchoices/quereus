/**
 * Per-execution sink for cardinality feedback: the exact row counts of base tables
 * that a scan read in full during one execution (docs/progressive-optimizer.md §3.1).
 *
 * The scan leaf (`runtime/emit/scan.ts`) reports here when a qualifying scan runs to
 * natural exhaustion; the run site hands the sink to
 * `CardinalityFeedbackManager.publish` once the execution ends. Nothing here decides
 * whether a count is worth keeping — that is the overlay's record policy.
 */

import type { TableSchema } from '../schema/table.js';

export class CardinalityObservations {
	/**
	 * Keyed by schema object, not name: every scan in one execution was emitted from one
	 * compile, so a nested-loop inner's re-scans and a self-join's two scan sites share
	 * the object and collapse to one entry (last count wins) without composing a string
	 * per completed scan. The overlay re-keys by name when it records.
	 */
	private readonly counts = new Map<TableSchema, number>();

	observe(table: TableSchema, rows: number): void {
		this.counts.set(table, rows);
	}

	get isEmpty(): boolean {
		return this.counts.size === 0;
	}

	entries(): IterableIterator<[TableSchema, number]> {
		return this.counts.entries();
	}
}
