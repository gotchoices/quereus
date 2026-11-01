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
 * Execution feeds it through {@link CardinalityFeedbackManager.publish}, which admits
 * only counts of committed state: a count taken inside a transaction is held until
 * that transaction commits ({@link CardinalityFeedbackManager.onCommitted}) and
 * dropped if it rolls back ({@link CardinalityFeedbackManager.onRolledBack}).
 *
 * A shift reaches prepared statements through `onShift`; each statement paces its
 * re-plans with a {@link FeedbackReplanState}.
 *
 * Nothing here is persisted: a new `Database` starts empty. See
 * docs/progressive-optimizer.md §3.2–3.6.
 */

import { createLogger } from '../common/logger.js';
import type { OptimizerTuning } from '../planner/optimizer-tuning.js';
import { CardinalityObservations } from '../runtime/cardinality-observations.js';
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
	/** True when no transaction (explicit or implicit) is open. */
	getAutocommit(): boolean;
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

/** The overlay's key for a table: lowercased `schema.table`. Shifts are reported under it. */
export function overlayTableKey(schemaName: string, tableName: string): string {
	return `${schemaName}.${tableName}`.toLowerCase();
}

function tableKey(table: TableSchema): string {
	return overlayTableKey(table.schemaName, table.name);
}

/** Cap on the cooldown's doubling: re-plans past the seventh wait `64 × replanCooldown` executions. */
const MAX_COOLDOWN_DOUBLINGS = 6;

/**
 * One prepared statement's feedback re-plan cooldown (docs/progressive-optimizer.md §3.6).
 * A shift marks the cached plan; the mark is acted on at an execution start, never
 * mid-execution. The first feedback re-plan is immediate; re-plan `k + 1` waits until the
 * statement has executed `cooldown × 2^min(k − 1, 6)` times since re-plan `k` — a mark
 * arriving sooner stays pending until then.
 */
export class FeedbackReplanState {
	private marked = false;
	/** Feedback re-plans so far. */
	private replans = 0;
	/** Executions started since the last feedback re-plan, the re-planning one included. */
	private executionsSinceReplan = 0;

	/** A table the cached plan reads shifted. */
	markShift(): void {
		this.marked = true;
	}

	/** The cached plan was dropped for any reason; whatever compiles next reads the current overlay. */
	onPlanDropped(): void {
		this.marked = false;
	}

	/** Counts one execution; true when the marked plan must be dropped before it runs. */
	onExecutionStart(cooldown: number): boolean {
		const due = this.marked && (this.replans === 0 || this.executionsSinceReplan >= this.requiredExecutions(cooldown));
		if (due) {
			this.marked = false;
			this.replans++;
			this.executionsSinceReplan = 0;
		}
		this.executionsSinceReplan++;
		return due;
	}

	private requiredExecutions(cooldown: number): number {
		return cooldown * 2 ** Math.min(this.replans - 1, MAX_COOLDOWN_DOUBLINGS);
	}
}

export class CardinalityFeedbackManager implements ObservedRowCounts {
	/**
	 * Lowercased `schema.table` → entry, the change-log / work-counter key convention.
	 * `Map` insertion order doubles as recency: a hit or a record re-inserts, so the
	 * first key is the least recently used.
	 */
	private readonly entries = new Map<string, ObservedEntry>();
	/**
	 * Observations made inside the open transaction, held until it ends; same key as
	 * `entries`, last count per table wins. Bounded by the distinct tables one
	 * transaction observes.
	 */
	private readonly pending = new Map<string, { readonly table: TableSchema; readonly rows: number }>();
	/** {@link onRolledBack} calls so far; each execution's sink records it at start. */
	private rollbacks = 0;
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

	/**
	 * Offer one finished execution's observations (docs/progressive-optimizer.md §3.5).
	 * A committed read (`readCommitted`) or an execution that ended with no transaction
	 * open saw committed state and is recorded now. Anything else may include the open
	 * transaction's uncommitted writes, so it is held for {@link onCommitted} — unless a
	 * rollback ran during the execution (typically a failing statement's own statement
	 * savepoint, which fires before publication): then a completed scan may have counted
	 * rows that no longer exist, and the whole execution is discarded.
	 */
	publish(observations: CardinalityObservations, options: { readCommitted: boolean }): void {
		if (options.readCommitted) {
			this.recordAll(observations);
		} else if (observations.rollbacksAtStart !== this.rollbacks) {
			debugLog('Discarded observations: work was rolled back during the execution');
		} else if (this.ctx.getAutocommit()) {
			this.recordAll(observations);
		} else {
			for (const [table, rows] of observations.entries()) {
				this.pending.set(tableKey(table), { table, rows });
			}
		}
	}

	/** A fresh per-execution sink, stamped so {@link publish} can tell whether a rollback ran under it. */
	beginObservations(): CardinalityObservations {
		return new CardinalityObservations(this.rollbacks);
	}

	/**
	 * The open transaction committed: record what it held, except tables it wrote.
	 * Such a count was taken mid-transaction, possibly before later writes in the same
	 * transaction, and the change log cannot say which came first. `changedCounts` is
	 * the change log keyed like `entries` — every table the transaction wrote, even one
	 * whose writes cancelled out — and is not built when nothing is held.
	 */
	onCommitted(changedCounts: () => Map<string, number>): void {
		// NOTE: external-change ingestion with `captureChanges: false` writes rows the change
		// log never sees, so a count held from before such a batch is applied. Only an estimate
		// lags; if those batches ever routinely shrink or grow tables, have them veto here too.
		if (this.pending.size === 0) return;
		try {
			const changed = changedCounts();
			for (const [key, { table, rows }] of this.pending) {
				if (changed.has(key)) {
					debugLog('Dropped %d rows for %s: the committing transaction wrote it', rows, key);
					continue;
				}
				this.record(table, rows);
			}
		} finally {
			this.pending.clear();
		}
	}

	/** The open transaction, or some of its work, was undone: forget everything held. */
	onRolledBack(): void {
		this.pending.clear();
		this.rollbacks++;
	}

	/** Forget every observation, held ones included; later compiles read the catalog only. */
	clear(): void {
		this.entries.clear();
		this.pending.clear();
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
		this.clear();
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

	private recordAll(observations: CardinalityObservations): void {
		for (const [table, rows] of observations.entries()) {
			this.record(table, rows);
		}
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
