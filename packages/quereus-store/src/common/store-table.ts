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
	validateAndParse,
	compilePredicate,
	type Database,
	type DatabaseInternal,
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
} from '@quereus/quereus';

import type { IterateOptions, KVEntry, KVStore } from './kv-store.js';
import { bytesEqual, bytesToHex, compareBytes } from './bytes.js';
import type { StoreEventEmitter } from './events.js';
import type { TransactionCoordinator } from './transaction.js';
import { StoreConnection } from './store-connection.js';
import {
	buildDataKey,
	buildIndexKey,
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
import type { EncodeOptions } from './encoding.js';

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
 * collation (BINARY / NOCASE / RTRIM — the registered encoders). Returns one
 * entry per PK member, in `pkDef` order:
 *   - text member → its declared `collation` (normalized upper-case), or
 *     `fallback` (the table key collation K) when the column carries none.
 *   - non-text member → `undefined`: collation is meaningless for
 *     integer/real/blob keys (they encode type-natively), so the encoder ignores
 *     it and the data/index key bytes are identical regardless.
 *
 * A custom comparator-only collation with no registered byte encoder still maps
 * to NOCASE bytes inside `encodeText` (its `?? NOCASE_ENCODER` fallback); that
 * residual is the same one documented for store UNIQUE enforcement and is out of
 * scope here. Shared by {@link StoreTable} (data-key + index-maintenance) and
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
		if (!col || !col.logicalType.isTextual) return undefined;
		return (col.collation || fallback).toUpperCase();
	});
}

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
	getStore(tableKey: string, config: StoreTableConfig): Promise<KVStore>;
	/** Get an index store for a table. */
	getIndexStore(schemaName: string, tableName: string, indexName: string): Promise<KVStore>;
	/** Get the stats store for a table. */
	getStatsStore(schemaName: string, tableName: string): Promise<KVStore>;
	/**
	 * Get a coordinator for a table. Synchronous: the coordinator's default
	 * store may be a lazy thunk resolved at commit time, so obtaining one never
	 * requires opening storage.
	 */
	getCoordinator(tableKey: string, config: StoreTableConfig): TransactionCoordinator;
	/** Save table DDL to persistent storage. */
	saveTableDDL(tableSchema: TableSchema): Promise<void>;
}

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
		this.encodeOptions = { collation: config.collation || 'NOCASE' };
		this.pkDirections = tableSchema.primaryKeyDefinition.map(pk => !!pk.desc);
		this.pkKeyCollations = resolvePkKeyCollations(
			tableSchema.primaryKeyDefinition,
			tableSchema.columns,
			this.encodeOptions.collation ?? 'NOCASE',
		);
		this.ddlSaved = isConnected;
	}

	/** Get the table configuration. */
	getConfig(): StoreTableConfig {
		return this.config;
	}

	/** Get the table schema. */
	getSchema(): TableSchema {
		return this.tableSchema!;
	}

	/** Update the table schema after an ALTER TABLE operation. */
	updateSchema(newSchema: TableSchema): void {
		this.tableSchema = newSchema;
		this.pkDirections = newSchema.primaryKeyDefinition.map(pk => !!pk.desc);
		this.pkKeyCollations = resolvePkKeyCollations(
			newSchema.primaryKeyDefinition,
			newSchema.columns,
			this.encodeOptions.collation ?? 'NOCASE',
		);
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
			this.store = await this.storeModule.getStore(tableKey, this.config);

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
	 * Resolve + cache this table's TransactionCoordinator and hook the stats
	 * lifecycle callbacks, WITHOUT creating or registering a connection.
	 * Synchronous (the coordinator is thunk-constructed — see
	 * `StoreTableModule.getCoordinator`), so the backing host's resolution path can
	 * call it eagerly. Attaching matters for reads: `iterateEffective` /
	 * `readEffectiveRowByKey` consult `this.coordinator` for the pending merge, so a
	 * table whose only writer is the privileged backing host (which queues ops on the
	 * module-level coordinator, never through `update()`) must still hold the
	 * reference for its read paths to be reads-own-writes.
	 */
	attachCoordinator(): TransactionCoordinator {
		if (!this.coordinator) {
			const tableKey = `${this.schemaName}.${this.tableName}`.toLowerCase();
			this.coordinator = this.storeModule.getCoordinator(tableKey, this.config);

			this.coordinator.registerCallbacks({
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
			this.connection = new StoreConnection(this.tableName, coordinator);
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
			if (row && this.matchesFilters(row, filterInfo)) {
				yield row;
			}
			return;
		}

		if (pkAccess.type === 'range') {
			yield* this.scanPKRange(store, pkAccess, filterInfo);
			return;
		}

		// Full table scan
		const bounds = buildFullScanBounds();
		for await (const entry of this.iterateEffective(store, bounds)) {
			const row = deserializeRow(entry.value);
			if (this.matchesFilters(row, filterInfo)) {
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
	 * The pending side is the coordinator's DEFAULT-store bucket — the
	 * coordinator is per-table and its default store IS this table's data store
	 * (both resolve through `StoreModule.getStore(tableKey)`), and addressing by
	 * role keeps the lookup correct while a lazily-constructed coordinator's
	 * default handle is still unresolved.
	 */
	protected async *iterateEffective(
		store: KVStore,
		bounds: IterateOptions,
		reverse = false,
	): AsyncIterable<KVEntry> {
		const pending = this.coordinator?.isInTransaction()
			? this.coordinator.getOrderedPendingOps()
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

	/** Scan a range of PK values. */
	protected async *scanPKRange(
		store: KVStore,
		_access: PKAccessPattern,
		filterInfo: FilterInfo
	): AsyncIterable<Row> {
		const bounds = buildFullScanBounds();

		// TODO: Refine bounds based on range constraints. When implemented, the
		// bound keys must be encoded under the same per-PK-column collations the
		// data keys use (pkKeyCollations) so the iterated window is a superset of
		// the collation-aware filter below — matchesFilters stays the authoritative
		// row filter either way. Today the full key space is visited, so there is
		// no seek-start/early-termination carrying a BINARY assumption.
		for await (const entry of this.iterateEffective(store, bounds)) {
			const row = deserializeRow(entry.value);
			if (this.matchesFilters(row, filterInfo)) {
				yield row;
			}
		}
	}

	/** Check if a row matches the filter constraints. */
	protected matchesFilters(row: Row, filterInfo: FilterInfo): boolean {
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
			// Compare under the column's DECLARED collation (undefined ⇒ BINARY) — the
			// same resolution the access path's collation-cover analysis uses
			// (indexColumnCollationLookup / primaryKeyCollationLookup) when it decides
			// a pushed constraint is fully covered, and the same source this file's
			// UNIQUE checks compare under. On a collation MATCH the planner drops the
			// residual Filter, so this filter alone must reproduce the predicate.
			const collation = this.tableSchema!.columns[constraint.iColumn]?.collation;

			if (!this.compareValues(rowValue, constraint.op, filterValue, collation)) {
				return false;
			}
		}

		return true;
	}

	/**
	 * Compare two values according to an operator, under `collation` (the column's
	 * declared collation; undefined ⇒ BINARY). Delegates to the engine's
	 * `compareSqlValues`, so the LT/LE/GT/GE range bounds honour a NOCASE/RTRIM
	 * column collation rather than a raw BINARY JS comparison — the capability
	 * `StoreModule.getBestAccessPlan` advertises via `honorsCollatedRangeBounds`.
	 * NULL on either side fails every operator except EQ-with-both-NULL (the
	 * internal point-lookup convention; the planner never pushes `= NULL`).
	 */
	protected compareValues(a: SqlValue, op: IndexConstraintOp, b: SqlValue, collation?: string): boolean {
		if (a === null || b === null) {
			return op === IndexConstraintOp.EQ ? a === b : false;
		}

		const cmp = compareSqlValues(a, b, collation);
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
				const existing = await store.get(key);
				if (args.trustedWrite) {
					// Trusted flush insert: the overlay flush routes existing PKs to
					// update (via rowExistsInUnderlying), so a row already present here
					// is an isolation-layer invariant violation. Fail loudly rather than
					// silently overwrite — the flush try/catch rolls back and rethrows
					// (isolation-merged-unique-stale-underlying-false-positive).
					if (existing) {
						throw new QuereusError(
							`Trusted flush insert on '${this.tableName}' hit an existing PK; the overlay flush should route existing PKs to update. This indicates an isolation-layer invariant violation.`,
							StatusCode.INTERNAL,
						);
					}
				} else if (existing) {
					if (pkEffective === ConflictResolution.IGNORE) {
						return { status: 'ok', row: undefined };
					}
					if (pkEffective !== ConflictResolution.REPLACE) {
						const existingRow = deserializeRow(existing);
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

				const oldRow = existing ? deserializeRow(existing) : null;
				const serializedRow = serializeRow(coerced);
				if (inTransaction) {
					coordinator.put(key, serializedRow);
				} else {
					await store.put(key, serializedRow);
				}

				// Update secondary indexes
				await this.updateSecondaryIndexes(inTransaction, oldRow, coerced, pk);

				// Track statistics (only count as new if not replacing)
				if (!existing) {
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

				// Get old row for index updates
				const oldRowData = await store.get(oldKey);
				const oldRow = oldRowData ? deserializeRow(oldRowData) : null;

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
				// row at the new PK). Read through the coordinator so an evictee
				// written earlier in the same transaction is visible.
				// Skipped for trusted flush writes — the overlay flush never changes a
				// row's PK (oldKeyValues and the row's PK columns are the same overlay
				// entry), so pkChanged is false there; the guard makes the intent explicit.
				let replacedAtNewPk: Row | null = null;
				if (pkChanged && !args.trustedWrite) {
					const existingAtNew = await store.get(newKey);
					if (existingAtNew) {
						if (pkEffective === ConflictResolution.IGNORE) {
							return { status: 'ok', row: undefined };
						}
						if (pkEffective !== ConflictResolution.REPLACE) {
							return {
								status: 'constraint',
								constraint: 'unique',
								message: `UNIQUE constraint failed: ${this.tableName} PK.`,
								existingRow: deserializeRow(existingAtNew),
							};
						}
						replacedAtNewPk = deserializeRow(existingAtNew);
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
						coordinator.delete(oldKey);
					} else {
						await store.delete(oldKey);
					}
				}

				const serializedRow = serializeRow(coerced);
				if (inTransaction) {
					coordinator.put(newKey, serializedRow);
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

				// Get old row for index cleanup
				const oldRowData = await store.get(key);
				const oldRow = oldRowData ? deserializeRow(oldRowData) : null;

				if (inTransaction) {
					coordinator.delete(key);
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
				// Index value is empty - we just need the key for lookups
				const emptyValue = new Uint8Array(0);

				if (inTransaction && this.coordinator) {
					this.coordinator.put(newIndexKey, emptyValue, indexStore);
				} else {
					await indexStore.put(newIndexKey, emptyValue);
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

			// Prefer a linked row-time covering MV: its backing table (hosted by any
			// backing-host-capable module — memory by default, this store module under
			// `using store` — queried through the db with reads-own-writes) answers
			// the uniqueness question, mirroring the memory enforcement path. Falls
			// back to the per-scan source search when no row-time covering MV exists.
			const coveringMv = (this.db as DatabaseInternal)._findRowTimeCoveringStructure(schema.schemaName, schema.name, uc);
			const conflict = coveringMv
				? await this.findUniqueConflictViaCoveringMv(coveringMv, uc, predicate, newRow, selfPks)
				: await this.findUniqueConflict(uc, predicate, newRow, selfPks);
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
	): Promise<{ pk: SqlValue[]; row: Row } | null> {
		const store = await this.ensureStore();
		// Default-store bucket: the per-table coordinator's default store IS this
		// table's data store, and addressing by role (no handle) stays correct
		// even while a lazily-constructed coordinator's default is unresolved.
		const pending = this.coordinator?.isInTransaction()
			? this.coordinator.getPendingOpsForStore()
			: null;
		const constrainedCols = uc.columns;
		const schema = this.tableSchema!;

		const matches = (candidate: Row): { pk: SqlValue[]; row: Row } | null => {
			const pk = this.extractPK(candidate);
			for (const skip of selfPks) {
				if (this.keysEqual(pk, skip)) return null;
			}
			for (const idx of constrainedCols) {
				// Compare under the column's declared collation (e.g. NOCASE), not BINARY.
				if (compareSqlValues(newRow[idx], candidate[idx], schema.columns[idx].collation) !== 0) return null;
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
	): Promise<{ pk: SqlValue[]; row: Row } | null> {
		const newSourcePk = this.extractPK(newRow);
		const candidates = await (this.db as DatabaseInternal)._lookupCoveringConflicts(mv, uc, newRow, newSourcePk);
		for (const cand of candidates) {
			const liveRow = await this.readLiveRowByPk(cand.pk);
			if (!liveRow) continue; // stale backing candidate (source row gone)
			if (selfPks.some(pk => this.keysEqual(pk, cand.pk))) continue;
			// Re-validate under each column's declared collation (e.g. NOCASE), not BINARY.
			if (uc.columns.some(c => compareSqlValues(newRow[c], liveRow[c], this.tableSchema!.columns[c].collation) !== 0)) continue;
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
		// Default-store bucket — see the matching note in findUniqueConflict.
		const pending = this.coordinator?.isInTransaction()
			? this.coordinator.getPendingOpsForStore()
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
			this.coordinator.delete(key);
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
