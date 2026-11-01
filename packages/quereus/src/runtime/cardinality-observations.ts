/**
 * Per-execution sink for cardinality feedback (docs/progressive-optimizer.md §3.1): the
 * exact row counts of base tables a scan read in full during one execution, the
 * floors — "holds at least N rows" — proven by scans that read only part of a table, and
 * the rows each single-key equality seek through a non-unique index returned.
 *
 * The scan leaf (`runtime/emit/scan.ts`) reports here as each qualifying invocation
 * ends; the run site hands the sink to `CardinalityFeedbackManager.publish` once the
 * execution ends. Beyond dropping floors too small to ever be recorded, nothing here
 * decides whether an observation is worth keeping — that is the overlay's record policy.
 */

import type { TableSchema } from '../schema/table.js';

/**
 * What a rows-per-key site knows at emit time: which base columns its equality seek
 * looks up, their canonical key, and the rows per key the plan was priced with. Built
 * once per scan site, so an invocation composes no string.
 */
export interface RowsPerKeySpec {
	/** Sorted, de-duplicated base-column indexes of the seek's equality constraints. */
	readonly columns: readonly number[];
	/** `columns.join(',')` — the overlay's key for the column set within a table. */
	readonly key: string;
	/** The module's `estimatedRows` for this seek — what the plan used; a new entry's baseline. */
	readonly plannedRowsPerKey: number;
}

/** Samples of one column set's rows per key, summed within one execution. */
export interface RowsPerKeySamples {
	readonly spec: RowsPerKeySpec;
	sum: number;
	count: number;
}

export class CardinalityObservations {
	/**
	 * Keyed by schema object, not name: every scan in one execution was emitted from one
	 * compile, so a nested-loop inner's re-scans and a self-join's two scan sites share
	 * the object and collapse to one entry (last count wins) without composing a string
	 * per completed scan. The overlay re-keys by name when it records.
	 */
	private readonly counts = new Map<TableSchema, number>();
	/** Largest floor per table; same keying as `counts`. */
	private readonly floors = new Map<TableSchema, number>();
	/**
	 * Rows-per-key samples per table and column-set key; same table keying as `counts`.
	 * One invocation is one sample: a nested-loop inner probing 10,000 outer rows adds
	 * 10,000 samples to one key here, published once as a sum and a count. Forked parallel
	 * branches share this sink by reference (`parallel-driver.ts`, `shared-sink`); the
	 * updates are synchronous map writes, so interleaving cannot lose one.
	 */
	private readonly perKey = new Map<TableSchema, Map<string, RowsPerKeySamples>>();

	/**
	 * @param rollbacksAtStart The overlay's rollback count when the execution began;
	 * opaque here. If it has moved by publication, work this execution may have seen
	 * was undone under it (`CardinalityFeedbackManager.publish`).
	 * @param recordFloor The overlay's `cardinalityFeedback.minRows`: a floor at or below
	 * it can never be recorded, so it is dropped before touching a map — which is every
	 * point seek and `get()`.
	 */
	constructor(readonly rollbacksAtStart: number, private readonly recordFloor: number) {}

	observe(table: TableSchema, rows: number): void {
		this.counts.set(table, rows);
	}

	/**
	 * One scan invocation yielded `rows` distinct rows of `table`, so it holds at least
	 * that many. Re-scans keep the largest single invocation: their rows may overlap, so
	 * a sum would overstate.
	 */
	observeAtLeast(table: TableSchema, rows: number): void {
		if (rows <= this.recordFloor) return;
		const known = this.floors.get(table);
		if (known === undefined || rows > known) this.floors.set(table, rows);
	}

	/** One exhausted equality seek of `spec`'s column set on `table` yielded `rows` rows — one sample. */
	observeRowsPerKey(table: TableSchema, spec: RowsPerKeySpec, rows: number): void {
		let byKey = this.perKey.get(table);
		if (!byKey) {
			byKey = new Map();
			this.perKey.set(table, byKey);
		}
		const samples = byKey.get(spec.key);
		if (samples) {
			samples.sum += rows;
			samples.count++;
		} else {
			byKey.set(spec.key, { spec, sum: rows, count: 1 });
		}
	}

	get isEmpty(): boolean {
		return this.counts.size === 0 && this.floors.size === 0 && this.perKey.size === 0;
	}

	entries(): IterableIterator<[TableSchema, number]> {
		return this.counts.entries();
	}

	/** Floors of tables this execution did not also count exactly — the complete count supersedes. */
	*lowerBounds(): IterableIterator<[TableSchema, number]> {
		for (const entry of this.floors) {
			if (!this.counts.has(entry[0])) yield entry;
		}
	}

	/** Every column set sampled this execution, with its summed rows and sample count. */
	*rowsPerKey(): IterableIterator<[TableSchema, RowsPerKeySamples]> {
		for (const [table, byKey] of this.perKey) {
			for (const samples of byKey.values()) yield [table, samples];
		}
	}
}
