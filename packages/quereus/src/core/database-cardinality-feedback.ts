/**
 * The observed row-count overlay: exact base-table sizes seen during execution.
 *
 * One per `Database`. The planner reads it through `plannedRowCount`
 * (`planner/stats/table-cardinality.ts`), where an answering entry outranks the
 * catalog's `ANALYZE` count. This module owns the record policy — which
 * observations are worth keeping, and when one has moved far enough from what
 * plans were costed against to call it a *shift* — and the entries' lifetime.
 *
 * Validity is schema identity: an entry answers only for the exact `TableSchema`
 * object it was observed under. Any swap (`ANALYZE`, `ALTER TABLE`, drop and
 * re-create) silences it, and a schema-change listener evicts it. The identity
 * check is the correctness guard; the listener is memory hygiene.
 *
 * Nothing here is persisted: a new `Database` starts empty. See
 * docs/progressive-optimizer.md §3.2–3.4.
 */

import { createLogger } from '../common/logger.js';
import type { OptimizerTuning } from '../planner/optimizer-tuning.js';
import { catalogRowCount, type ObservedRowCounts } from '../planner/stats/table-cardinality.js';
import type { SchemaChangeEvent } from '../schema/change-events.js';
import type { TableSchema } from '../schema/table.js';
import type { Database } from './database.js';

const log = createLogger('core:cardinality-feedback');
const debugLog = log.extend('debug');

/** Database internals the manager needs — keeps it constructible without the full `Database`. */
export interface CardinalityFeedbackManagerContext {
	readonly schemaManager: Database['schemaManager'];
	/** Read on every record, so `Database.updateOptimizerTuning` takes effect immediately. */
	getTuning(): OptimizerTuning;
	/**
	 * A recorded count moved at least `cardinalityFeedback.shiftFactor` away from the
	 * entry's baseline: plans costed against the old number may be wrong. `key` is the
	 * lowercased `schema.table`.
	 */
	onShift(key: string): void;
}

interface ObservedEntry {
	/** The schema object the count was observed under; the entry answers for no other. */
	readonly schema: TableSchema;
	/** Latest recorded exact row count. */
	rows: number;
	/** The count shifts are measured against: the pre-entry estimate, or the count at the last shift. */
	baselineRows: number;
	observations: number;
	shifts: number;
}

/** By-value view of one valid entry, for tests and diagnostics. */
export interface ObservedRowCountSnapshot {
	readonly schemaName: string;
	readonly tableName: string;
	readonly rows: number;
	/** What the catalog (`ANALYZE`) says for the same table; `undefined` when never analyzed. */
	readonly catalogRows: number | undefined;
	readonly baselineRows: number;
	readonly observations: number;
	readonly shifts: number;
}

/**
 * Distance between two counts as a ratio ≥ 1. The `+ 1` on both sides keeps a zero
 * count finite and makes tiny counts compare sanely (0 vs 3 is 4×, not infinite).
 */
function rowCountSpread(a: number, b: number): number {
	return (Math.max(a, b) + 1) / (Math.min(a, b) + 1);
}

function tableKey(table: TableSchema): string {
	return `${table.schemaName}.${table.name}`.toLowerCase();
}

export class CardinalityFeedbackManager implements ObservedRowCounts {
	/**
	 * Lowercased `schema.table` → entry, the change-log / work-counter key convention.
	 * `Map` insertion order doubles as recency: a hit or a record re-inserts, so the
	 * first key is the least recently used.
	 */
	private readonly entries = new Map<string, ObservedEntry>();
	private unsubscribeSchemaChanges: (() => void) | null = null;

	constructor(private readonly ctx: CardinalityFeedbackManagerContext) {
		this.subscribeToSchemaChanges();
	}

	observedRows(table: TableSchema): number | undefined {
		const key = tableKey(table);
		const entry = this.entries.get(key);
		if (!entry || entry.schema !== table) return undefined;
		this.touch(key, entry);
		return entry.rows;
	}

