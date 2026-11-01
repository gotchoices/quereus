/**
 * The observed row-count overlay: exact base-table sizes seen during execution.
 *
 * One per `Database`. The planner reads it through `plannedRowCount`
 * (`planner/stats/table-cardinality.ts`), where an answering entry outranks the
 * catalog's `ANALYZE` count and a module's approximate count, but not a module's
 * exact one, and through `plannedRowsPerKey`, where an entry's rows per key answers
 * unless the catalog's statistics cover the column set. This module owns the record
 * policy — which observations are worth keeping, and when one has moved far enough
 * from what plans were costed against to call it a *shift* — and the entries' lifetime.
 *
 * Validity is schema identity: an entry answers only for the exact `TableSchema`
 * object it was observed under. Any swap (`ANALYZE`, `ALTER TABLE`, drop and
 * re-create) silences it, and a schema-change listener evicts it. The identity
 * check is the correctness guard; the listener is memory hygiene.
 *
 * An entry holds an exact count from a complete read, a floor ("at least N rows") from a
 * partial one, or both; a floor only ever raises an estimate, and an exact count clears it.
 * Beside them it keeps, per equality column set the table is seeked on through a
 * non-unique index, a running mean of the rows one key matched ({@link PerKeyEntry}).
 *
 * Execution feeds it through {@link CardinalityFeedbackManager.publish}, which admits
 * only observations of committed state: one made inside a transaction is held until
 * that transaction commits ({@link CardinalityFeedbackManager.onCommitted}) and
 * dropped if it rolls back ({@link CardinalityFeedbackManager.onRolledBack}).
 *
 * A shift reaches prepared statements through `onShift`; each statement paces its
 * re-plans with a {@link FeedbackReplanState}. A module-reported size, which moves with
 * no observation at all, is re-checked by each statement at execution start against the
 * size its plan was costed with ({@link ReportedSizeSnapshot}).
 *
 * Nothing here is persisted: a new `Database` starts empty. See
 * docs/progressive-optimizer.md §3.2–3.6.
 */

import { createLogger } from '../common/logger.js';
import type { OptimizerTuning } from '../planner/optimizer-tuning.js';
import { CardinalityObservations, columnSetKey, type RowsPerKeySamples, type RowsPerKeySpec } from '../runtime/cardinality-observations.js';
import {
	catalogRowCount, moduleReportsRowCount, plannedRowCount,
	type ObservedKeyCardinalities, type ObservedRowCount, type ObservedRowCounts,
} from '../planner/stats/table-cardinality.js';
import type { SchemaDependency } from '../planner/planning-context.js';
import type { SchemaChangeEvent } from '../schema/change-events.js';
import type { TableSchema } from '../schema/table.js';
import type { Database } from './database.js';
import type { ModuleRowCount } from '../vtab/module.js';

const log = createLogger('core:cardinality-feedback');
const debugLog = log.extend('debug');

/** Database internals the manager needs — keeps it constructible without the full `Database`. */
export interface CardinalityFeedbackManagerContext {
	readonly schemaManager: Database['schemaManager'];
	/** Read on every record, so `Database.updateOptimizerTuning` takes effect immediately. */
	getTuning(): OptimizerTuning;
	/** True when no transaction (explicit or implicit) is open. */
	getAutocommit(): boolean;
	/** The table's module's own count (`RowCountSources.reportedRows`), ranked with this overlay's entry. */
	reportedRows(table: TableSchema): ModuleRowCount | undefined;
	/**
	 * A recorded count, floor or rows-per-key mean moved at least
	 * `cardinalityFeedback.shiftFactor` away from its baseline: plans costed against the
	 * old number may be wrong. `key` is the lowercased `schema.table` — one key for every
	 * kind, so a per-key shift re-plans every statement reading the table, seeking or not.
	 */
	onShift(key: string): void;
}

/**
 * Rows per key of one equality column set, learned from exhausted seeks
 * (docs/progressive-optimizer.md §3.2). One mean per column set, whatever the key
 * values — the uniform assumption `ANALYZE` statistics make.
 */
