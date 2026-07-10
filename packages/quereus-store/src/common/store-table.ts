/**
 * Generic KVStore-backed Virtual Table implementation.
 *
 * This is a platform-agnostic table implementation that works with any
 * KVStore implementation (LevelDB, IndexedDB, or custom stores).
 *
 * Storage architecture:
 *   - Data store: {schema}.{table} - row data keyed by encoded PK
 *   - Index stores: {schema}.{table}_idx_{name} - one per secondary index
 *   - Stats store: __stats__ - unified store for all table statistics, keyed by {schema}.{table}
 */

import {
	VirtualTable,
	IndexConstraintOp,
	ConflictResolution,
	QuereusError,
	StatusCode,
	compareSqlValues,
	compareSqlValuesFast,
	resolveUniqueEnforcementCollations,
	BINARY_COLLATION,
	rowsValueIdentical,
	validateAndParse,
	compilePredicate,
	maintainedTableUniqueViolationError,
	uniqueEnforcementCollations,
	logicalTypeCanHoldText,
	type Database,
	type DatabaseInternal,
	type CollationFunction,
	type CollationResolver,
	type ColumnSchema,
	type MaintainedTableSchema,
	type TableSchema,
	type TableIndexSchema,
	type UniqueConstraintSchema,
	type CompiledPredicate,
	type Row,
	type FilterInfo,
	type SqlValue,
	type VirtualTableConnection,
	type UpdateArgs,
	type VirtualTableModule,
	type UpdateResult,
	type BackingRowChange,
} from '@quereus/quereus';

import type { IterateOptions, KVEntry, KVStore } from './kv-store.js';
import { bytesEqual, bytesToHex, compareBytes } from './bytes.js';
import type { StoreEventEmitter } from './events.js';
import type { TransactionCoordinator } from './transaction.js';
import { StoreConnection } from './store-connection.js';
import {
	buildDataKey,
	buildIndexKey,
	buildIndexPrefixBounds,
	buildFullScanBounds,
	buildPkPrefixBounds,
	buildStatsKey,
} from './key-builder.js';
import {
	serializeRow,
	deserializeRow,
	serializeStats,
	deserializeStats,
	type TableStats,
} from './serialization.js';
import { type EncodeOptions } from './encoding.js';

/** Number of mutations before persisting statistics. */
const STATS_FLUSH_INTERVAL = 100;

/** True when `key` falls within the (gte/gt/lte/lt) window of `bounds`. */
function keyWithinBounds(key: Uint8Array, bounds: IterateOptions): boolean {
	if (bounds.gte && compareBytes(key, bounds.gte) < 0) return false;
	if (bounds.gt && compareBytes(key, bounds.gt) <= 0) return false;
	if (bounds.lte && compareBytes(key, bounds.lte) > 0) return false;
	if (bounds.lt && compareBytes(key, bounds.lt) >= 0) return false;
	return true;
}

/**
 * Resolves the per-constraint default conflict action for PK conflicts.
 * Prefers the table-level `PRIMARY KEY (...) ON CONFLICT <action>` clause
 * over any column-level `defaultConflict` declared on a PK column.
 *
 * Mirrors the helpers in `quereus/.../layer/manager.ts` and
 * `quereus-isolation/.../isolated-table.ts` — the three-tier precedence
 * `statement OR > per-constraint default > ABORT` must agree across all
 * three implementations.
 */
function resolvePkDefaultConflict(schema: TableSchema): ConflictResolution | undefined {
	if (schema.primaryKeyDefaultConflict !== undefined) return schema.primaryKeyDefaultConflict;
	for (const def of schema.primaryKeyDefinition) {
		const col = schema.columns[def.index];
		if (col?.defaultConflict !== undefined) return col.defaultConflict;
	}
	return undefined;
}

/**
 * Resolve the per-column KEY collation for each primary-key column.
 *
 * The store encodes PRIMARY KEY uniqueness/ordering PHYSICALLY in the key bytes,
 * so each text PK column's key must be encoded under that column's declared
 * collation. Returns one entry per PK member, in `pkDef` order:
 *   - text member → its declared `collation` (normalized upper-case), or
 *     `fallback` (the table key collation K) when the column carries none.
 *   - non-text member → `undefined`: collation is meaningless for
 *     integer/real/blob keys (they encode type-natively), so the encoder ignores
 *     it and the data/index key bytes are identical regardless.
 *
 * Every name returned here is encoded through the key-normalizer resolver carried
 * in `EncodeOptions.normalizers` (`db.getKeyNormalizerResolver()`), so a collation
 * registered or overridden with `db.registerCollation` produces key bytes that agree
 * with the comparator the store's UNIQUE enforcement uses. A collation that cannot
 * key — unregistered, or registered with a comparator but no normalizer — is rejected
 * at DDL time by {@link StoreTable.validateKeyCollations}, so no encode call ever has
 * to fall back. Shared by {@link StoreTable} (data-key + index-maintenance) and
 * `StoreModule.buildIndexEntries` (index rebuild) so the PK suffix encoding can
 * never drift between the two.
 */
export function resolvePkKeyCollations(
	pkDef: ReadonlyArray<{ index: number }>,
	columns: ReadonlyArray<ColumnSchema>,
	fallback: string,
): (string | undefined)[] {
	return pkDef.map(def => {
		const col = columns[def.index];
		// NOTE: `isTextual`, not {@link columnCanHoldText} — deliberate. A JSON PK column
		// can hold text but cannot declare a collation (`JSON_TYPE.supportedCollations`
		// is empty), so it stays BINARY-keyed *and* BINARY-compared, consistently with
		// `reconcilePkCollations` and the engine's own comparison. If JSON (or another
		// non-`isTextual` type that can hold text) ever gains a non-empty
		// `supportedCollations`, this must switch to `columnCanHoldText` or the key bytes
		// will diverge from the enforced comparison.
		if (!col || !col.logicalType.isTextual) return undefined;
		return (col.collation || fallback).toUpperCase();
	});
}

/**
 * True when `col` can produce a TEXT value at runtime, and so when its physical
 * key bytes are produced by a collation normalizer rather than a type-native
 * encoding. The `ColumnSchema`-shaped wrapper over the engine's
 * {@link logicalTypeCanHoldText}; both collation-safety guards over the store's
 * secondary indexes — the write-side {@link StoreTable.indexSeekHonorsEnforcementCollation}
 * and the read-side `StoreModule.tryIndexAccessPlan` — exempt a never-text column
 * from their K-vs-C comparison, so a false "non-text" answer is a silent
 * wrong-result (a seek under the wrong collation, with the residual dropped).
 */
export function columnCanHoldText(col: ColumnSchema | undefined): boolean {
	return logicalTypeCanHoldText(col?.logicalType);
}

/** A UNIQUE conflict: the offending row and the primary key it lives at. */
type UniqueConflict = { pk: SqlValue[]; row: Row };

/**
 * Returned by {@link StoreTable.findUniqueConflictViaIndex} when the index
 * cannot soundly answer the check and the caller must fall back to the full
 * data-store scan. Distinct from `null`, which means "the index answered: no
 * conflict".
 */
const INDEX_UNUSABLE = Symbol('store.uniqueIndexUnusable');

/**
 * Configuration for a store table.
 */
export interface StoreTableConfig {
	/** Collation for text keys. Default: 'NOCASE'. */
	collation?: 'BINARY' | 'NOCASE';
	/** Additional platform-specific options. */
	[key: string]: unknown;
}

/**
 * Interface for the store module that manages this table.
 * Provides access to stores and coordinators.
 */
export interface StoreTableModule {
	/** Get the data store for a table. */
	getStore(schemaName: string, tableName: string, config: StoreTableConfig): Promise<KVStore>;
	/** Get an index store for a table. */
	getIndexStore(schemaName: string, tableName: string, indexName: string): Promise<KVStore>;
	/** Get the stats store for a table. */
	getStatsStore(schemaName: string, tableName: string): Promise<KVStore>;
	/**
	 * Get the module's single shared transaction coordinator (one per storage
	 * module, shared by every table — the unit of cross-table atomicity).
	 * Synchronous: ops are addressed by explicit store handle, so obtaining a
	 * coordinator never requires opening storage.
	 */
	getCoordinator(): TransactionCoordinator;
	/** Save table DDL to persistent storage. */
	saveTableDDL(tableSchema: TableSchema): Promise<void>;
}

/**
 * One externally-applied row op against a SOURCE table's committed storage,
 * the input vocabulary of {@link StoreTable.applyExternalRowChanges}. An
 * `upsert` carries the full table row in schema column order (its PK — and thus
 * its data key — is derived from the row, so an upsert can never relocate a
 * row); a `delete` carries the PK values in PK-definition order.
 */
export type ExternalRowOp =
	| { op: 'upsert'; row: Row }
	| { op: 'delete'; pk: SqlValue[] };

/**
 * Generic KVStore-backed virtual table.
 *
 * This class provides the core table functionality shared across all
 * storage backends. Platform-specific behavior is delegated to the
 * StoreTableModule.
 */
export class StoreTable extends VirtualTable {
	protected storeModule: StoreTableModule;
	protected config: StoreTableConfig;
	protected store: KVStore | null = null;
	protected storeInitPromise: Promise<KVStore> | null = null;
	protected indexStores: Map<string, KVStore> = new Map();
	protected statsStore: KVStore | null = null;
	protected coordinator: TransactionCoordinator | null = null;
	/**
	 * Disposer returned by the coordinator's `registerCallbacks`, captured on the
	 * first {@link attachCoordinator}. Run by {@link dispose} at hard eviction to
	 * deregister this instance's {stats apply/discard} pair from the module-wide
	 * coordinator; null until attached, and nulled again after dispose.
	 */
	private coordinatorDisposer: (() => void) | null = null;
	protected connection: StoreConnection | null = null;
	protected eventEmitter?: StoreEventEmitter;
	protected encodeOptions: EncodeOptions;
	protected pkDirections: boolean[];
	/**
	 * Per-PK-column KEY collation (see {@link resolvePkKeyCollations}). Drives the
	 * physical encoding of every data key and the PK suffix of every secondary-index
	 * key, so a text PK column declared BINARY/NOCASE/RTRIM is keyed under its own
	 * collation rather than one fixed table-level collation. Recomputed on every
	 * {@link updateSchema} (an ALTER COLUMN SET COLLATE on a PK member changes it).
	 */
	protected pkKeyCollations: (string | undefined)[];
	/**
	 * `db.getCollationResolver()`, bound once at construction. Every collation-aware
	 * VALUE comparison this table makes — pushed-constraint re-check, UNIQUE conflict
	 * detection — resolves names through it, so a collation registered with
	 * `db.registerCollation` on *this* connection is honored rather than silently
	 * degraded to BINARY by the process-global built-in registry.
	 *
	 * Only the resolver closure is cached: it reads the live registry, so a collation
	 * registered after connect is still visible. Resolved *functions* are hoisted no
	 * further than the comparator or constraint check that resolved them.
	 *
	 * Its key-bytes counterpart, `db.getKeyNormalizerResolver()`, is bound into
	 * {@link encodeOptions} so the names in {@link pkKeyCollations} resolve to the same
	 * per-connection registry.
	 */
	protected readonly collationResolver: CollationResolver;
	protected ddlSaved = false;

	// Statistics tracking
	protected cachedStats: TableStats | null = null;
	protected pendingStatsDelta = 0;
	protected mutationCount = 0;
	protected statsFlushPending = false;

	// Lazy cache of compiled partial-UNIQUE predicates. Keyed on the
	// UniqueConstraintSchema object identity — UC schemas are frozen and a
	// new constraint object after CREATE/DROP INDEX produces a fresh compile;
	// the WeakMap lets the GC reclaim entries for retired constraints.
	private readonly predicateCache: WeakMap<UniqueConstraintSchema, CompiledPredicate> = new WeakMap();

	// Lazy cache of compiled partial-index predicates, keyed on the IndexSchema
	// object identity (frozen; a CREATE/DROP INDEX or reopen produces a fresh
	// object, so the WeakMap reclaims retired entries). Mirrors predicateCache but
	// for secondary-index maintenance rather than UNIQUE enforcement.
	private readonly indexPredicateCache: WeakMap<TableIndexSchema, CompiledPredicate> = new WeakMap();