	/**
	 * Offer one exact row count of `table`, observed by a complete enumeration of
	 * committed state. Applies the record policy (docs/progressive-optimizer.md §3.4):
	 * ignored when the schema object is superseded or when both the observation and the
	 * current estimate are small; otherwise recorded, and reported through `onShift`
	 * when it has moved `shiftFactor` from the entry's baseline.
	 */
	record(table: TableSchema, rows: number): void {
		if (this.ctx.schemaManager.findTable(table.name, table.schemaName) !== table) {
			debugLog('Ignored %d rows for %s.%s: observed under a superseded schema', rows, table.schemaName, table.name);
			return;
		}
		const tuning = this.ctx.getTuning();
		const policy = tuning.cardinalityFeedback;
		const key = tableKey(table);
		const existing = this.validEntry(key, table);
		const before = existing?.rows ?? catalogRowCount(table) ?? tuning.defaultRowEstimate;
		if (Math.max(before, rows) <= policy.minRows) return;

		const entry = existing ?? { schema: table, rows, baselineRows: before, observations: 0, shifts: 0 };
		entry.rows = rows;
		entry.observations++;
		this.touch(key, entry);
		this.evictBeyond(policy.maxTables);

		const shifted = rowCountSpread(rows, entry.baselineRows) >= policy.shiftFactor;
		debugLog('Recorded %d rows for %s (was %d, baseline %d)%s', rows, key, before, entry.baselineRows, shifted ? ' — shift' : '');
		if (!shifted) return;
		entry.baselineRows = rows;
		entry.shifts++;
		this.ctx.onShift(key);
	}

	/** Forget every observation; later compiles read the catalog only. */
	clear(): void {
		this.entries.clear();
	}

	/** Valid entries, by value, least recently used first. Does not refresh recency. */
	snapshot(): ObservedRowCountSnapshot[] {
		const out: ObservedRowCountSnapshot[] = [];
		for (const entry of this.entries.values()) {
			const { schema } = entry;
			if (this.ctx.schemaManager.findTable(schema.name, schema.schemaName) !== schema) continue;
			out.push({
				schemaName: schema.schemaName,
				tableName: schema.name,
				rows: entry.rows,
				catalogRows: catalogRowCount(schema),
				baselineRows: entry.baselineRows,
				observations: entry.observations,
				shifts: entry.shifts,
			});
		}
		return out;
	}

	dispose(): void {
		if (this.unsubscribeSchemaChanges) {
			this.unsubscribeSchemaChanges();
			this.unsubscribeSchemaChanges = null;
		}
		this.entries.clear();
	}

	private subscribeToSchemaChanges(): void {
		const notifier = this.ctx.schemaManager.getChangeNotifier();
		this.unsubscribeSchemaChanges = notifier.addListener((event: SchemaChangeEvent) => {
			// Keyed by `oldObject`, not the event's name: a rename reports the NEW name.
			// `DETACH` fires no per-table events; its tables' entries never match again
			// and age out under the LRU cap.
			if (event.type === 'table_modified' || event.type === 'table_removed') {
				this.entries.delete(tableKey(event.oldObject));
			}
		});
	}

	/** The entry under `key` if it was observed against `table`; a stale one is replaced on record. */
	private validEntry(key: string, table: TableSchema): ObservedEntry | undefined {
		const entry = this.entries.get(key);
		return entry?.schema === table ? entry : undefined;
	}

	private touch(key: string, entry: ObservedEntry): void {
		this.entries.delete(key);
		this.entries.set(key, entry);
	}

	/**
	 * Drop least-recently-used entries past the cap. No `onShift`: plans already built
	 * keep their snapshot, and the next compile falls back to catalog or default numbers.
	 */
	private evictBeyond(maxTables: number): void {
		for (const key of this.entries.keys()) {
			if (this.entries.size <= maxTables) return;
			this.entries.delete(key);
		}
	}
}