interface PerKeyEntry {
	/** Sorted base-column indexes of the equality set. */
	readonly columns: readonly number[];
	/** Rows per key, a running average. */
	mean: number;
	/** Samples folded into `mean` so far. */
	samples: number;
	/** The rows per key planning priced the seek at before the first record, or the mean at the last shift. */
	baseline: number;
	shifts: number;
}

interface ObservedEntry extends ObservedRowCount {
	/** The schema object the count was observed under; the entry answers for no other. */
	readonly schema: TableSchema;
	/** Latest recorded exact row count; undefined while the table is known only from below. */
	rows: number | undefined;
	/** Largest floor recorded since the last exact count, which clears it. */
	atLeast: number | undefined;
	/** The count shifts are measured against: the pre-entry estimate, or the count at the last shift. */
	baselineRows: number;
	/** Counts, floors and rows-per-key batches recorded. */
	observations: number;
	shifts: number;
	/**
	 * Rows per key by column-set key (`RowsPerKeySpec.key`). Insertion order is recency —
	 * re-inserted on record — bounded by `cardinalityFeedback.maxKeySetsPerTable`.
	 */
	readonly perKey: Map<string, PerKeyEntry>;
}

/** Observations held for the open transaction's commit, per table. */
interface HeldObservation {
	readonly table: TableSchema;
	rows: number | undefined;
	atLeast: number | undefined;
	/** Rows-per-key samples summed across the transaction's executions, by column-set key. */
	readonly perKey: Map<string, RowsPerKeySamples>;
}

/** By-value view of one column set's rows per key, for tests and diagnostics. */
export interface ObservedRowsPerKeySnapshot {
	/** Column names, in the order of their sorted indexes. */
	readonly keyColumns: readonly string[];
	readonly rowsPerKey: number;
	readonly samples: number;
	readonly baselineRowsPerKey: number;
	readonly shifts: number;
}

/** By-value view of one valid entry, for tests and diagnostics. */
export interface ObservedRowCountSnapshot {
	readonly schemaName: string;
	readonly tableName: string;
	readonly rows: number | undefined;
	readonly atLeast: number | undefined;
	/** What the catalog (`ANALYZE`) says for the same table; `undefined` when never analyzed. */
	readonly catalogRows: number | undefined;
	readonly baselineRows: number;
	readonly observations: number;
	readonly shifts: number;
	/** Least recently recorded first. */
	readonly perKey: readonly ObservedRowsPerKeySnapshot[];
}

/**
 * Samples a rows-per-key mean tracks exactly before it becomes an exponential average:
 * up to this many, the mean is the exact running mean of every sample; past it, each
 * sample weighs 1/32, so a changing distribution is followed rather than averaged away.
 * A module constant, not a tuning knob — nothing a deployment would turn.
 */
const ROWS_PER_KEY_WINDOW = 32;

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

function newEntry(schema: TableSchema, baselineRows: number): ObservedEntry {
	return { schema, rows: undefined, atLeast: undefined, baselineRows, observations: 0, shifts: 0, perKey: new Map() };
}

/**
 * Folds a batch of `count` samples averaging `batchMean` into `entry` (docs/progressive-optimizer.md
 * §3.4): with `n` samples already held the batch weighs `min(1, count / min(n + count, WINDOW))` —
 * the exact running mean up to the window, 1/32 per sample past it, and a batch at least the
 * window's size replaces the mean outright.
 */