	constructor(
		db: Database,
		storeModule: StoreTableModule,
		tableSchema: TableSchema,
		config: StoreTableConfig,
		eventEmitter?: StoreEventEmitter,
		isConnected = false
	) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		super(db, storeModule as unknown as VirtualTableModule<any, any>, tableSchema.schemaName, tableSchema.name);
		this.storeModule = storeModule;
		this.tableSchema = tableSchema;
		this.config = config;
		this.eventEmitter = eventEmitter;
		this.collationResolver = db.getCollationResolver();
		this.encodeOptions = {
			collation: config.collation || 'NOCASE',
			normalizers: db.getKeyNormalizerResolver(),
		};
		this.pkDirections = tableSchema.primaryKeyDefinition.map(pk => !!pk.desc);
		this.pkKeyCollations = resolvePkKeyCollations(
			tableSchema.primaryKeyDefinition,
			tableSchema.columns,
			this.encodeOptions.collation ?? 'NOCASE',
		);
		this.validateKeyCollations(tableSchema, this.pkKeyCollations);
		this.ddlSaved = isConnected;
	}

	/**
	 * Reject, at DDL time, any collation this table's key encoding would need but cannot
	 * use — before a single row is written under bytes the connection cannot reproduce.
	 *
	 * A collation keys a persisted structure only if it carries a KEY NORMALIZER (the
	 * `(s) => string` whose output equality partitions strings exactly as its comparator
	 * does). `db.registerCollation(name, cmp)` with no `{ normalizer }` gives a collation
	 * that can order rows but not key them; an unregistered name gives nothing at all.
	 * Both raise here rather than at the first insert.
	 *
	 * Checked over exactly the collations the key encoding actually uses:
	 *   - every defined `pkKeyCollations` entry (text-capable PK columns);
	 *   - the table key collation K, but only when it is reachable — a secondary index
	 *     encodes a TEXT-CAPABLE index column's bytes under K (`buildIndexKey`), and a PK
	 *     member that {@link resolvePkKeyCollations} left `undefined` yet whose declared
	 *     type can still hold a string (ANY / JSON) falls back to K inside `encodeValue`.
	 *
	 * So neither a table with an integer PK and no secondary index, nor one whose every
	 * index column is type-natively keyed, is made unopenable by a K it never encodes with.
	 *
	 * Blast radius: this also fires on catalog rehydration. Reopening a persisted database
	 * from a connection that has not re-registered its custom collation now throws at
	 * CREATE-TABLE-from-catalog rather than silently reading rows under a key layout it
	 * cannot reproduce. See `docs/plugins.md`.
	 *
	 * Takes `pkKeyCollations` rather than reading the field so `updateSchema` can validate
	 * the incoming schema BEFORE it overwrites its own state with it.
	 */
	private validateKeyCollations(schema: TableSchema, pkKeyCollations: ReadonlyArray<string | undefined>): void {
		const names = new Set<string>();
		for (const collation of pkKeyCollations) {
			if (collation !== undefined) names.add(collation);
		}
		const indexKeysText = (schema.indexes ?? []).some(index =>
			index.columns.some(col => columnCanHoldText(schema.columns[col.index])));
		const pkFallsBackToTableKeyCollation = schema.primaryKeyDefinition.some((def, i) =>
			pkKeyCollations[i] === undefined && columnCanHoldText(schema.columns[def.index]));
		if (indexKeysText || pkFallsBackToTableKeyCollation) {
			names.add((this.encodeOptions.collation ?? 'NOCASE').toUpperCase());
		}

		const dbInternal = this.db as DatabaseInternal;
		for (const name of names) {
			if (dbInternal._getCollationNormalizer(name)) continue;
			// Unregistered names raise `no such collation sequence: X` from the resolver;
			// reaching past it means the collation exists but is comparator-only.
			this.collationResolver(name);
			throw new QuereusError(
				`collation ${name} cannot key a persisted structure: no key normalizer registered `
					+ `— pass { normalizer } to registerCollation`,
				StatusCode.ERROR,
			);
		}
	}

	/** Get the table configuration. */
	getConfig(): StoreTableConfig {
		return this.config;
	}

	/** Get the table schema. */
	getSchema(): TableSchema {
		return this.tableSchema!;
	}

	/**
	 * Update the table schema after an ALTER TABLE / CREATE INDEX operation.
	 *
	 * Validates the incoming schema's key collations before adopting any of it, so a
	 * rejection leaves this table on its previous, consistent schema.
	 */
	updateSchema(newSchema: TableSchema): void {
		const pkKeyCollations = resolvePkKeyCollations(
			newSchema.primaryKeyDefinition,
			newSchema.columns,
			this.encodeOptions.collation ?? 'NOCASE',
		);
		this.validateKeyCollations(newSchema, pkKeyCollations);
		this.tableSchema = newSchema;
		this.pkDirections = newSchema.primaryKeyDefinition.map(pk => !!pk.desc);
		this.pkKeyCollations = pkKeyCollations;
	}

	/**
	 * Mark the table's DDL as already persisted to the catalog, so the lazy
	 * first-store-access save in {@link initializeStore} is skipped. Called by
	 * `StoreModule.createIndex` / `dropIndex` after they eagerly write the catalog
	 * bundle, so a subsequent INSERT does not redundantly re-persist identical DDL.
	 */
	markDdlSaved(): void {
		this.ddlSaved = true;
	}

	/** Close and forget a cached index-store handle, if any. */
	async releaseIndexStore(indexName: string): Promise<void> {
		const cached = this.indexStores.get(indexName);
		if (!cached) return;
		this.indexStores.delete(indexName);
		try { await cached.close(); } catch { /* close is best-effort */ }
	}

	/**
	 * Returns true if the table has at least one stored row. Stops after the first hit.
	 */
	async hasAnyRows(): Promise<boolean> {
		const store = await this.ensureStore();
		const bounds = buildFullScanBounds();
		for await (const _entry of store.iterate(bounds)) {
			return true;
		}
		return false;
	}

	/**
	 * Scan every row, checking whether the column at `colIndex` ever holds NULL.
	 * Used by ALTER COLUMN SET NOT NULL to decide whether the tightening is safe.
	 */
	async rowsWithNullAtIndex(colIndex: number): Promise<number> {
		const store = await this.ensureStore();
		const bounds = buildFullScanBounds();
		let count = 0;
		for await (const entry of store.iterate(bounds)) {
			const row = deserializeRow(entry.value);
			if (row[colIndex] === null) count++;
		}
		return count;
	}

	/**
	 * Apply a per-row mapping function to every stored row, in place (re-writing
	 * the same key). The mapper may throw QuereusError — propagated to the caller.
	 */
	async mapRowsAtIndex(
		colIndex: number,
		mapper: (value: SqlValue) => SqlValue,
	): Promise<void> {
		const store = await this.ensureStore();
		const bounds = buildFullScanBounds();
		const batch = store.batch();
		for await (const entry of store.iterate(bounds)) {
			const row = deserializeRow(entry.value);
			const oldVal = row[colIndex];
			const newVal = mapper(oldVal);
			if (newVal === oldVal) continue;
			const newRow = row.slice();
			newRow[colIndex] = newVal;
			batch.put(entry.key, serializeRow(newRow as Row));
		}
		await batch.write();
	}

	/**
	 * Re-key every stored row under a new primary-key definition.
	 *
	 * Two-pass: the first pass reads every row and computes the new data keys,
	 * tracking duplicates. On collision we throw `CONSTRAINT` without touching
	 * the store. The second pass batches deletes of displaced old keys and puts
	 * of new (key, row) pairs. Rows whose new key matches the old key are no-ops.
	 *
	 * Only the data store is rewritten — secondary indexes are rebuilt by the
	 * caller (the keys embed the PK suffix, so they must be rebuilt whenever
	 * the PK changes).
	 *
	 * The new key for each row is encoded under `newColumns`'s per-column PK
	 * collations, so this drives BOTH:
	 *   - `ALTER PRIMARY KEY` — the PK *columns* change; `newColumns` defaults to the
	 *     current column set (their collations are unchanged), and
	 *   - `ALTER COLUMN … SET COLLATE` on a PK member — the PK columns stay the same
	 *     but one column's collation changes; the caller passes the post-ALTER
	 *     `updatedSchema.columns` so the new key bytes follow the new collation.
	 * The OLD key is taken verbatim from the stored entry (never re-encoded), so the
	 * old collation is implicit in the existing bytes and need not be supplied.
	 */
	async rekeyRows(
		newPkDef: ReadonlyArray<{ index: number; desc?: boolean }>,
		newColumns: ReadonlyArray<ColumnSchema> = this.tableSchema!.columns,
	): Promise<void> {
		const store = await this.ensureStore();
		const bounds = buildFullScanBounds();

		interface Pending { newKey: Uint8Array; oldKey: Uint8Array; row: Row; }
		const pending = new Map<string, Pending>();

		const newPkDirections = newPkDef.map(pk => !!pk.desc);
		const newPkCollations = resolvePkKeyCollations(
			newPkDef,
			newColumns,
			this.encodeOptions.collation ?? 'NOCASE',
		);
		for await (const entry of store.iterate(bounds)) {
			const row = deserializeRow(entry.value);
			const newPkValues = newPkDef.map(pk => row[pk.index]);
			const newKey = buildDataKey(newPkValues, this.encodeOptions, newPkDirections, newPkCollations);
			const hex = bytesToHex(newKey);
			if (pending.has(hex)) {
				throw new QuereusError(
					`UNIQUE constraint failed: duplicate primary key on rekey of '${this.schemaName}.${this.tableName}'`,
					StatusCode.CONSTRAINT,
				);
			}
			pending.set(hex, { newKey, oldKey: entry.key, row });
		}

		const batch = store.batch();
		for (const { newKey, oldKey, row } of pending.values()) {
			if (!bytesEqual(oldKey, newKey)) {
				batch.delete(oldKey);
				batch.put(newKey, serializeRow(row));
			}
		}
		await batch.write();
	}

	/**
	 * Migrate all stored rows from the old column layout to a new one.
	 * The remap array maps newColumnIndex -> oldColumnIndex | -1.
	 * -1 means the column is new (fill with defaultValue).
	 *
	 * `backfill`, when supplied (ADD COLUMN with a non-foldable DEFAULT such as
	 * `new.<col>`), derives the new column's value from each existing row instead of the
	 * single `defaultValue`, and rejects a NULL it produces for a NOT NULL column. The
	 * batch is only written once every row migrates, so a throwing evaluator / NOT NULL
	 * violation leaves the store untouched for the caller's rollback.
	 */
	async migrateRows(
		remap: number[],
		defaultValue: SqlValue,
		backfill?: { evaluator: (row: Row) => SqlValue | Promise<SqlValue>; notNull: boolean; columnName: string },
	): Promise<void> {
		const store = await this.ensureStore();
		const bounds = buildFullScanBounds();
		const batch = store.batch();

		for await (const entry of store.iterate(bounds)) {
			const oldRow = deserializeRow(entry.value);
			let newColumnValue = defaultValue;
			if (backfill) {
				newColumnValue = await backfill.evaluator(oldRow);
				if (backfill.notNull && newColumnValue === null) {
					throw new QuereusError(
						`NOT NULL constraint failed: backfilling column '${this.schemaName}.${this.tableName}.${backfill.columnName}' produced NULL for an existing row`,
						StatusCode.CONSTRAINT,
					);
				}
			}
			const newRow: Row = new Array(remap.length);
			for (let i = 0; i < remap.length; i++) {
				newRow[i] = remap[i] === -1 ? newColumnValue : oldRow[remap[i]];
			}
			batch.put(entry.key, serializeRow(newRow));
		}

		await batch.write();
	}

	/**
	 * Ensure the data store is open and DDL is persisted.
	 * Uses a promise-based singleton pattern to prevent race conditions
	 * when multiple concurrent queries access the same table.
	 */
	protected ensureStore(): Promise<KVStore> {
		if (this.store) {
			return Promise.resolve(this.store);
		}

		if (this.storeInitPromise) {
			return this.storeInitPromise;
		}

		this.storeInitPromise = this.initializeStore();
		return this.storeInitPromise;
	}

	/**
	 * Internal method to actually initialize the store.
	 * Only called once per table instance.
	 */
	private async initializeStore(): Promise<KVStore> {
		const tableKey = `${this.schemaName}.${this.tableName}`.toLowerCase();

		try {
			this.store = await this.storeModule.getStore(this.schemaName, this.tableName, this.config);

			if (!this.store) {
				throw new Error(`getStore returned null/undefined for ${tableKey}`);
			}

			// Save DDL on first access (only for newly created tables)
			if (!this.ddlSaved && this.tableSchema) {
				await this.storeModule.saveTableDDL(this.tableSchema);
				this.ddlSaved = true;
			}

			return this.store;
		} catch (error) {
			this.storeInitPromise = null;
			throw error;
		}
	}

	/**
	 * Get or create an index store for the given index name.
	 */
	protected async ensureIndexStore(indexName: string): Promise<KVStore> {
		let indexStore = this.indexStores.get(indexName);
		if (!indexStore) {
			indexStore = await this.storeModule.getIndexStore(this.schemaName, this.tableName, indexName);
			this.indexStores.set(indexName, indexStore);
		}
		return indexStore;
	}

	/**
	 * Get or create the stats store.
	 */
	protected async ensureStatsStore(): Promise<KVStore> {
		if (!this.statsStore) {
			this.statsStore = await this.storeModule.getStatsStore(this.schemaName, this.tableName);
		}
		return this.statsStore;
	}

	/**
	 * Resolve + cache the module's shared TransactionCoordinator and hook the
	 * stats lifecycle callbacks, WITHOUT creating or registering a connection.
	 * Synchronous (the coordinator is handle-addressed, never store-opening — see
	 * `StoreTableModule.getCoordinator`), so the backing host's resolution path can
	 * call it eagerly. Attaching matters for reads: `iterateEffective` /
	 * `readEffectiveRowByKey` consult `this.coordinator` for the pending merge, so a
	 * table whose only writer is the privileged backing host (which queues ops on the
	 * module coordinator, never through `update()`) must still hold the
	 * reference for its read paths to be reads-own-writes.
	 *
	 * The coordinator is module-wide, so its commit/rollback callback array holds
	 * one {stats apply/discard} pair per PARTICIPATING table; each table's
	 * `applyPendingStats` early-returns when its own `pendingStatsDelta` is 0, so a
	 * table that did no work contributes nothing. Registers only on first call per
	 * StoreTable instance (the `if (!this.coordinator)` guard); a fresh instance
	 * after drop+recreate re-registers against the shared coordinator. The OLD
	 * instance is not GC'd on its own — its callback closures capture `this` and
	 * stay pinned on the module-wide coordinator until {@link dispose} runs the
	 * captured disposer (called at the genuine eviction sites, see
	 * `StoreModule.tearDownTableStorage` / `renameTable`).
	 */
	attachCoordinator(): TransactionCoordinator {
		if (!this.coordinator) {
			this.coordinator = this.storeModule.getCoordinator();

			this.coordinatorDisposer = this.coordinator.registerCallbacks({
				onCommit: () => this.applyPendingStats(),
				onRollback: () => this.discardPendingStats(),
			});
		}
		return this.coordinator;
	}

	/**
	 * Ensure the coordinator is available and connection is registered.
	 */
	protected async ensureCoordinator(): Promise<TransactionCoordinator> {
		const coordinator = this.attachCoordinator();

		if (!this.connection) {
			this.connection = new StoreConnection(`${this.schemaName}.${this.tableName}`, coordinator);
			await (this.db as DatabaseInternal).registerConnection(this.connection);
		}

		return coordinator;
	}

	/** Apply pending stats on commit. */
	protected applyPendingStats(): void {
		if (this.pendingStatsDelta === 0) return;

		if (!this.cachedStats) {
			this.cachedStats = { rowCount: 0, updatedAt: Date.now() };
		}
		this.cachedStats.rowCount = Math.max(0, this.cachedStats.rowCount + this.pendingStatsDelta);
		this.cachedStats.updatedAt = Date.now();
		this.mutationCount += Math.abs(this.pendingStatsDelta);
		this.pendingStatsDelta = 0;

		if (this.mutationCount >= STATS_FLUSH_INTERVAL && !this.statsFlushPending) {
			this.statsFlushPending = true;
			queueMicrotask(() => this.flushStats());
		}
	}

	/** Discard pending stats on rollback. */
	protected discardPendingStats(): void {
		this.pendingStatsDelta = 0;
	}

	/** Flush statistics to the stats store. */
	protected async flushStats(): Promise<void> {
		this.statsFlushPending = false;
		this.mutationCount = 0;

		if (!this.cachedStats) {
			return;
		}

		const statsStore = await this.ensureStatsStore();
		const statsKey = buildStatsKey(this.schemaName, this.tableName);
		await statsStore.put(statsKey, serializeStats(this.cachedStats));
	}

	/** Create a new connection for transaction support. */
	async createConnection(): Promise<VirtualTableConnection> {
		await this.ensureCoordinator();
		return this.connection!;
	}

	/** Get the current connection. */
	getConnection(): VirtualTableConnection | undefined {
		return this.connection ?? undefined;
	}

	/** Extract primary key values from a row. */
	protected extractPK(row: Row): SqlValue[] {
		const schema = this.tableSchema!;
		return schema.primaryKeyDefinition.map(pk => row[pk.index]);
	}

	/**
	 * Coerce each cell in `row` to its declared column logical type.
	 * Mirrors the memory-table path (MemoryTableManager.performInsert/performUpdate)
	 * so INTEGER/REAL affinity is applied and JSON columns are parsed into native
	 * objects before PK extraction, serialization, and index-key construction.
	 */
	protected coerceRow(row: Row): Row {
		const cols = this.tableSchema!.columns;
		if (row.length > cols.length) {
			throw new QuereusError(
				`Too many values for ${this.schemaName}.${this.tableName}: expected ${cols.length}, got ${row.length}`,
				StatusCode.ERROR,
			);
		}
		return row.map((v, i) => validateAndParse(v, cols[i].logicalType, cols[i].name)) as Row;
	}

	/**
	 * Query the table with optional filters.
	 *
	 * All three access arms read the EFFECTIVE row state: the committed store
	 * merged with this table's coordinator's pending ops when a transaction is
	 * active (read-your-own-writes — see {@link iterateEffective} /
	 * {@link readLiveRowByPk}). Merged emission stays in encoded-PK-key order,
	 * preserving the module's `providesOrdering` / `monotonicOn` advertisements.
	 */
	async *query(filterInfo: FilterInfo): AsyncIterable<Row> {
		const store = await this.ensureStore();

		const pkAccess = this.analyzePKAccess(filterInfo);

		if (pkAccess.type === 'point') {
			const row = await this.readLiveRowByPk(pkAccess.values!);
			if (row && this.matchesFilters(row, filterInfo, this.resolveFilterCollations(filterInfo))) {
				yield row;
			}
			return;
		}

		if (pkAccess.type === 'range') {
			yield* this.scanPKRange(store, pkAccess, filterInfo);
			return;
		}

		// Secondary-index scan arm — reached only when the predicate did NOT resolve
		// to a PK point/range (PK access is cheaper and already handled above). When
		// the planner chose a secondary index (idxStr carries `idx=<name>(…)`), derive
		// its byte window and iterate it instead of full-scanning.
		const indexAccess = this.analyzeIndexAccess(filterInfo);
		if (indexAccess) {
			const indexStore = await this.ensureIndexStore(indexAccess.index.name);
			yield* this.scanIndex(indexStore, indexAccess, filterInfo);
			return;
		}

		// Full table scan
		const collations = this.resolveFilterCollations(filterInfo);
		const bounds = buildFullScanBounds();
		for await (const entry of this.iterateEffective(store, bounds)) {
			const row = deserializeRow(entry.value);
			if (this.matchesFilters(row, filterInfo, collations)) {
				yield row;
			}
		}
	}

	/**
	 * Iterate the effective entry state of this table's data store within
	 * `bounds`: the committed `store.iterate` stream merged with the
	 * coordinator's pending ops for the data store (read-your-own-writes).
	 *
	 * Both inputs are sorted by encoded key bytes, so this is an
	 * order-preserving two-way merge: a pending put wins over a committed entry
	 * at the same key, a pending delete suppresses its committed entry, and
	 * pending puts outside `bounds` are excluded. With no active transaction
	 * (or an empty pending bucket) it degrades to the bare committed iterate.
	 *
	 * The pending side is the module coordinator's bucket for THIS table's data
	 * store handle (`store`) — every data op is queued under that exact handle, so
	 * a sibling table's pending ops (a different data-store handle) never bleed in.
	 */
	protected async *iterateEffective(
		store: KVStore,
		bounds: IterateOptions,
		reverse = false,
	): AsyncIterable<KVEntry> {
		const pending = this.coordinator?.isInTransaction()
			? this.coordinator.getOrderedPendingOps(store)
			: null;
		const iterOptions: IterateOptions = reverse ? { ...bounds, reverse } : bounds;

		if (!pending || (pending.puts.length === 0 && pending.deletes.size === 0)) {
			yield* store.iterate(iterOptions);
			return;
		}

		const puts = pending.puts.filter(p => keyWithinBounds(p.key, bounds));
		if (reverse) puts.reverse();
		// In iteration order, "before" means byte-less for forward and byte-greater
		// for reverse; sign folds the direction into one comparison.
		const sign = reverse ? -1 : 1;
		let putIdx = 0;

		for await (const entry of store.iterate(iterOptions)) {
			// Emit pending puts that precede this committed entry in iteration order.
			while (putIdx < puts.length && sign * compareBytes(puts[putIdx].key, entry.key) < 0) {
				yield puts[putIdx++];
			}
			// Equal keys: the pending put shadows the committed entry.
			if (putIdx < puts.length && compareBytes(puts[putIdx].key, entry.key) === 0) {
				yield puts[putIdx++];
				continue;
			}
			if (pending.deletes.has(bytesToHex(entry.key))) continue;
			yield entry;
		}

		// Pending puts beyond the last committed entry.
		while (putIdx < puts.length) {
			yield puts[putIdx++];
		}
	}

	/** Analyze filter info to determine PK access pattern. */
	protected analyzePKAccess(filterInfo: FilterInfo): PKAccessPattern {
		const schema = this.tableSchema!;
		const pkColumns = schema.primaryKeyDefinition.map(pk => pk.index);

		if (pkColumns.length === 0) {
			return { type: 'scan' };
		}

		// Check for equality on all PK columns
		const eqValues: SqlValue[] = new Array(pkColumns.length);
		let allEq = true;

		for (let i = 0; i < pkColumns.length; i++) {
			const pkColIdx = pkColumns[i];
			const eqConstraintEntry = filterInfo.constraints?.find(
				c => c.constraint.iColumn === pkColIdx && c.constraint.op === IndexConstraintOp.EQ
			);
			if (eqConstraintEntry && eqConstraintEntry.argvIndex > 0) {
				eqValues[i] = filterInfo.args[eqConstraintEntry.argvIndex - 1];
			} else {
				allEq = false;
				break;
			}
		}

		if (allEq) {
			return { type: 'point', values: eqValues };
		}

		// Check for range constraints on first PK column
		const firstPkCol = pkColumns[0];
		const rangeOps = [IndexConstraintOp.LT, IndexConstraintOp.LE, IndexConstraintOp.GT, IndexConstraintOp.GE];
		const rangeConstraints = filterInfo.constraints?.filter(
			c => c.constraint.iColumn === firstPkCol && rangeOps.includes(c.constraint.op)
		) || [];

		if (rangeConstraints.length > 0) {
			return {
				type: 'range',
				columnIndex: firstPkCol,
				constraints: rangeConstraints.map(c => ({
					columnIndex: c.constraint.iColumn,
					op: c.constraint.op,
					value: c.argvIndex > 0 ? filterInfo.args[c.argvIndex - 1] : undefined,
				})),
			};
		}

		return { type: 'scan' };
	}

	/**
	 * Convert a leading-PK-column range access into one seek + early-terminate
	 * iterate window.
	 *
	 * Each LT/LE/GT/GE constraint's bound value is encoded under the SAME
	 * per-column DESC direction and key collation as the data keys (via
	 * {@link encodePkPrefixBounds}), giving the byte region `[lo, hi)` whose
	 * leading column equals that value (`lo = encode([x])`,
	 * `hi = incrementLastByte(lo)`). The op maps that region's endpoints onto a
	 * `gte`/`lt` window; because a DESC column bit-inverts its bytes (larger value
	 * ⇒ smaller bytes), the lower/upper assignment swaps with direction:
	 *
	 *   | op | ASC      | DESC     |
	 *   |----|----------|----------|
	 *   | GE | gte = lo | lt  = hi |
	 *   | GT | gte = hi | lt  = lo |
	 *   | LE | lt  = hi | gte = lo |
	 *   | LT | lt  = lo | gte = hi |
	 *
	 * Across constraints (BETWEEN ⇒ one lower + one upper; a redundant same-side
	 * pair ⇒ the tighter wins) we keep the MAX lower candidate for `gte` and the
	 * MIN upper candidate for `lt`. A candidate that resolves to `undefined` (an
	 * `hi` whose increment overflowed all-0xff) leaves that side unbounded — a safe
	 * SUPERSET, since {@link matchesFilters} stays the authoritative collation-aware
	 * row filter. A NULL/missing bound value is likewise skipped (the planner never
	 * pushes `= NULL`, and a range op against NULL rejects every row in matchesFilters).
	 *
	 * NOTE: a range window over a text PK column is sound only when the column's key
	 * normalizer is ORDER-preserving with respect to its comparator — i.e. the comparator
	 * orders two strings the way memcmp orders their normalized bytes. All three built-ins
	 * satisfy this, but `db.registerCollation` guarantees only that a normalizer PARTITIONS
	 * strings the way the comparator calls them equal, not that it preserves order — and a
	 * built-in NAME may be re-registered with a custom comparator + normalizer pair that
	 * does not. Such a pair makes this window (and `analyzeIndexAccess`') UNDER-fetch and
	 * silently drop rows. Tracked by `backlog/bug-store-range-seek-assumes-order-preserving-
	 * key-normalizer`; the fix is an order-preservation assertion at registration, or
	 * restricting range seeks to collations the engine knows are order-preserving.
	 */
	protected buildPKRangeBounds(access: PKAccessPattern): IterateOptions {
		const full = buildFullScanBounds();
		const constraints = access.constraints;
		if (!constraints || constraints.length === 0) return full;

		const dir = this.pkDirections[0];

		let gte: Uint8Array = full.gte;
		let lt: Uint8Array | undefined;

		for (const c of constraints) {
			if (c.value === undefined || c.value === null) continue;
			const { gte: lo, lt: hi } = this.encodePkPrefixBounds([c.value]);
			const lower = !dir
				? (c.op === IndexConstraintOp.GE ? lo : c.op === IndexConstraintOp.GT ? hi : undefined)
				: (c.op === IndexConstraintOp.LE ? lo : c.op === IndexConstraintOp.LT ? hi : undefined);
			const upper = !dir
				? (c.op === IndexConstraintOp.LE ? hi : c.op === IndexConstraintOp.LT ? lo : undefined)
				: (c.op === IndexConstraintOp.GE ? hi : c.op === IndexConstraintOp.GT ? lo : undefined);
			if (lower && compareBytes(lower, gte) > 0) gte = lower;
			if (upper && (lt === undefined || compareBytes(upper, lt) < 0)) lt = upper;
		}

		return lt === undefined ? { gte } : { gte, lt };
	}

	/**
	 * Scan a leading-PK-column range, seeking to the window start and
	 * early-terminating at its end.
	 *
	 * {@link buildPKRangeBounds} converts the LT/LE/GT/GE constraints into one
	 * encoded-byte `gte`/`lt` window under the same per-column DESC directions and
	 * key collations the data keys use, so the iterate visits a SUPERSET of the
	 * qualifying rows (a collation widening or the bound-byte increment can
	 * over-fetch, never under-fetch). {@link matchesFilters} stays the authoritative
	 * collation-aware row filter. {@link iterateEffective} restricts the pending
	 * merge to the same `bounds`, so read-your-own-writes holds on the narrowed window.
	 */
	protected async *scanPKRange(
		store: KVStore,
		access: PKAccessPattern,
		filterInfo: FilterInfo
	): AsyncIterable<Row> {
		const collations = this.resolveFilterCollations(filterInfo);
		const bounds = this.buildPKRangeBounds(access);
		for await (const entry of this.iterateEffective(store, bounds)) {
			const row = deserializeRow(entry.value);
			if (this.matchesFilters(row, filterInfo, collations)) {
				yield row;
			}
		}
	}

	/**
	 * Resolve the secondary index chosen by the planner from `filterInfo.idxStr`.
	 *
	 * The planner emits `idx=<name>(<n>);plan=…` when its access plan set both an
	 * `indexName` and `seekColumnIndexes` (see `getBestAccessPlan` and
	 * rule-select-access-path.ts). Mirrors `isolated-table.ts`'
	 * `parseIndexFromFilterInfo` so the store and the isolation overlay resolve the
	 * SAME index for one idxStr. Returns null for the PK/scan sentinels
	 * (`_primary_`, `fullscan`), a missing `idx=` param, or a name absent from
	 * `schema.indexes` — every one of which routes back to a PK/full-scan arm.
	 */
	protected resolveIndexFromIdxStr(idxStr: string | null): TableIndexSchema | null {
		if (!idxStr) return null;
		const params = new Map<string, string>();
		idxStr.split(';').forEach(part => {
			const [key, value] = part.split('=', 2);
			if (key && value !== undefined) params.set(key, value);
		});
		const idx = params.get('idx');
		if (!idx) return null;
		const match = idx.match(/^(.*?)\((\d+)\)$/);
		const name = match ? match[1] : idx;
		if (!name || name === '_primary_' || name === 'fullscan') return null;
		const indexes = this.tableSchema?.indexes ?? [];
		return indexes.find(i => i.name.toLowerCase() === name.toLowerCase()) ?? null;
	}

	/**
	 * Analyze filter info to determine a secondary-index access pattern, mirroring
	 * {@link analyzePKAccess} but over the index chosen in `idxStr`.
	 *
	 * A contiguous leading-prefix EQ on the index columns yields a `point` window
	 * (the prefix covers every entry sharing those leading values — an index seek
	 * is a PREFIX scan, not a single row, since the index need not be unique and
	 * the PK suffix varies); otherwise a range (LT/LE/GT/GE) on the LEADING index
	 * column yields a `range` window. Returns null when neither applies or when the
	 * index is unresolved. {@link matchesFilters} stays the authoritative row filter,
	 * so the window need only be a SUPERSET. Index-column bytes are encoded under the
	 * table key collation K (NOT the index's per-column declared collation — see
	 * `buildIndexKey`); the same order-preservation caveat {@link buildPKRangeBounds}
	 * records applies to K here.
	 */
	protected analyzeIndexAccess(filterInfo: FilterInfo): IndexAccessPattern | null {
		const index = this.resolveIndexFromIdxStr(filterInfo.idxStr);
		if (!index) return null;

		const indexCols = index.columns.map(c => c.index);
		const indexDirections = index.columns.map(c => !!c.desc);

		// Contiguous leading-prefix EQ → point/prefix window.
		const eqValues: SqlValue[] = [];
		for (let i = 0; i < indexCols.length; i++) {
			const eq = filterInfo.constraints?.find(
				c => c.constraint.iColumn === indexCols[i]
					&& c.constraint.op === IndexConstraintOp.EQ
					&& c.argvIndex > 0,
			);
			if (!eq) break;
			eqValues.push(filterInfo.args[eq.argvIndex - 1]);
		}
		if (eqValues.length > 0) {
			const bounds = buildIndexPrefixBounds(
				eqValues,
				this.encodeOptions,
				indexDirections.slice(0, eqValues.length),
			);
			return { index, type: 'point', bounds };
		}

		// Else a range on the LEADING index column.
		const leadingCol = indexCols[0];
		const rangeOps = [IndexConstraintOp.LT, IndexConstraintOp.LE, IndexConstraintOp.GT, IndexConstraintOp.GE];
		const rangeConstraints = (filterInfo.constraints ?? []).filter(
			c => c.constraint.iColumn === leadingCol && rangeOps.includes(c.constraint.op),
		);
		if (rangeConstraints.length > 0) {
			const bounds = this.buildIndexRangeBounds(
				rangeConstraints.map(c => ({
					op: c.constraint.op,
					value: c.argvIndex > 0 ? filterInfo.args[c.argvIndex - 1] : undefined,
				})),
				indexDirections[0],
			);
			return { index, type: 'range', bounds };
		}

		return null;
	}

	/**
	 * Convert leading-index-column LT/LE/GT/GE constraints into one encoded-byte
	 * `gte`/`lt` window — the secondary-index analogue of {@link buildPKRangeBounds}.
	 *
	 * Each bound value is encoded under {@link encodeOptions} (the table key collation K
	 * and its normalizer resolver) and the leading index column's DESC `dir` — exactly as
	 * {@link buildIndexKey} encodes
	 * that column — via {@link buildIndexPrefixBounds}, giving the byte region
	 * `[lo, hi)` whose leading column equals that value. The op maps that region's
	 * endpoints onto `gte`/`lt`, with the same DESC lower/upper SWAP as the PK path:
	 *
	 *   | op | ASC      | DESC     |
	 *   |----|----------|----------|
	 *   | GE | gte = lo | lt  = hi |
	 *   | GT | gte = hi | lt  = lo |
	 *   | LE | lt  = hi | gte = lo |
	 *   | LT | lt  = lo | gte = hi |
	 *
	 * Across constraints keep the MAX lower and MIN upper. An `undefined` upper (an
	 * `hi` whose increment overflowed all-0xff) leaves that side unbounded — a safe
	 * SUPERSET. A NULL/missing bound value is skipped (the planner never pushes
	 * `= NULL`, and a range op against NULL rejects every row in matchesFilters).
	 */
	protected buildIndexRangeBounds(
		constraints: Array<{ op: IndexConstraintOp; value?: SqlValue }>,
		dir: boolean,
	): IterateOptions {
		const full = buildFullScanBounds();
		let gte: Uint8Array = full.gte;
		let lt: Uint8Array | undefined;

		for (const c of constraints) {
			if (c.value === undefined || c.value === null) continue;
			const { gte: lo, lt: hi } = buildIndexPrefixBounds([c.value], this.encodeOptions, [dir]);
			const lower = !dir
				? (c.op === IndexConstraintOp.GE ? lo : c.op === IndexConstraintOp.GT ? hi : undefined)
				: (c.op === IndexConstraintOp.LE ? lo : c.op === IndexConstraintOp.LT ? hi : undefined);
			const upper = !dir
				? (c.op === IndexConstraintOp.LE ? hi : c.op === IndexConstraintOp.LT ? lo : undefined)
				: (c.op === IndexConstraintOp.GE ? hi : c.op === IndexConstraintOp.GT ? lo : undefined);
			if (lower && compareBytes(lower, gte) > 0) gte = lower;
			if (upper && (lt === undefined || compareBytes(upper, lt) < 0)) lt = upper;
		}

		return lt === undefined ? { gte } : { gte, lt };
	}

	/**
	 * Scan a secondary index over `access.bounds`, resolving each index entry to its
	 * base row and re-filtering.
	 *
	 * {@link iterateEffective} yields the committed index entries merged with this
	 * transaction's pending index puts/deletes (read-your-own-writes over the
	 * index), in index-key byte order — the order the isolation overlay merge relies
	 * on (`isolated-table.ts` § buildSortKey). We resolve each entry to its row via
	 * its stored data-key value WITHOUT reordering, so index-key order is preserved.
	 *
	 * Defense in depth mirroring the memory layer's live-recheck: a resolved-null
	 * row (the entry's row was deleted — a pending index delete would normally
	 * suppress the entry, but a committed entry can lag) is skipped, and every
	 * resolved row is re-checked by {@link matchesFilters} (the byte window is only
	 * a superset, and a stale entry whose indexed column no longer matches is
	 * dropped).
	 */
	protected async *scanIndex(
		indexStore: KVStore,
		access: IndexAccessPattern,
		filterInfo: FilterInfo,
	): AsyncIterable<Row> {
		// Re-check each resolved row under the INDEX's per-column collation (see
		// matchesFilters): the planner dropped the residual based on the index
		// column's collation, which an explicit index `COLLATE` can make differ from
		// the table column's declared collation.
		const indexCollations = this.resolveFilterCollations(filterInfo, this.indexColumnCollations(access.index));
		for await (const entry of this.iterateEffective(indexStore, access.bounds)) {
			// NOTE: a legacy index store (written before index values carried the data
			// key) holds EMPTY values; a zero-length data key is not a row key, so skip
			// it rather than resolve it to the wrong row. Because the access plan marked
			// the filter handled and dropped the residual, an indexed query over such a
			// store returns NOTHING rather than the matching rows — a silent wrong
			// result, not an error. Backwards compatibility is waived project-wide
			// (AGENTS.md) and no test provider carries on-disk data, so nothing exercises
			// this today. If real persisted stores predating this format come into play,
			// their indexes must be dropped + recreated (or the table rebuilt); the
			// durable fix is to version-stamp the index store and rebuild on open, or to
			// fall back to a full scan the first time an empty value is seen.
			if (entry.value.length === 0) continue;
			// NOTE: one extra data-store `get` per matched index entry — the row lives
			// in the data store, not the index (the index value carries only the data
			// key, no covering payload). Fine now; if index-covered scans ever dominate
			// a profile, consider storing the serialized row as a covering index value,
			// at the cost of an index rewrite on EVERY column change (not just indexed
			// columns) — deliberately not done here.
			const row = await this.readEffectiveRowByKey(entry.value);
			if (row && this.matchesFilters(row, filterInfo, indexCollations)) {
				yield row;
			}
		}
	}

	/**
	 * Check if a row matches the filter constraints.
	 *
	 * `collations` maps a constrained column index to the comparison function that
	 * column must be re-checked under; every caller builds it once per scan with
	 * {@link resolveFilterCollations}, whose doc comment explains how the name is
	 * chosen. A column absent from the map compares BINARY — the same result
	 * {@link resolveFilterCollations} produces for an undeclared collation, and the
	 * only reachable absence, since both walk the constraint list under identical
	 * skip conditions.
	 */
	protected matchesFilters(
		row: Row,
		filterInfo: FilterInfo,
		collations: ReadonlyMap<number, CollationFunction>,
	): boolean {
		if (!filterInfo.constraints || filterInfo.constraints.length === 0) {
			return true;
		}

		for (const constraintEntry of filterInfo.constraints) {
			const { constraint, argvIndex } = constraintEntry;
			if (constraint.iColumn < 0 || argvIndex <= 0) {
				continue;
			}

			const rowValue = row[constraint.iColumn];
			const filterValue = filterInfo.args[argvIndex - 1];
			const collation = collations.get(constraint.iColumn) ?? BINARY_COLLATION;

			if (!this.compareValues(rowValue, constraint.op, filterValue, collation)) {
				return false;
			}
		}

		return true;
	}

	/**
	 * Resolve, ONCE per scan, the comparison collation function for every pushed
	 * constraint column, keyed by column index.
	 *
	 * The name for a column is its DECLARED collation (absent ⇒ BINARY) — the same
	 * resolution the access path's collation-cover analysis uses
	 * (indexColumnCollationLookup / primaryKeyCollationLookup) when it decides a
	 * pushed constraint is fully covered, and the same source this file's UNIQUE
	 * checks compare under. On a collation MATCH the planner drops the residual
	 * Filter, so {@link matchesFilters} alone must reproduce the predicate.
	 *
	 * `indexCollationNames` (from {@link indexColumnCollations}) overrides the
	 * declared name for the secondary-index scan arm: the planner's MATCH there is
	 * against the INDEX column's collation, which an explicit `COLLATE` on the index
	 * can make differ from the table column's.
	 *
	 * Names resolve against {@link collationResolver}, so an unregistered collation
	 * raises `no such collation sequence` at scan setup rather than byte-ordering
	 * every row.
	 *
	 * NOTE: rebuilt on every `query()` / `scanPKRange()` / `scanIndex()` call — one
	 * registry lookup per distinct constrained column, dwarfed by the scan's I/O. If a
	 * point-lookup-heavy profile ever shows it, memoize on the `FilterInfo`.
	 */
	protected resolveFilterCollations(
		filterInfo: FilterInfo,
		indexCollationNames?: ReadonlyMap<number, string | undefined>,
	): ReadonlyMap<number, CollationFunction> {
		const resolved = new Map<number, CollationFunction>();
		if (!filterInfo.constraints) return resolved;

		for (const { constraint, argvIndex } of filterInfo.constraints) {
			if (constraint.iColumn < 0 || argvIndex <= 0) continue;
			if (resolved.has(constraint.iColumn)) continue;

			const name = indexCollationNames?.has(constraint.iColumn)
				? indexCollationNames.get(constraint.iColumn)
				: this.tableSchema!.columns[constraint.iColumn]?.collation;
			resolved.set(constraint.iColumn, name ? this.collationResolver(name) : BINARY_COLLATION);
		}

		return resolved;
	}

	/**
	 * Effective per-column comparison collation for a secondary index's columns:
	 * the index column's own `COLLATE` when present, else the underlying table
	 * column's declared collation. Mirrors the resolution `StoreModule`'s
	 * index-maintenance UNIQUE dedup uses (`indexCol.collation ?? tableColumn`), so
	 * a re-checked index-scan row compares under the same collation the planner used
	 * to justify dropping (or keeping) the residual Filter.
	 */
	protected indexColumnCollations(index: TableIndexSchema): Map<number, string | undefined> {
		const cols = this.tableSchema!.columns;
		const map = new Map<number, string | undefined>();
		for (const c of index.columns) {
			map.set(c.index, c.collation ?? cols[c.index]?.collation);
		}
		return map;
	}

	/**
	 * Compare two values according to an operator, under `collationFunc` (already
	 * resolved by {@link resolveFilterCollations} against this database's collation
	 * registry). So the LT/LE/GT/GE range bounds honour a NOCASE/RTRIM/custom column
	 * collation rather than a raw BINARY JS comparison — the capability
	 * `StoreModule.getBestAccessPlan` advertises via `honorsCollatedRangeBounds`.
	 * NULL on either side fails every operator except EQ-with-both-NULL (the
	 * internal point-lookup convention; the planner never pushes `= NULL`).
	 */
	protected compareValues(a: SqlValue, op: IndexConstraintOp, b: SqlValue, collationFunc: CollationFunction): boolean {
		if (a === null || b === null) {
			return op === IndexConstraintOp.EQ ? a === b : false;
		}

		const cmp = compareSqlValuesFast(a, b, collationFunc);
		switch (op) {
			case IndexConstraintOp.EQ: return cmp === 0;
			case IndexConstraintOp.NE: return cmp !== 0;
			case IndexConstraintOp.LT: return cmp < 0;
			case IndexConstraintOp.LE: return cmp <= 0;
			case IndexConstraintOp.GT: return cmp > 0;
			case IndexConstraintOp.GE: return cmp >= 0;
			default: return true;
		}
	}

	/** Perform an update operation (INSERT, UPDATE, DELETE). */
	async update(args: UpdateArgs): Promise<UpdateResult> {
		const store = await this.ensureStore();
		const coordinator = await this.ensureCoordinator();
		const inTransaction = coordinator.isInTransaction();
		const schema = this.tableSchema!;
		const { operation, values, oldKeyValues } = args;

		switch (operation) {
			case 'insert': {
				if (!values) throw new QuereusError('INSERT requires values', StatusCode.MISUSE);
				const coerced = args.preCoerced ? values : this.coerceRow(values);
				const pk = this.extractPK(coerced);
				const key = buildDataKey(pk, this.encodeOptions, this.pkDirections, this.pkKeyCollations);

				// Check for existing row (for conflict handling).
				// Resolve PK-conflict action: statement OR > per-constraint default > ABORT.
				const pkEffective = args.onConflict ?? resolvePkDefaultConflict(schema) ?? ConflictResolution.ABORT;

				// Trusted-flush safety analysis — why this arm diverges from the others.
				// The insert arm's probe stays committed-only on the trusted-flush path,
				// while the update/delete arms below read the effective
				// (pending-over-committed) image UNCONDITIONALLY. That divergence is
				// safe: `flushOverlayToUnderlying` (isolation, isolated-table.ts) wraps
				// the flush in its own coordinator mini-transaction, the overlay holds
				// at most ONE entry per PK, and tombstone deletes are ordered before
				// inserts/updates — so when any flush write probes its own key, no
				// pending op exists at that key yet in the mini-transaction and the
				// effective read equals the committed read on every trusted probe. The
				// committed-only read kept here is therefore NOT a read-correctness
				// requirement but a pinned INTERNAL invariant: the flush routes existing
				// PKs to update, so a row present here is an isolation-layer violation we
				// must surface loudly (store-backing-host-substrate analysis).
				let existingRow: Row | null;
				if (args.trustedWrite) {
					const committed = await store.get(key);
					existingRow = committed ? deserializeRow(committed) : null;
				} else {
					existingRow = await this.readEffectiveRowByKey(key);
				}
				if (args.trustedWrite) {
					// Trusted flush insert: the overlay flush routes existing PKs to
					// update (via rowExistsInUnderlying), so a row already present here
					// is an isolation-layer invariant violation. Fail loudly rather than
					// silently overwrite — the flush try/catch rolls back and rethrows
					// (isolation-merged-unique-stale-underlying-false-positive).
					if (existingRow) {
						throw new QuereusError(
							`Trusted flush insert on '${this.tableName}' hit an existing PK; the overlay flush should route existing PKs to update. This indicates an isolation-layer invariant violation.`,
							StatusCode.INTERNAL,
						);
					}
				} else if (existingRow) {
					if (pkEffective === ConflictResolution.IGNORE) {
						return { status: 'ok', row: undefined };
					}
					if (pkEffective !== ConflictResolution.REPLACE) {
						return {
							status: 'constraint',
							constraint: 'unique',
							message: `UNIQUE constraint failed: ${this.tableName} PK.`,
							existingRow,
						};
					}
				}

				// Enforce non-PK UNIQUE constraints. Pass the original statement-level
				// onConflict so checkUniqueConstraints can resolve each UC's own
				// defaultConflict independently of the PK's default. Secondary-UNIQUE
				// REPLACE evictions accumulate in `evicted` for the executor pipeline.
				// Skipped for trusted flush writes: the overlay already validated the
				// final state and a value-swap cycle cannot pass a row-by-row re-check.
				const evicted: Row[] = [];
				if (!args.trustedWrite) {
					const ucResult = await this.checkUniqueConstraints(
						inTransaction,
						coerced,
						[pk],
						args.onConflict,
						evicted,
					);
					if (ucResult) return ucResult;
				}

				const oldRow = existingRow;
				const serializedRow = serializeRow(coerced);
				if (inTransaction) {
					coordinator.put(key, serializedRow, store);
				} else {
					await store.put(key, serializedRow);
				}

				// Update secondary indexes. An effective `oldRow` (a pending row at the
				// same PK, evicted under REPLACE) cancels the earlier pending index-put;
				// a commit-batch delete of a never-committed index key is a harmless no-op.
				await this.updateSecondaryIndexes(inTransaction, oldRow, coerced, pk);

				// Track statistics (only count as new if not replacing)
				if (!existingRow) {
					this.trackMutation(+1, inTransaction);
				}

				// Queue or emit event
				if (oldRow) {
					// REPLACE — emit as update
					const updateEvent = {
						type: 'update' as const,
						schemaName: schema.schemaName,
						tableName: schema.name,
						key: pk,
						oldRow,
						newRow: coerced,
					};
					if (inTransaction) {
						coordinator.queueEvent(updateEvent);
					} else {
						this.eventEmitter?.emitDataChange(updateEvent);
					}
				} else {
					const insertEvent = {
						type: 'insert' as const,
						schemaName: schema.schemaName,
						tableName: schema.name,
						key: pk,
						newRow: coerced,
					};
					if (inTransaction) {
						coordinator.queueEvent(insertEvent);
					} else {
						this.eventEmitter?.emitDataChange(insertEvent);
					}
				}

				return { status: 'ok', row: coerced, replacedRow: oldRow ?? undefined, evictedRows: evicted.length > 0 ? evicted : undefined };
			}

			case 'update': {
				if (!values || !oldKeyValues) throw new QuereusError('UPDATE requires values and oldKeyValues', StatusCode.MISUSE);
				const coerced = args.preCoerced ? values : this.coerceRow(values);
				const oldPk = this.extractPK(oldKeyValues);
				const newPk = this.extractPK(coerced);
				const oldKey = buildDataKey(oldPk, this.encodeOptions, this.pkDirections, this.pkKeyCollations);
				const newKey = buildDataKey(newPk, this.encodeOptions, this.pkDirections, this.pkKeyCollations);

				// Get old row for index updates. Read the effective
				// (pending-over-committed) image UNCONDITIONALLY — including the trusted
				// flush path — so an old image written earlier in the same transaction is
				// visible. This fixes index cleanup, the `uniqueColumnsChanged` gate, and
				// the event's `oldRow`. Trusted is safe here (see the insert-arm comment):
				// deletes-first ordering + one-entry-per-PK ⇒ effective ≡ committed on a
				// flush write probing its own key.
				const oldRow = await this.readEffectiveRowByKey(oldKey);

				// A PK "change" only relocates the row when the ENCODED key differs.
				// Under a non-binary PK collation (e.g. NOCASE) a case-only rewrite
				// ('apple' → 'APPLE') keeps the same physical key, so it is an in-place
				// update, not a relocation. Comparing raw values via keysEqual would
				// mis-classify it as a move and then false-detect a PK conflict against
				// the row's own existing entry at newKey (== oldKey). The encoded keys
				// are the storage layer's source of truth (mirrors the rekey path above).
				const pkChanged = !bytesEqual(oldKey, newKey);

				// Resolve PK-conflict action: statement OR > per-constraint default > ABORT.
				const pkEffective = args.onConflict ?? resolvePkDefaultConflict(schema) ?? ConflictResolution.ABORT;

				// PK-change UPDATE collides like an INSERT at the new key.
				// Capture the evicted row so it can be reported via `replacedRow`
				// (consumed by the executor for ON DELETE cascade/SET NULL of the
				// row at the new PK). Read the effective (pending-over-committed) image
				// so an evictee written earlier in the same transaction conflicts/evicts
				// rather than being silently overwritten.
				// Skipped for trusted flush writes — the overlay flush never changes a
				// row's PK (oldKeyValues and the row's PK columns are the same overlay
				// entry), so pkChanged is false there; the guard makes the intent explicit.
				let replacedAtNewPk: Row | null = null;
				if (pkChanged && !args.trustedWrite) {
					const existingAtNewRow = await this.readEffectiveRowByKey(newKey);
					if (existingAtNewRow) {
						if (pkEffective === ConflictResolution.IGNORE) {
							return { status: 'ok', row: undefined };
						}
						if (pkEffective !== ConflictResolution.REPLACE) {
							return {
								status: 'constraint',
								constraint: 'unique',
								message: `UNIQUE constraint failed: ${this.tableName} PK.`,
								existingRow: existingAtNewRow,
							};
						}
						replacedAtNewPk = existingAtNewRow;
					}
				}

				// Enforce non-PK UNIQUE constraints. For same-PK UPDATE, only check
				// constraints whose covered columns actually changed; pass [oldPk]
				// (= newPk) to skip self. For PK-change UPDATE, treat as relocation:
				// skip both old and new PK so we don't false-conflict against the
				// row we're moving. Pass the original statement-level onConflict so
				// each UC's own defaultConflict can be resolved independently.
				const selfPks: SqlValue[][] = pkChanged ? [oldPk, newPk] : [oldPk];
				// Skip the UNIQUE re-check for trusted flush writes: the overlay
				// merged-view check already validated the final state, and a value-swap
				// cycle cannot pass a row-by-row logical-UNIQUE re-check
				// (isolation-merged-unique-stale-underlying-false-positive).
				const shouldCheckUniques = !args.trustedWrite
					&& (pkChanged || (oldRow ? this.uniqueColumnsChanged(oldRow, coerced) : true));
				// Secondary-UNIQUE REPLACE evictions accumulate for the executor pipeline.
				const evicted: Row[] = [];
				if (shouldCheckUniques) {
					const ucResult = await this.checkUniqueConstraints(
						inTransaction,
						coerced,
						selfPks,
						args.onConflict,
						evicted,
					);
					if (ucResult) return ucResult;
				}

				// When REPLACE evicted a row at the new PK, fully delete it first
				// (data + secondary indexes + row-count + delete event) so its
				// state doesn't leak when we then put the moved row at newPk.
				// Mirrors MemoryTable's `recordDelete(newPK, existingRowAtNewKey)`
				// step in the PK-change-REPLACE path.
				if (replacedAtNewPk) {
					await this.deleteRowAt(inTransaction, newPk, replacedAtNewPk);
				}

				// Delete old key if PK changed
				if (pkChanged) {
					if (inTransaction) {
						coordinator.delete(oldKey, store);
					} else {
						await store.delete(oldKey);
					}
				}

				const serializedRow = serializeRow(coerced);
				if (inTransaction) {
					coordinator.put(newKey, serializedRow, store);
				} else {
					await store.put(newKey, serializedRow);
				}

				// Update secondary indexes. For PK-change UPDATE the old entry lives
				// at oldPk and the new entry must land at newPk; for same-PK UPDATE
				// both halves use the same key.
				await this.updateSecondaryIndexes(inTransaction, oldRow, coerced, oldPk, newPk);

				// Queue or emit event
				const updateEvent = {
					type: 'update' as const,
					schemaName: schema.schemaName,
					tableName: schema.name,
					key: newPk,
					oldRow: oldRow || undefined,
					newRow: coerced,
				};
				if (inTransaction) {
					coordinator.queueEvent(updateEvent);
				} else {
					this.eventEmitter?.emitDataChange(updateEvent);
				}

				return { status: 'ok', row: coerced, replacedRow: replacedAtNewPk ?? undefined, evictedRows: evicted.length > 0 ? evicted : undefined };
			}

			case 'delete': {
				if (!oldKeyValues) throw new QuereusError('DELETE requires oldKeyValues', StatusCode.MISUSE);
				const pk = this.extractPK(oldKeyValues);
				const key = buildDataKey(pk, this.encodeOptions, this.pkDirections, this.pkKeyCollations);

				// Get old row for index cleanup. Read the effective
				// (pending-over-committed) image so a row inserted earlier in the same
				// transaction is seen: this fixes index cleanup, the `-1` stats delta
				// (netting an insert+delete to zero), and the event's `oldRow`.
				// `coordinator.delete(key)` cancels a pending put; a commit-batch delete
				// of a never-committed key is a harmless no-op. The trusted flush delete
				// arm does NOT pass `trustedWrite`, but deletes-first ordering +
				// one-entry-per-PK keep effective ≡ committed there too (see insert arm).
				const oldRow = await this.readEffectiveRowByKey(key);

				if (inTransaction) {
					coordinator.delete(key, store);
				} else {
					await store.delete(key);
				}

				// Remove from secondary indexes
				if (oldRow) {
					await this.updateSecondaryIndexes(inTransaction, oldRow, null, pk);
					this.trackMutation(-1, inTransaction);
				}

				// Queue or emit event
				const deleteEvent = {
					type: 'delete' as const,
					schemaName: schema.schemaName,
					tableName: schema.name,
					key: pk,
					oldRow: oldRow || undefined,
				};
				if (inTransaction) {
					coordinator.queueEvent(deleteEvent);
				} else {
					this.eventEmitter?.emitDataChange(deleteEvent);
				}

				return { status: 'ok', row: oldRow || undefined };
			}

			default:
				throw new QuereusError(`Unknown operation: ${operation}`, StatusCode.MISUSE);
		}
	}

	/**
	 * Update secondary indexes after a row change.
	 *
	 * For PK-change UPDATE, `oldPk` (where the existing entry lives) and `newPk`
	 * (where the relocated entry will live) differ; using a single pk for both
	 * sides leaks the old entry. Other paths pass the same pk for both.
	 */
	protected async updateSecondaryIndexes(
		inTransaction: boolean,
		oldRow: Row | null,
		newRow: Row | null,
		oldPk: SqlValue[],
		newPk: SqlValue[] = oldPk,
	): Promise<void> {
		const schema = this.tableSchema!;
		const indexes = schema.indexes || [];

		for (const index of indexes) {
			const indexStore = await this.ensureIndexStore(index.name);
			const indexCols = index.columns.map(c => c.index);
			const indexDirections = index.columns.map(c => !!c.desc);

			// Partial index: only rows the predicate unambiguously accepts are
			// indexed (mirrors buildIndexEntries' build-time filtering). Guarding both
			// halves keeps a row that transitions across the predicate scope on UPDATE
			// correct — an in-scope→out-of-scope edit removes the old entry and adds
			// none; the reverse adds without a stale delete. A full index (no
			// predicate) always maintains its entry.
			const predicate = this.compileIndexFor(index);

			// Remove old index entry (only if the old row was within scope).
			if (oldRow && (!predicate || predicate.evaluate(oldRow) === true)) {
				const oldIndexValues = indexCols.map(i => oldRow[i]);
				const oldIndexKey = buildIndexKey(
					oldIndexValues,
					oldPk,
					this.encodeOptions,
					indexDirections,
					this.pkDirections,
					this.pkKeyCollations,
				);

				if (inTransaction && this.coordinator) {
					this.coordinator.delete(oldIndexKey, indexStore);
				} else {
					await indexStore.delete(oldIndexKey);
				}
			}

			// Add new index entry (only if the new row is within scope).
			if (newRow && (!predicate || predicate.evaluate(newRow) === true)) {
				const newIndexValues = indexCols.map(i => newRow[i]);
				const newIndexKey = buildIndexKey(
					newIndexValues,
					newPk,
					this.encodeOptions,
					indexDirections,
					this.pkDirections,
					this.pkKeyCollations,
				);
				// Index value = the row's encoded DATA key. The index-entry key can
				// locate a row's byte window, but its PK suffix is not losslessly
				// recoverable to SqlValues (a NOCASE/RTRIM PK column encodes lossily)
				// and its length varies per entry in a range scan — so a scan resolves
				// each entry back to its base row via this stored data key
				// (`scanIndex` → `readEffectiveRowByKey(entry.value)`), never by
				// decoding the suffix. `newPk` is the PK the entry is keyed under, so
				// its data key byte-matches the data store's key for this row.
				const dataKeyValue = this.encodeDataKey(newPk);

				if (inTransaction && this.coordinator) {
					this.coordinator.put(newIndexKey, dataKeyValue, indexStore);
				} else {
					await indexStore.put(newIndexKey, dataKeyValue);
				}
			}
		}
	}

	/**
	 * Returns the compiled predicate for a partial-UNIQUE constraint, or undefined
	 * when the constraint covers the full table. Compilation is memoized per
	 * UniqueConstraintSchema instance so the hot UNIQUE-check path doesn't recompile.
	 */
	private compileFor(uc: UniqueConstraintSchema): CompiledPredicate | undefined {
		if (!uc.predicate) return undefined;
		let compiled = this.predicateCache.get(uc);
		if (!compiled) {
			compiled = compilePredicate(uc.predicate, this.tableSchema!.columns);
			this.predicateCache.set(uc, compiled);
		}
		return compiled;
	}

	/**
	 * Returns the compiled predicate for a partial secondary index, or undefined
	 * for a full index. Compilation is memoized per IndexSchema instance so the hot
	 * DML index-maintenance path doesn't recompile.
	 */
	private compileIndexFor(index: TableIndexSchema): CompiledPredicate | undefined {
		if (!index.predicate) return undefined;
		let compiled = this.indexPredicateCache.get(index);
		if (!compiled) {
			compiled = compilePredicate(index.predicate, this.tableSchema!.columns);
			this.indexPredicateCache.set(index, compiled);
		}
		return compiled;
	}

	/** Check if two PK arrays are equal. */
	protected keysEqual(a: SqlValue[], b: SqlValue[]): boolean {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (a[i] !== b[i]) return false;
		}
		return true;
	}

	/**
	 * Returns true if any column covered by a UNIQUE constraint differs between
	 * oldRow and newRow, or — for partial UNIQUE — any column referenced by the
	 * partial predicate differs (which can transition the row across the
	 * predicate scope and re-trigger the uniqueness check).
	 */
	protected uniqueColumnsChanged(oldRow: Row, newRow: Row): boolean {
		const ucs = this.tableSchema?.uniqueConstraints;
		if (!ucs || ucs.length === 0) return false;
		for (const uc of ucs) {
			for (const colIdx of uc.columns) {
				if (compareSqlValues(oldRow[colIdx], newRow[colIdx]) !== 0) return true;
			}
			if (uc.predicate) {
				const compiled = this.compileFor(uc);
				if (compiled) {
					for (const colIdx of compiled.referencedColumns) {
						if (compareSqlValues(oldRow[colIdx], newRow[colIdx]) !== 0) return true;
					}
				}
			}
		}
		return false;
	}

	/**
	 * Enforce table-level UNIQUE constraints against the prospective newRow.
	 * Honors `onConflict`: IGNORE returns an ok-with-undefined-row; REPLACE
	 * deletes the conflicting row(s) and continues; otherwise returns a
	 * constraint result. Returns null when all constraints pass.
	 *
	 * Rows whose PK is in `selfPks` are skipped (the row being inserted/updated).
	 * NULL in any covered column skips that constraint (multiple NULLs are allowed
	 * per SQL standard).
	 *
	 * Reads through the transaction coordinator's pending writes when active so
	 * intra-transaction duplicates are detected.
	 *
	 * REPLACE evictions (rows at OTHER PKs) are deleted from storage and pushed onto
	 * `evicted` so the DML executor runs the full delete pipeline for each
	 * (change-tracking, row-time MV maintenance, FK cascade, auto-events).
	 */
	protected async checkUniqueConstraints(
		inTransaction: boolean,
		newRow: Row,
		selfPks: SqlValue[][],
		onConflict: ConflictResolution | undefined,
		evicted: Row[],
	): Promise<UpdateResult | null> {
		const schema = this.tableSchema!;
		const uniqueConstraints = schema.uniqueConstraints;
		if (!uniqueConstraints || uniqueConstraints.length === 0) return null;

		for (const uc of uniqueConstraints) {
			if (uc.columns.some(idx => newRow[idx] === null)) continue;

			// Partial UNIQUE: a row whose predicate is not unambiguously TRUE is
			// outside the index's scope and contributes nothing to uniqueness.
			const predicate = this.compileFor(uc);
			if (predicate && predicate.evaluate(newRow) !== true) continue;

			const conflict = await this.findUniqueConflictFor(uc, predicate, newRow, selfPks);
			if (!conflict) continue;

			// Resolve action per-constraint: statement OR > per-UC default > ABORT.
			const effective = onConflict ?? uc.defaultConflict ?? ConflictResolution.ABORT;
			if (effective === ConflictResolution.IGNORE) {
				return { status: 'ok', row: undefined };
			}
			if (effective === ConflictResolution.REPLACE) {
				await this.deleteRowAt(inTransaction, conflict.pk, conflict.row);
				// Report the eviction so the executor runs its full delete pipeline —
				// including the row-time covering-structure maintenance that drops the
				// evicted source row's backing entry within this statement (else a later
				// same-UC row sees a phantom). The executor processes the eviction before
				// the writing row's own bookkeeping, so the backing delete still lands
				// mid-statement.
				evicted.push(conflict.row);
				continue;
			}
			const colNames = uc.columns.map(i => schema.columns[i].name).join(', ');
			return {
				status: 'constraint',
				constraint: 'unique',
				message: `UNIQUE constraint failed: ${schema.name} (${colNames})`,
				existingRow: conflict.row,
			};
		}
		return null;
	}

	/**
	 * Route one UNIQUE constraint's conflict search to the cheapest SOUND finder,
	 * in descending preference:
	 *
	 *  1. A linked row-time covering MV — its backing table (hosted by any
	 *     backing-host-capable module — memory by default, this store module under
	 *     `using store` — queried through the db with reads-own-writes) answers the
	 *     uniqueness question, mirroring the memory enforcement path.
	 *  2. A physical secondary index realizing the constraint — one prefix seek
	 *     instead of a full table scan (see {@link findIndexForUniqueConstraint}).
	 *  3. The full data-store scan ({@link findUniqueConflict}) — always correct,
	 *     O(rows) per checked row.
	 *
	 * Every finder returns the SAME `{pk, row}` shape, so the caller's conflict
	 * action (ABORT / IGNORE / REPLACE eviction) is finder-independent.
	 */
	private async findUniqueConflictFor(
		uc: UniqueConstraintSchema,
		predicate: CompiledPredicate | undefined,
		newRow: Row,
		selfPks: SqlValue[][],
	): Promise<UniqueConflict | null> {
		const schema = this.tableSchema!;
		const coveringMv = (this.db as DatabaseInternal)._findRowTimeCoveringStructure(schema.schemaName, schema.name, uc);
		if (coveringMv) return this.findUniqueConflictViaCoveringMv(coveringMv, uc, predicate, newRow, selfPks);

		const index = this.findIndexForUniqueConstraint(uc);
		if (index) {
			const viaIndex = await this.findUniqueConflictViaIndex(index, uc, predicate, newRow, selfPks);
			if (viaIndex !== INDEX_UNUSABLE) return viaIndex;
		}
		return this.findUniqueConflict(uc, predicate, newRow, selfPks);
	}

	/**
	 * The `schema.indexes` entry whose physical index store can serve `uc`'s
	 * conflict search as a point seek, or undefined when none can.
	 *
	 * The store materializes an index store ONLY for an explicit `CREATE INDEX` /
	 * `CREATE UNIQUE INDEX` — a plain column- or table-level `UNIQUE` gets a
	 * `uniqueConstraints` entry but no backing store (unlike the memory backend,
	 * which auto-builds an implicit `_uc_*` covering index). So a UC is
	 * index-servable only when:
	 *
	 *  - it is index-derived (`derivedFromIndex`, from `CREATE UNIQUE INDEX`) and
	 *    its named index is still present — the index's partial predicate then
	 *    equals the constraint's by construction (`appendIndexToTableSchema`); or
	 *  - some FULL (non-partial) index's columns equal `uc.columns` positionally.
	 *    A partial index cannot serve a non-derived UC: it physically omits its
	 *    out-of-scope rows, so a seek would MISS a conflict among them. The index
	 *    need not be UNIQUE — a plain index over the constrained columns still
	 *    holds every row and narrows the candidate set.
	 *
	 * Collation guard (see {@link indexSeekHonorsEnforcementCollation}) may still
	 * reject the found index, which routes the check back to the full scan.
	 */
	private findIndexForUniqueConstraint(uc: UniqueConstraintSchema): TableIndexSchema | undefined {
		// NOTE: re-resolved for every constrained ROW written, and the collation guard
		// below re-derives `uniqueEnforcementCollations` each time. Both are linear in
		// `schema.indexes` / `uc.columns` and dwarfed by the seek's I/O, so this is fine
		// now. If a table with many indexes ever shows up on an insert-heavy profile,
		// memoize the (uc → index | undefined) resolution in a WeakMap keyed on the
		// frozen UniqueConstraintSchema, as `predicateCache` above does — a CREATE/DROP
		// INDEX yields fresh constraint objects, so such a cache invalidates itself.
		const indexes = this.tableSchema?.indexes;
		if (!indexes || indexes.length === 0) return undefined;

		const index = uc.derivedFromIndex
			? indexes.find(ix => ix.name === uc.derivedFromIndex)
			: indexes.find(ix => !ix.predicate
				&& ix.columns.length === uc.columns.length
				&& ix.columns.every((c, i) => c.index === uc.columns[i]));
		if (!index) return undefined;
		return this.indexSeekHonorsEnforcementCollation(uc) ? index : undefined;
	}

	/**
	 * True when a point seek into the index realizing `uc` returns a SUPERSET of
	 * the constraint's true conflict set — the only condition under which the
	 * seek may replace the full scan.
	 *
	 * An index key's leading (index-column) bytes are encoded under the TABLE KEY
	 * collation K (`buildIndexKey` passes `this.encodeOptions`), NOT the index's
	 * declared per-column COLLATE and NOT the constraint's enforcement collation
	 * C (`uniqueEnforcementCollations` — the index's per-column COLLATE for an
	 * index-derived UC, else the declared column collation). A seek therefore
	 * fetches exactly `{rows K-equal to newRow}` while the re-validation keeps
	 * `{rows C-equal to newRow}`. Soundness needs
	 * `{C-equal} ⊆ {K-equal}`, i.e. K must be COARSER-OR-EQUAL to C per column:
	 *
	 *  - non-text column → its bytes are type-native, collation-independent: safe.
	 *  - C == K → the sets coincide: safe.
	 *  - K = NOCASE, C = BINARY → K strictly coarser: safe superset.
	 *  - otherwise (K = BINARY over C = NOCASE/RTRIM; K = NOCASE over C = RTRIM)
	 *    the seek UNDER-fetches and a real duplicate would be silently accepted:
	 *    reject, so the caller full-scans.
	 *
	 * Same direction and same admitted cases as the read-side guard in
	 * `StoreModule.tryIndexAccessPlan`; conservative rather than exhaustive
	 * (K = RTRIM over C = BINARY is provably safe but declined), which costs an
	 * optimization, never correctness. The coarseness test is only sound for the
	 * built-in names: a custom K equals a custom C only when the index column names
	 * that same collation, and otherwise falls through to the full scan.
	 */
	private indexSeekHonorsEnforcementCollation(uc: UniqueConstraintSchema): boolean {
		const schema = this.tableSchema!;
		const K = (this.encodeOptions.collation ?? 'NOCASE').toUpperCase();

		const collations = uniqueEnforcementCollations(schema, uc);
		return uc.columns.every((colIdx, i) => {
			if (!columnCanHoldText(schema.columns[colIdx])) return true;
			const C = (collations[i] ?? 'BINARY').toUpperCase();
			return C === K || (K === 'NOCASE' && C === 'BINARY');
		});
	}

	/**
	 * The index analogue of {@link findUniqueConflict}: seek the index realizing
	 * `uc` at the point formed by `newRow`'s constrained-column values, and
	 * re-validate each resolved candidate exactly as the full scan does.
	 *
	 * The seek encodes ALL of `uc.columns` (positionally aligned with the index's
	 * columns, guaranteed by `appendIndexToTableSchema` / the column-set match in
	 * {@link findIndexForUniqueConstraint}) as a leading prefix of the index key,
	 * under the same key collation and per-column DESC directions
	 * {@link updateSecondaryIndexes} used to write it. The remaining suffix is the
	 * row's PK, so the window spans every entry sharing those column values.
	 * {@link iterateEffective} merges this transaction's pending index puts/deletes
	 * over the committed entries, giving read-your-own-writes; each entry resolves
	 * to its LIVE row through the data key stored as the entry's value.
	 *
	 * The seek only narrows the CANDIDATE set to a superset (guaranteed by
	 * {@link indexSeekHonorsEnforcementCollation}); the authoritative comparison is
	 * the identical self-PK exclusion, per-column enforcement-collation compare,
	 * and partial-predicate scope check the full scan performs. A partial index
	 * already excludes out-of-scope rows physically — the predicate re-check is
	 * kept as defense in depth.
	 *
	 * Returns {@link INDEX_UNUSABLE} rather than a (possibly wrong) answer when an
	 * entry carries a legacy empty value.
	 */
	private async findUniqueConflictViaIndex(
		index: TableIndexSchema,
		uc: UniqueConstraintSchema,
		predicate: CompiledPredicate | undefined,
		newRow: Row,
		selfPks: SqlValue[][],
	): Promise<UniqueConflict | null | typeof INDEX_UNUSABLE> {
		const indexStore = await this.ensureIndexStore(index.name);
		// Resolved once, above the candidate loop: the resolver throws on an
		// unregistered name and cannot be inlined, so a per-candidate call would be
		// pure overhead.
		const collations = resolveUniqueEnforcementCollations(this.tableSchema!, uc, this.collationResolver);
		const bounds = buildIndexPrefixBounds(
			uc.columns.map(c => newRow[c]),
			this.encodeOptions,
			index.columns.map(c => !!c.desc),
		);

		for await (const entry of this.iterateEffective(indexStore, bounds)) {
			// A legacy index store (written before index values carried the data key)
			// holds EMPTY values. `scanIndex` may skip such an entry — a read that
			// returns too few rows. Skipping here would instead ACCEPT a duplicate, so
			// abandon the index and let the caller full-scan. See the NOTE in
			// `scanIndex` for the durable fix.
			if (entry.value.length === 0) return INDEX_UNUSABLE;

			// Resolve to the LIVE row: a pending index delete normally suppresses the
			// entry, but a committed entry can lag a row deleted this transaction.
			const candidate = await this.readEffectiveRowByKey(entry.value);
			if (!candidate) continue;

			const pk = this.extractPK(candidate);
			if (selfPks.some(skip => this.keysEqual(pk, skip))) continue;
			if (uc.columns.some((c, i) => compareSqlValuesFast(newRow[c], candidate[c], collations[i]) !== 0)) continue;
			if (predicate && predicate.evaluate(candidate) !== true) continue;
			return { pk, row: candidate };
		}
		return null;
	}

	/**
	 * Scan committed + pending data rows for a row matching `newRow` on
	 * `uc.columns` whose PK is not in `selfPks`. For partial UNIQUE, candidates
	 * whose row does not satisfy the predicate are skipped. Returns the first
	 * match or null.
	 */
	private async findUniqueConflict(
		uc: UniqueConstraintSchema,
		predicate: CompiledPredicate | undefined,
		newRow: Row,
		selfPks: SqlValue[][],
	): Promise<UniqueConflict | null> {
		const store = await this.ensureStore();
		// Pending ops for THIS table's data store handle — the same handle the
		// write path queues data ops under, so the merge sees only this table's
		// pending state, never a sibling table's on the shared module coordinator.
		const pending = this.coordinator?.isInTransaction()
			? this.coordinator.getPendingOpsForStore(store)
			: null;
		const constrainedCols = uc.columns;
		// One comparison collation per constrained column — the index's per-column
		// COLLATE for an index-derived UNIQUE, else the declared column collation.
		// Resolved once here, not per candidate row.
		const collations = resolveUniqueEnforcementCollations(this.tableSchema!, uc, this.collationResolver);

		const matches = (candidate: Row): UniqueConflict | null => {
			const pk = this.extractPK(candidate);
			for (const skip of selfPks) {
				if (this.keysEqual(pk, skip)) return null;
			}
			for (let i = 0; i < constrainedCols.length; i++) {
				const idx = constrainedCols[i];
				if (compareSqlValuesFast(newRow[idx], candidate[idx], collations[i]) !== 0) return null;
			}
			// Partial UNIQUE: candidate must also be in the predicate's scope to conflict.
			if (predicate && predicate.evaluate(candidate) !== true) return null;
			return { pk, row: candidate };
		};

		const seen = new Set<string>();
		const bounds = buildFullScanBounds();
		for await (const entry of store.iterate(bounds)) {
			const hex = bytesToHex(entry.key);
			seen.add(hex);
			if (pending?.deletes.has(hex)) continue;
			const overlay = pending?.puts.get(hex);
			const value = overlay ? overlay.value : entry.value;
			const found = matches(deserializeRow(value));
			if (found) return found;
		}

		if (pending) {
			for (const [hex, op] of pending.puts) {
				if (seen.has(hex)) continue;
				const found = matches(deserializeRow(op.value));
				if (found) return found;
			}
		}
		return null;
	}

	/**
	 * Find a UNIQUE conflict through a linked row-time covering MV's backing table
	 * (the store analogue of the memory `checkUniqueViaMaterializedView`). The
	 * backing scan yields candidate conflicting **source** PKs (reads-own-writes via
	 * the backing's coordinated connection); each is validated against the *live*
	 * store row (committed + this transaction's pending overlay) so a backing entry
	 * that lags a row deleted/updated internally this statement is skipped rather
	 * than raised as a false conflict. Returns the first real conflict or null.
	 */
	private async findUniqueConflictViaCoveringMv(
		mv: MaintainedTableSchema,
		uc: UniqueConstraintSchema,
		predicate: CompiledPredicate | undefined,
		newRow: Row,
		selfPks: SqlValue[][],
	): Promise<UniqueConflict | null> {
		const newSourcePk = this.extractPK(newRow);
		// Resolved once, above the candidate loop.
		const collations = resolveUniqueEnforcementCollations(this.tableSchema!, uc, this.collationResolver);
		const candidates = await (this.db as DatabaseInternal)._lookupCoveringConflicts(mv, uc, newRow, newSourcePk);
		for (const cand of candidates) {
			const liveRow = await this.readLiveRowByPk(cand.pk);
			if (!liveRow) continue; // stale backing candidate (source row gone)
			if (selfPks.some(pk => this.keysEqual(pk, cand.pk))) continue;
			// Re-validate under each column's enforcement collation (the index's
			// per-column COLLATE for an index-derived UNIQUE, else declared) — see
			// uniqueEnforcementCollations. The candidate generation
			// (_lookupCoveringConflicts) narrows under the SOURCE column's declared
			// collation, so for a FINER index (BINARY over a NOCASE column) it returns a
			// superset this filters down correctly. A finer/incomparable index-derived
			// UNIQUE whose declared candidate set could be a SUBSET (e.g. a coarser NOCASE
			// index over a BINARY column) is declined upstream by the collation gate in
			// findRowTimeCoveringStructure, so only BINARY-floor or equal-collation MVs
			// reach here — the superset this re-validation can soundly filter.
			if (uc.columns.some((c, i) => compareSqlValuesFast(newRow[c], liveRow[c], collations[i]) !== 0)) continue;
			if (predicate && predicate.evaluate(liveRow) !== true) continue;
			return { pk: cand.pk, row: liveRow };
		}
		return null;
	}

	/**
	 * Read the live row at `pk` — this transaction's pending overlay (a pending
	 * delete ⇒ gone; a pending put ⇒ its value) shadowing the committed store.
	 * Backs `query()`'s point-lookup arm and validates covering-MV conflict
	 * candidates against the source of truth.
	 */
	private async readLiveRowByPk(pk: SqlValue[]): Promise<Row | null> {
		return this.readEffectiveRowByKey(this.encodeDataKey(pk));
	}

	// ── Backing-host surface ──────────────────────────────────────────────
	// Narrow public surface `StoreBackingHost` (backing-host.ts) drives. Each
	// method addresses the table's CURRENT schema/encoding state, so a host
	// resolved fresh per engine call always keys and merges consistently with
	// the table's own read/write paths.

	/** Encode `pkValues` (in PK-definition order) exactly as the data store keys rows. */
	encodeDataKey(pkValues: SqlValue[]): Uint8Array {
		return buildDataKey(pkValues, this.encodeOptions, this.pkDirections, this.pkKeyCollations);
	}

	/**
	 * Byte bounds covering every data key whose leading PK columns equal
	 * `prefixValues` — encoded under the same per-column DESC directions and key
	 * collations as {@link encodeDataKey}, so seek + early-terminate addresses the
	 * exact slice. An empty prefix yields full-scan bounds.
	 */
	encodePkPrefixBounds(prefixValues: SqlValue[]): { gte: Uint8Array; lt?: Uint8Array } {
		return buildPkPrefixBounds(
			prefixValues,
			this.encodeOptions,
			this.pkDirections.slice(0, prefixValues.length),
			this.pkKeyCollations.slice(0, prefixValues.length),
		);
	}

	/**
	 * Effective (pending-over-committed) point read by encoded data key: a pending
	 * delete ⇒ null, a pending put ⇒ its value, else the committed store entry.
	 */
	async readEffectiveRowByKey(key: Uint8Array): Promise<Row | null> {
		const store = await this.ensureStore();
		// Pending ops for THIS table's data store handle — see findUniqueConflict.
		const pending = this.coordinator?.isInTransaction()
			? this.coordinator.getPendingOpsForStore(store)
			: null;
		if (pending) {
			const hex = bytesToHex(key);
			if (pending.deletes.has(hex)) return null;
			const overlay = pending.puts.get(hex);
			if (overlay) return deserializeRow(overlay.value);
		}
		const value = await store.get(key);
		return value ? deserializeRow(value) : null;
	}

	/**
	 * Effective ordered entry scan within `bounds` (see {@link iterateEffective}).
	 * Opens the data store first — which fires the lazy first-access `saveTableDDL`
	 * for a freshly created table, the catalog write a store-backed MV backing
	 * relies on to survive reopen.
	 */
	async *iterateEffectiveEntries(
		bounds: IterateOptions,
		reverse = false,
	): AsyncIterable<KVEntry> {
		const store = await this.ensureStore();
		yield* this.iterateEffective(store, bounds, reverse);
	}

	/** Buffer a privileged row-count delta, applied at coordinator commit (host writes). */
	trackPrivilegedMutation(delta: number): void {
		this.trackMutation(delta, true);
	}

	/**
	 * Declared secondary-UNIQUE enforcement for maintenance writes — the store
	 * mirror of the memory manager's `enforceSecondaryUniqueOnMaintenance` (see
	 * `vtab/backing-host.ts` § Constraint validation for the contract and
	 * docs/mv-constraints.md § Derived-row constraint validation for the
	 * semantics). Called by `StoreBackingHost.applyMaintenance` AFTER the op
	 * batch lands in the coordinator's pending state: post-batch is load-bearing
	 * (a `replace-all` diff applies puts before deletes, so a per-op check would
	 * false-positive when the derived set moves a unique value between primary
	 * keys), and checking only the WRITTEN images is complete (pre-existing
	 * contents already satisfied the constraint).
	 *
	 * Reuses {@link findUniqueConflict} — pending-overlay reads, per-column
	 * collations, NULL-pass, partial-predicate scope, self-PK exclusion — with
	 * the covering-MV route deliberately bypassed: a covering MV over THIS table
	 * is cascade-maintained only after the batch returns, so it lags the batch
	 * and would miss a same-batch colliding pair. The conflict action is a hard
	 * abort (a derivation write carries no user OR clause, and a declared
	 * `on conflict replace`/`ignore` default must not evict or drop derived
	 * rows). Per-image cost is one effective full scan: unlike the DML path
	 * ({@link findUniqueConflictFor}), this one is NOT routed through
	 * {@link findUniqueConflictViaIndex}, because a backing table keeps no
	 * secondary indexes by design — there is never an index store to seek.
	 *
	 * Zero overhead when the table declares no secondary UNIQUE (every MV-sugar
	 * backing, and most maintained tables): one empty-array check.
	 */
	async enforceSecondaryUniqueForMaintenance(changes: readonly BackingRowChange[]): Promise<void> {
		const schema = this.tableSchema;
		const ucs = schema?.uniqueConstraints;
		if (!schema || !ucs || ucs.length === 0 || changes.length === 0) return;

		for (const change of changes) {
			if (change.op === 'delete') continue;
			const newRow = change.newRow;
			const selfPks = [this.extractPK(newRow)];
			for (const uc of ucs) {
				// SQL semantics: UNIQUE allows multiple NULLs.
				if (uc.columns.some(idx => newRow[idx] === null)) continue;
				// Partial UNIQUE: an out-of-scope image contributes nothing.
				const predicate = this.compileFor(uc);
				if (predicate && predicate.evaluate(newRow) !== true) continue;
				const conflict = await this.findUniqueConflict(uc, predicate, newRow, selfPks);
				if (conflict) {
					const colNames = uc.columns.map(i => schema.columns[i]?.name ?? String(i));
					throw maintainedTableUniqueViolationError(
						schema.schemaName, schema.name,
						uc.name ?? `_uc_${colNames.join('_')}`,
						colNames,
						uc.columns.map(i => newRow[i]),
					);
				}
			}
		}
	}

	/**
	 * Reset statistics to an absolute committed row count and flush immediately.
	 * Used by the host's `replaceContents` (create-fill / refresh), where the new
	 * count is exact, replacing any drifted delta-tracked estimate.
	 */
	async resetStats(rowCount: number): Promise<void> {
		this.cachedStats = { rowCount, updatedAt: Date.now() };
		this.pendingStatsDelta = 0;
		this.mutationCount = 0;
		await this.flushStats();
	}

	/**
	 * Open (and cache) the data store, firing the lazy first-access `saveTableDDL`.
	 * Public for the host's `replaceContents`, which writes the store directly.
	 */
	openDataStore(): Promise<KVStore> {
		return this.ensureStore();
	}

	// ── External row-write surface ────────────────────────────────────────
	// Module-side entry point for externally-applied writes to a SOURCE table
	// (the index-maintaining sibling of `StoreBackingHost`, which is for MV
	// BACKING tables and deliberately keeps no indexes). Resolved per call via
	// `StoreModule.getTableForExternalWrite`; addresses the table's CURRENT
	// schema/encoding state so keys and index entries match its own DML paths.

	/**
	 * Effective (pending-over-committed) point read by PK values — the public
	 * read an external writer issues before an upsert to learn the row's current
	 * image. Thin wrapper over the same private point-lookup that backs
	 * {@link query}'s point arm, so an external read merges pending-over-committed
	 * exactly like an engine read does.
	 */
	readRowByPk(pk: SqlValue[]): Promise<Row | null> {
		return this.readLiveRowByPk(pk);
	}

	/**
	 * Apply externally-originated row ops directly to this source table's
	 * COMMITTED storage: table-owned data-key put/delete, secondary-index
	 * maintenance, and stats tracking. The index-maintaining counterpart of
	 * `StoreBackingHost.applyMaintenance` (which targets index-less MV backings),
	 * built for trusted replication-style writes.
	 *
	 * Deliberately:
	 *   - emits NO module {@link DataChangeEvent}s — the external writer owns
	 *     emission and the `remote` flag;
	 *   - opens NO coordinator transaction — writes land in committed state
	 *     immediately (`store.put`/`store.delete`, never the coordinator);
	 *   - runs NO constraint validation (PK/UNIQUE/CHECK/FK) — the origin is
	 *     trusted, mirroring the backing-host posture.
	 *
	 * Returns the EFFECTIVE per-op {@link BackingRowChange}s with accurate
	 * before-images (the shape `Database.ingestExternalRowChanges` consumes),
	 * suppressing no-ops to match the normative upsert-suppression contract in
	 * `vtab/backing-host.ts`: a delete of an absent key, and a value-identical
	 * upsert (`rowsValueIdentical` — byte-faithful, collation-UNAWARE, against the
	 * effective existing row) write nothing and report nothing. A collation-equal /
	 * byte-different upsert (e.g. a case-only rewrite under a NOCASE PK) keeps the
	 * SAME data key (key identity is collation-aware) but IS a real update that
	 * replaces the stored bytes and reports `update`.
	 *
	 * Last-writer-wins against any concurrently pending local transaction on this
	 * table: the external write commits to storage at once, and that transaction's
	 * pending batch may overwrite these keys when it commits. This is the same
	 * posture the prior raw-KV sync adapter took — not a regression, now stated.
	 */
	async applyExternalRowChanges(ops: readonly ExternalRowOp[]): Promise<BackingRowChange[]> {
		const changes: BackingRowChange[] = [];
		if (ops.length === 0) return changes;

		// Route through the lazy store-open path so the first external write to a
		// freshly created table persists its DDL exactly like a first vtab write.
		const store = await this.ensureStore();

		for (const op of ops) {
			switch (op.op) {
				case 'delete': {
					const key = this.encodeDataKey(op.pk);
					const existing = await this.readEffectiveRowByKey(key);
					if (!existing) break; // absent key → no storage/index/stats op, nothing reported
					await store.delete(key);
					await this.updateSecondaryIndexes(false, existing, null, op.pk);
					this.trackMutation(-1, false);
					changes.push({ op: 'delete', oldRow: existing });
					break;
				}
				case 'upsert': {
					const pk = this.extractPK(op.row);
					const key = this.encodeDataKey(pk);
					const existing = await this.readEffectiveRowByKey(key);
					if (existing && rowsValueIdentical(existing, op.row)) {
						// Byte-identical to the effective row → a true no-op: no write, no
						// index touch, no stats delta, nothing reported (echo-prevention seam).
						break;
					}
					await store.put(key, serializeRow(op.row));
					// PK derives from the row, so the key never relocates: oldPk == newPk.
					await this.updateSecondaryIndexes(false, existing, op.row, pk);
					if (!existing) this.trackMutation(+1, false);
					changes.push(existing
						? { op: 'update', oldRow: existing, newRow: op.row }
						: { op: 'insert', newRow: op.row });
					break;
				}
				default: {
					// A new ExternalRowOp variant must extend this switch; never-assignment
					// makes that a compile error rather than a silent no-op.
					const exhaustiveCheck: never = op;
					throw new QuereusError(`Unknown external row op: ${JSON.stringify(exhaustiveCheck)}`, StatusCode.INTERNAL);
				}
			}
		}
		return changes;
	}

	/**
	 * Fully delete the row at `pk` (data + secondary indexes + stats + delete event).
	 * Used by REPLACE conflict resolution to evict a conflicting unique row before
	 * the caller's insert/update proceeds.
	 */
	private async deleteRowAt(
		inTransaction: boolean,
		pk: SqlValue[],
		oldRow: Row,
	): Promise<void> {
		const store = await this.ensureStore();
		const key = buildDataKey(pk, this.encodeOptions, this.pkDirections, this.pkKeyCollations);
		if (inTransaction && this.coordinator) {
			this.coordinator.delete(key, store);
		} else {
			await store.delete(key);
		}
		await this.updateSecondaryIndexes(inTransaction, oldRow, null, pk);
		this.trackMutation(-1, inTransaction);

		const schema = this.tableSchema!;
		const deleteEvent = {
			type: 'delete' as const,
			schemaName: schema.schemaName,
			tableName: schema.name,
			key: pk,
			oldRow,
		};
		if (inTransaction && this.coordinator) {
			this.coordinator.queueEvent(deleteEvent);
		} else {
			this.eventEmitter?.emitDataChange(deleteEvent);
		}
	}

	/**
	 * Begin a table-scoped transaction by ensuring the coordinator is active.
	 *
	 * Used by the isolation layer's flush path, which treats the underlying
	 * write as an independent mini-transaction. Idempotent: if the coordinator
	 * is already in a transaction (e.g. started by a registered connection),
	 * this is a no-op.
	 */
	async begin(): Promise<void> {
		const coordinator = await this.ensureCoordinator();
		coordinator.begin();
	}

	/**
	 * Commits a table-scoped transaction, flushing any buffered writes to the KV store.
	 * No-op if the coordinator is not currently in a transaction.
	 */
	async commit(): Promise<void> {
		if (this.coordinator?.isInTransaction()) {
			await this.coordinator.commit();
		}
	}

	/**
	 * Rolls back a table-scoped transaction, discarding any buffered writes.
	 * No-op if the coordinator is not currently in a transaction.
	 */
	async rollback(): Promise<void> {
		if (this.coordinator?.isInTransaction()) {
			this.coordinator.rollback();
		}
	}

	/** Disconnect from the store. */
	async disconnect(): Promise<void> {
		// Called by Quereus after each scan completes.
		// Do NOT clear the store - it's shared across concurrent queries.
		// Only flush pending stats if there are mutations.
		if (this.mutationCount > 0 && this.store) {
			await this.flushStats();
		}
		// Store remains available for subsequent queries.
		// Use destroy() to fully clean up the table.
	}

	/**
	 * Hard teardown: fully detach this instance from the module-wide coordinator.
	 *
	 * Distinct from the per-scan {@link disconnect} (which only flushes stats and
	 * deliberately keeps the table hooked mid-life). Called ONLY at the genuine
	 * eviction sites — `StoreModule.tearDownTableStorage` (drop / reclaim) and
	 * `renameTable` — where this instance is removed from the module's `tables` map
	 * and will never be used again. It best-effort flushes any buffered stats (the
	 * backing store is about to be deleted / relocated, so this is the last chance,
	 * same posture as the teardown-time `disconnect` it replaces), then runs the
	 * coordinator disposer so this instance's {stats apply/discard} callback pair —
	 * and the `this` its closures capture — is spliced off the shared coordinator's
	 * array rather than pinned for the module's lifetime.
	 *
	 * Idempotent: the disposer is run at most once and both it and the coordinator
	 * reference are nulled, so a double-dispose is a no-op and a re-`attachCoordinator`
	 * after dispose registers a fresh pair instead of double-registering.
	 */
	async dispose(): Promise<void> {
		if (this.mutationCount > 0 && this.store) {
			await this.flushStats();
		}
		this.coordinatorDisposer?.();
		this.coordinatorDisposer = null;
		this.coordinator = null;
	}

	/** Get the current estimated row count. */
	async getEstimatedRowCount(): Promise<number> {
		if (this.cachedStats) {
			return this.cachedStats.rowCount;
		}

		const statsStore = await this.ensureStatsStore();
		const statsKey = buildStatsKey(this.schemaName, this.tableName);
		const statsData = await statsStore.get(statsKey);

		if (statsData) {
			this.cachedStats = deserializeStats(statsData);
			return this.cachedStats.rowCount;
		}

		// No stats yet, return 0
		return 0;
	}

	/** Track a mutation and schedule lazy stats persistence. */
	protected trackMutation(delta: number, inTransaction = false): void {
		if (inTransaction) {
			// Buffer during transaction - stats will be applied at commit
			this.pendingStatsDelta += delta;
			return;
		}

		if (!this.cachedStats) {
			this.cachedStats = { rowCount: 0, updatedAt: Date.now() };
		}

		this.cachedStats.rowCount = Math.max(0, this.cachedStats.rowCount + delta);
		this.cachedStats.updatedAt = Date.now();
		this.mutationCount++;

		// Schedule lazy flush after threshold
		if (this.mutationCount >= STATS_FLUSH_INTERVAL && !this.statsFlushPending) {
			this.statsFlushPending = true;
			queueMicrotask(() => this.flushStats());
		}
	}
}

/** PK access pattern analysis result. */
interface PKAccessPattern {
	type: 'point' | 'range' | 'scan';
	values?: SqlValue[];
	columnIndex?: number;
	constraints?: Array<{ columnIndex: number; op: IndexConstraintOp; value?: SqlValue }>;
}

/**
 * Secondary-index access pattern analysis result: the chosen index plus the
 * encoded byte window {@link StoreTable.scanIndex} iterates. `point` is a
 * leading-prefix EQ window, `range` a leading-column LT/LE/GT/GE window; both
 * resolve to a `bounds` scan (an index seek is always a prefix scan, never a
 * single entry).
 */
interface IndexAccessPattern {
	index: TableIndexSchema;
	type: 'point' | 'range';
	bounds: IterateOptions;
}