function foldRowsPerKey(entry: PerKeyEntry, batchMean: number, count: number): void {
	const weight = Math.min(1, count / Math.min(entry.samples + count, ROWS_PER_KEY_WINDOW));
	entry.mean += (batchMean - entry.mean) * weight;
	entry.samples += count;
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

/** A table a compiled plan was sized with by its module, and the row count the plan was costed with. */
interface PlannedTableSize {
	readonly table: TableSchema;
	readonly rows: number;
}

/**
 * The planned sizes, as of one compile, of the tables the plan reads whose module reports
 * its own count (docs/progressive-optimizer.md §3.6). Such a count moves on every write
 * with no event the planner hears, and a plan that no longer reads the table in full
 * never produces an observation, so nothing else notices that a table planned at 10 rows
 * now holds a million. A prepared statement compares its snapshot with the current
 * planned sizes at each execution start and treats a drift like an overlay shift.
 *
 * Planned sizes, not raw module answers, are compared, so an approximate count the
 * overlay outranks drifts only when what planning would use drifts.
 */
export class ReportedSizeSnapshot {
	static readonly empty = new ReportedSizeSnapshot([]);

	private constructor(private readonly sizes: readonly PlannedTableSize[]) {}

	/**
	 * Called right after a compile, in the same synchronous turn, so each size is the one
	 * the plan's table references were costed with. Tables whose module has no
	 * `getRowCount` are left out: overlay shifts and schema changes already cover them.
	 */
	static capture(db: Database, dependencies: readonly SchemaDependency[]): ReportedSizeSnapshot {
		// NOTE: write targets are kept too (dependencies do not record read vs write), so a
		// prepared `insert` driving a bulk load re-plans at each 10× of its target, paced by
		// the cooldown; if those re-plans ever show up in a profile, record dependency roles
		// in the builder and keep only read tables here.
		const sizes: PlannedTableSize[] = [];
		for (const dep of dependencies) {
			if (dep.type !== 'table' || !dep.schemaName) continue;
			const table = db.schemaManager.findTable(dep.objectName, dep.schemaName);
			if (table && moduleReportsRowCount(db, table)) sizes.push({ table, rows: currentPlannedRows(db, table) });
		}
		return sizes.length > 0 ? new ReportedSizeSnapshot(sizes) : ReportedSizeSnapshot.empty;
	}

	/**
	 * True when some table's planned size has moved `shiftFactor` from the captured one
	 * with the larger side above `minRows` — the overlay's shift rule (§3.4). A table whose
	 * catalog object was replaced is skipped: that schema change already dropped the plan.
	 */
	drifted(db: Database): boolean {
		if (this.sizes.length === 0) return false;
		const { shiftFactor, minRows } = db.optimizer.tuning.cardinalityFeedback;
		for (const { table, rows } of this.sizes) {
			if (db.schemaManager.findTable(table.name, table.schemaName) !== table) continue;
			const now = currentPlannedRows(db, table);
			if (Math.max(now, rows) > minRows && rowCountSpread(now, rows) >= shiftFactor) {
				debugLog('Reported size drift on %s: planned %d, now %d rows', tableKey(table), rows, now);
				return true;
			}
		}
		return false;
	}
}

/** What planning would size `table` at now; an unknown size reads as `defaultRowEstimate`, as in the overlay's record policy. */
function currentPlannedRows(db: Database, table: TableSchema): number {
	return plannedRowCount(table, db._rowCountSources) ?? db.optimizer.tuning.defaultRowEstimate;
}

export class CardinalityFeedbackManager implements ObservedRowCounts, ObservedKeyCardinalities {
	/**
	 * Lowercased `schema.table` → entry, the change-log / work-counter key convention.
	 * `Map` insertion order doubles as recency: a hit or a record re-inserts, so the
	 * first key is the least recently used.
	 */
	private readonly entries = new Map<string, ObservedEntry>();
	/**
	 * Observations made inside the open transaction, held until it ends; same key as
	 * `entries`, last count and largest floor per table win. Bounded by the distinct
	 * tables one transaction observes.
	 */
	private readonly pending = new Map<string, HeldObservation>();
	/** {@link onRolledBack} calls so far; each execution's sink records it at start. */
	private rollbacks = 0;
	private unsubscribeSchemaChanges: (() => void) | null = null;

	constructor(private readonly ctx: CardinalityFeedbackManagerContext) {
		this.subscribeToSchemaChanges();
	}

	observedRows(table: TableSchema): ObservedRowCount | undefined {
		const key = tableKey(table);
		const entry = this.entries.get(key);
		if (!entry || entry.schema !== table) return undefined;
		this.touch(key, entry);
		return entry;
	}

	/** The running mean for `columns` on `table`, under the same identity rule as {@link observedRows}; a hit refreshes the table's recency. */
	observedRowsPerKey(table: TableSchema, columns: readonly number[]): number | undefined {
		const key = tableKey(table);
		const entry = this.entries.get(key);
		if (!entry || entry.schema !== table) return undefined;
		const keyEntry = entry.perKey.get(columnSetKey(columns));
		if (!keyEntry) return undefined;
		this.touch(key, entry);
		return keyEntry.mean;
	}

	/**
	 * Offer one exact row count of `table`, observed by a complete enumeration of
	 * committed state. Applies the record policy (docs/progressive-optimizer.md §3.4):
	 * ignored when the schema object is superseded or when both the observation and the
	 * current estimate are small; otherwise recorded — clearing any floor, which the newer
	 * complete count supersedes — and reported through `onShift` when it has moved
	 * `shiftFactor` from the entry's baseline.
	 */
	record(table: TableSchema, rows: number): void {
		if (this.isSuperseded(table)) return;
		const policy = this.ctx.getTuning().cardinalityFeedback;
		const key = tableKey(table);
		const existing = this.validEntry(key, table);
		// NOTE: an exactly module-sized table still records an entry, which `plannedRowCount`
		// never reads while the module answers — one LRU slot each; if `maxTables` pressure
		// ever matters, skip recording when the module's count is exact.
		const before = this.plannedBefore(table, existing);
		if (Math.max(before, rows) <= policy.minRows) return;

		const entry = this.upsert(key, existing ?? newEntry(table, before));
		entry.rows = rows;
		entry.atLeast = undefined;
		debugLog('Recorded %d rows for %s (was %d, baseline %d)', rows, key, before, entry.baselineRows);
		this.shiftIfMoved(key, entry, rows);
	}

	/**
	 * Offer one floor for `table`: a read of committed state yielded `rows` distinct rows of
	 * it, so it holds at least that many (docs/progressive-optimizer.md §3.4). Recorded only
	 * when it exceeds both what planning would use now and `minRows`, so a floor never
	 * lowers an estimate and never makes an unknown table look smaller than the default it
	 * plans at today. Shifts like a count; floors only raise, so they cannot oscillate.
	 */
	recordAtLeast(table: TableSchema, rows: number): void {
		if (this.isSuperseded(table)) return;
		const policy = this.ctx.getTuning().cardinalityFeedback;
		const key = tableKey(table);
		const existing = this.validEntry(key, table);
		const before = this.plannedBefore(table, existing);
		if (rows <= before || rows <= policy.minRows) return;

		const entry = this.upsert(key, existing ?? newEntry(table, before));
		entry.atLeast = Math.max(entry.atLeast ?? 0, rows);
		debugLog('Recorded at least %d rows for %s (was %d, baseline %d)', rows, key, before, entry.baselineRows);
		this.shiftIfMoved(key, entry, rows);
	}

	/**
	 * Offer `count` samples of rows per key for `spec`'s column set on `table`, summing to
	 * `sum` rows — one sample per exhausted equality seek with non-NULL keys
	 * (docs/progressive-optimizer.md §3.4). Ignored under a superseded schema, and unless
	 * the table's planned size exceeds `minRows`: below that every plan finishes fast, and
	 * the gate keeps small-table plans unchanged exactly as the count gate does. So a table
	 * of unknown size learns rows per key only once its size is learned (a complete scan,
	 * a floor, or a module count above the gate); publication applies per-key batches
	 * after the same execution's counts and floors, so one execution can open the gate for
	 * itself. A new column-set entry's baseline is the rows per key the plan was priced
	 * with; the table remembers at most `maxKeySetsPerTable` sets, least recently recorded
	 * evicted. Accepted bias: frequently probed keys weigh more than a uniform sample would.
	 * Reported through `onShift` under the table's key when the folded mean has moved
	 * `shiftFactor` from the set's baseline — the count rule, applied to the mean.
	 */
	recordRowsPerKey(table: TableSchema, spec: RowsPerKeySpec, sum: number, count: number): void {
		if (count <= 0 || this.isSuperseded(table)) return;
		const policy = this.ctx.getTuning().cardinalityFeedback;
		const key = tableKey(table);
		const existing = this.validEntry(key, table);
		const before = this.plannedBefore(table, existing);
		if (before <= policy.minRows) return;
		// NOTE: a set the catalog's statistics cover is recorded too, though `plannedRowsPerKey`
		// never consults it under this schema object (an `ANALYZE` swaps the object before
		// coverage can change), so under a stale catalog its first record can shift once and
		// re-plan statements that land the same plan; if that re-plan ever shows in a profile,
		// skip the record when `catalogCoversColumns` holds.

		const entry = this.upsert(key, existing ?? newEntry(table, before));
		const batchMean = sum / count;
		let keyEntry = entry.perKey.get(spec.key);
		if (keyEntry) {
			entry.perKey.delete(spec.key);
			foldRowsPerKey(keyEntry, batchMean, count);
		} else {
			keyEntry = { columns: spec.columns, mean: batchMean, samples: count, baseline: spec.plannedRowsPerKey, shifts: 0 };
		}
		entry.perKey.set(spec.key, keyEntry);
		for (const staleKey of entry.perKey.keys()) {
			if (entry.perKey.size <= policy.maxKeySetsPerTable) break;
			entry.perKey.delete(staleKey);
		}
		debugLog('Recorded %d rows per key over %d samples for %s (%s) (mean now %d, baseline %d)',
			batchMean, count, key, spec.key, keyEntry.mean, keyEntry.baseline);
		this.shiftIfRowsPerKeyMoved(key, spec.key, keyEntry);
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
			this.holdAll(observations);
		}
	}

	/**
	 * A fresh per-execution sink, stamped so {@link publish} can tell whether a rollback ran
	 * under it, and carrying the record floor so it can drop floors that could never record.
	 */
	beginObservations(): CardinalityObservations {
		return new CardinalityObservations(this.rollbacks, this.ctx.getTuning().cardinalityFeedback.minRows);
	}

	/**
	 * The open transaction committed: record what it held, except tables it wrote.
	 * Such an observation was made mid-transaction, possibly before later writes in the
	 * same transaction, and the change log cannot say which came first. `changedCounts` is
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
			for (const [key, held] of this.pending) {
				if (changed.has(key)) {
					debugLog('Dropped observations of %s: the committing transaction wrote it', key);
					continue;
				}
				this.recordHeld(held);
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
				atLeast: entry.atLeast,
				catalogRows: catalogRowCount(schema),
				baselineRows: entry.baselineRows,
				observations: entry.observations,
				shifts: entry.shifts,
				perKey: [...entry.perKey.values()].map(keyEntry => ({
					keyColumns: keyEntry.columns.map(i => schema.columns[i].name),
					rowsPerKey: keyEntry.mean,
					samples: keyEntry.samples,
					baselineRowsPerKey: keyEntry.baseline,
					shifts: keyEntry.shifts,
				})),
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

	/**
	 * Exact counts first: a floor at or below the count just recorded is then ignored.
	 * Rows per key last, so a count or floor from the same execution can open its table-size gate.
	 */
	private recordAll(observations: CardinalityObservations): void {
		for (const [table, rows] of observations.entries()) {
			this.record(table, rows);
		}
		for (const [table, rows] of observations.lowerBounds()) {
			this.recordAtLeast(table, rows);
		}
		for (const [table, { spec, sum, count }] of observations.rowsPerKey()) {
			this.recordRowsPerKey(table, spec, sum, count);
		}
	}

	private holdAll(observations: CardinalityObservations): void {
		for (const [table, rows] of observations.entries()) {
			this.held(table).rows = rows;
		}
		for (const [table, rows] of observations.lowerBounds()) {
			const held = this.held(table);
			held.atLeast = Math.max(held.atLeast ?? 0, rows);
		}
		for (const [table, { spec, sum, count }] of observations.rowsPerKey()) {
			const held = this.held(table).perKey;
			const heldSamples = held.get(spec.key);
			if (heldSamples) {
				heldSamples.sum += sum;
				heldSamples.count += count;
			} else {
				held.set(spec.key, { spec, sum, count });
			}
		}
	}

	/** What is held for `table`; anything held under an older schema object for its name is superseded. */
	private held(table: TableSchema): HeldObservation {
		const key = tableKey(table);
		const existing = this.pending.get(key);
		if (existing?.table === table) return existing;
		const fresh: HeldObservation = { table, rows: undefined, atLeast: undefined, perKey: new Map() };
		this.pending.set(key, fresh);
		return fresh;
	}

	/** As {@link recordAll}: the count first, so a floor it already covers is ignored, and rows per key last. */
	private recordHeld({ table, rows, atLeast, perKey }: HeldObservation): void {
		if (rows !== undefined) this.record(table, rows);
		if (atLeast !== undefined) this.recordAtLeast(table, atLeast);
		for (const { spec, sum, count } of perKey.values()) this.recordRowsPerKey(table, spec, sum, count);
	}

	private isSuperseded(table: TableSchema): boolean {
		if (this.ctx.schemaManager.findTable(table.name, table.schemaName) === table) return false;
		debugLog('Ignored an observation of %s.%s: made under a superseded schema', table.schemaName, table.name);
		return true;
	}

	/**
	 * What planning would use for `table` right now — `existing` ranked with the module's
	 * count and the catalog's (§3.3), else the default — so an exactly module-sized table
	 * compares against the module and a scan agreeing with it shifts nothing.
	 */
	private plannedBefore(table: TableSchema, existing: ObservedEntry | undefined): number {
		return plannedRowCount(table, {
			observedRows: () => existing,
			reportedRows: t => this.ctx.reportedRows(t),
		}) ?? this.ctx.getTuning().defaultRowEstimate;
	}

	/** Counts one recorded observation on `entry`, makes it the most recent, and enforces the cap. */
	private upsert(key: string, entry: ObservedEntry): ObservedEntry {
		entry.observations++;
		this.touch(key, entry);
		this.evictBeyond(this.ctx.getTuning().cardinalityFeedback.maxTables);
		return entry;
	}

	/** Reports a shift through `onShift` when `rows` has moved `shiftFactor` from the entry's baseline. */
	private shiftIfMoved(key: string, entry: ObservedEntry, rows: number): void {
		if (rowCountSpread(rows, entry.baselineRows) < this.ctx.getTuning().cardinalityFeedback.shiftFactor) return;
		log('Shift on %s: baseline %d -> %d rows', key, entry.baselineRows, rows);
		entry.baselineRows = rows;
		entry.shifts++;
		this.ctx.onShift(key);
	}

	/**
	 * Reports a shift through `onShift` when a column set's mean has moved `shiftFactor`
	 * from its baseline. The table key is reported, not the set: a statement that reads the
	 * table re-plans and every seek node in it re-snapshots the overlay (§3.6). A set's first
	 * record cannot shift when its plan was already priced from the mean (the baseline is what
	 * the plan used); a set re-created after eviction carries the module's estimate again and
	 * may shift once, landing the same plan.
	 */
	private shiftIfRowsPerKeyMoved(key: string, setKey: string, keyEntry: PerKeyEntry): void {
		if (rowCountSpread(keyEntry.mean, keyEntry.baseline) < this.ctx.getTuning().cardinalityFeedback.shiftFactor) return;
		log('Shift on %s (%s): rows per key baseline %d -> %d', key, setKey, keyEntry.baseline, keyEntry.mean);
		keyEntry.baseline = keyEntry.mean;
		keyEntry.shifts++;
		this.ctx.onShift(key);
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
