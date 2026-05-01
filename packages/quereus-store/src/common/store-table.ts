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
	type Database,
	type DatabaseInternal,
	type TableSchema,
	type Row,
	type FilterInfo,
	type SqlValue,
	type VirtualTableConnection,
	type UpdateArgs,
	type VirtualTableModule,
	type UpdateResult,
} from '@quereus/quereus';

import type { KVStore } from './kv-store.js';
import type { StoreEventEmitter } from './events.js';
import type { TransactionCoordinator } from './transaction.js';
import { StoreConnection } from './store-connection.js';
import {
	buildDataKey,
	buildIndexKey,
	buildFullScanBounds,
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

/** Hex-encode a key for use as a Map/Set lookup. */
function bytesToHex(key: Uint8Array): string {
	return Array.from(key).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Byte-wise equality check for Uint8Arrays. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
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
	/** Get a coordinator for a table. */
	getCoordinator(tableKey: string, config: StoreTableConfig): Promise<TransactionCoordinator>;
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
	protected ddlSaved = false;

	// Statistics tracking
	protected cachedStats: TableStats | null = null;
	protected pendingStatsDelta = 0;
	protected mutationCount = 0;
	protected statsFlushPending = false;

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
	 */
	async rekeyRows(
		newPkDef: ReadonlyArray<{ index: number; desc: boolean }>,
	): Promise<void> {
		const store = await this.ensureStore();
		const bounds = buildFullScanBounds();

		interface Pending { newKey: Uint8Array; oldKey: Uint8Array; row: Row; }
		const pending = new Map<string, Pending>();

		const newPkDirections = newPkDef.map(pk => !!pk.desc);
		for await (const entry of store.iterate(bounds)) {
			const row = deserializeRow(entry.value);
			const newPkValues = newPkDef.map(pk => row[pk.index]);
			const newKey = buildDataKey(newPkValues, this.encodeOptions, newPkDirections);
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
	 */
	async migrateRows(remap: number[], defaultValue: SqlValue): Promise<void> {
		const store = await this.ensureStore();
		const bounds = buildFullScanBounds();
		const batch = store.batch();

		for await (const entry of store.iterate(bounds)) {
			const oldRow = deserializeRow(entry.value);
			const newRow: Row = new Array(remap.length);
			for (let i = 0; i < remap.length; i++) {
				newRow[i] = remap[i] === -1 ? defaultValue : oldRow[remap[i]];
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
	 * Ensure the coordinator is available and connection is registered.
	 */
	protected async ensureCoordinator(): Promise<TransactionCoordinator> {
		if (!this.coordinator) {
			const tableKey = `${this.schemaName}.${this.tableName}`.toLowerCase();
			this.coordinator = await this.storeModule.getCoordinator(tableKey, this.config);

			this.coordinator.registerCallbacks({
				onCommit: () => this.applyPendingStats(),
				onRollback: () => this.discardPendingStats(),
			});
		}

		if (!this.connection) {
			this.connection = new StoreConnection(this.tableName, this.coordinator);
			await (this.db as DatabaseInternal).registerConnection(this.connection);
		}

		return this.coordinator;
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

	/** Query the table with optional filters. */
	async *query(filterInfo: FilterInfo): AsyncIterable<Row> {
		const store = await this.ensureStore();

		const pkAccess = this.analyzePKAccess(filterInfo);

		if (pkAccess.type === 'point') {
			const key = buildDataKey(pkAccess.values!, this.encodeOptions, this.pkDirections);
			const value = await store.get(key);
			if (value) {
				const row = deserializeRow(value);
				if (this.matchesFilters(row, filterInfo)) {
					yield row;
				}
			}
			return;
		}

		if (pkAccess.type === 'range') {
			yield* this.scanPKRange(store, pkAccess, filterInfo);
			return;
		}

		// Full table scan
		const bounds = buildFullScanBounds();
		for await (const entry of store.iterate(bounds)) {
			const row = deserializeRow(entry.value);
			if (this.matchesFilters(row, filterInfo)) {
				yield row;
			}
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

		// TODO: Refine bounds based on range constraints
		for await (const entry of store.iterate(bounds)) {
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

			if (!this.compareValues(rowValue, constraint.op, filterValue)) {
				return false;
			}
		}

		return true;
	}

	/** Compare two values according to an operator. */
	protected compareValues(a: SqlValue, op: IndexConstraintOp, b: SqlValue): boolean {
		if (a === null || b === null) {
			return op === IndexConstraintOp.EQ ? a === b : false;
		}

		switch (op) {
			case IndexConstraintOp.EQ:
				return a === b || (typeof a === 'string' && typeof b === 'string' &&
					this.config.collation === 'NOCASE' && a.toLowerCase() === b.toLowerCase());
			case IndexConstraintOp.NE: return a !== b;
			case IndexConstraintOp.LT: return a < b;
			case IndexConstraintOp.LE: return a <= b;
			case IndexConstraintOp.GT: return a > b;
			case IndexConstraintOp.GE: return a >= b;
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
				const key = buildDataKey(pk, this.encodeOptions, this.pkDirections);

				// Check for existing row (for conflict handling)
				const existing = await store.get(key);
				if (existing) {
					if (args.onConflict === ConflictResolution.IGNORE) {
						return { status: 'ok', row: undefined };
					}
					if (args.onConflict !== ConflictResolution.REPLACE) {
						const existingRow = deserializeRow(existing);
						return {
							status: 'constraint',
							constraint: 'unique',
							message: 'UNIQUE constraint failed: primary key',
							existingRow,
						};
					}
				}

				// Enforce non-PK UNIQUE constraints
				const ucResult = await this.checkUniqueConstraints(
					inTransaction,
					coerced,
					[pk],
					args.onConflict,
				);
				if (ucResult) return ucResult;

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

				return { status: 'ok', row: coerced, replacedRow: oldRow ?? undefined };
			}

			case 'update': {
				if (!values || !oldKeyValues) throw new QuereusError('UPDATE requires values and oldKeyValues', StatusCode.MISUSE);
				const coerced = args.preCoerced ? values : this.coerceRow(values);
				const oldPk = this.extractPK(oldKeyValues);
				const newPk = this.extractPK(coerced);
				const oldKey = buildDataKey(oldPk, this.encodeOptions, this.pkDirections);
				const newKey = buildDataKey(newPk, this.encodeOptions, this.pkDirections);

				// Get old row for index updates
				const oldRowData = await store.get(oldKey);
				const oldRow = oldRowData ? deserializeRow(oldRowData) : null;

				const pkChanged = !this.keysEqual(oldPk, newPk);

				// PK-change UPDATE collides like an INSERT at the new key
				if (pkChanged) {
					const existingAtNew = await store.get(newKey);
					if (existingAtNew) {
						if (args.onConflict === ConflictResolution.IGNORE) {
							return { status: 'ok', row: undefined };
						}
						if (args.onConflict !== ConflictResolution.REPLACE) {
							return {
								status: 'constraint',
								constraint: 'unique',
								message: 'UNIQUE constraint failed: primary key',
								existingRow: deserializeRow(existingAtNew),
							};
						}
					}
				}

				// Enforce non-PK UNIQUE constraints. For same-PK UPDATE, only check
				// constraints whose covered columns actually changed; pass [oldPk]
				// (= newPk) to skip self. For PK-change UPDATE, treat as relocation:
				// skip both old and new PK so we don't false-conflict against the
				// row we're moving.
				const selfPks: SqlValue[][] = pkChanged ? [oldPk, newPk] : [oldPk];
				const shouldCheckUniques = pkChanged
					|| (oldRow ? this.uniqueColumnsChanged(oldRow, coerced) : true);
				if (shouldCheckUniques) {
					const ucResult = await this.checkUniqueConstraints(
						inTransaction,
						coerced,
						selfPks,
						args.onConflict,
					);
					if (ucResult) return ucResult;
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

				// Update secondary indexes
				await this.updateSecondaryIndexes(inTransaction, oldRow, coerced, newPk);

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

				return { status: 'ok', row: coerced };
			}

			case 'delete': {
				if (!oldKeyValues) throw new QuereusError('DELETE requires oldKeyValues', StatusCode.MISUSE);
				const pk = this.extractPK(oldKeyValues);
				const key = buildDataKey(pk, this.encodeOptions, this.pkDirections);

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

	/** Update secondary indexes after a row change. */
	protected async updateSecondaryIndexes(
		inTransaction: boolean,
		oldRow: Row | null,
		newRow: Row | null,
		pk: SqlValue[]
	): Promise<void> {
		const schema = this.tableSchema!;
		const indexes = schema.indexes || [];

		for (const index of indexes) {
			const indexStore = await this.ensureIndexStore(index.name);
			const indexCols = index.columns.map(c => c.index);
			const indexDirections = index.columns.map(c => !!c.desc);

			// Remove old index entry
			if (oldRow) {
				const oldIndexValues = indexCols.map(i => oldRow[i]);
				const oldIndexKey = buildIndexKey(
					oldIndexValues,
					pk,
					this.encodeOptions,
					indexDirections,
					this.pkDirections,
				);

				if (inTransaction && this.coordinator) {
					this.coordinator.delete(oldIndexKey, indexStore);
				} else {
					await indexStore.delete(oldIndexKey);
				}
			}

			// Add new index entry
			if (newRow) {
				const newIndexValues = indexCols.map(i => newRow[i]);
				const newIndexKey = buildIndexKey(
					newIndexValues,
					pk,
					this.encodeOptions,
					indexDirections,
					this.pkDirections,
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

	/** Check if two PK arrays are equal. */
	protected keysEqual(a: SqlValue[], b: SqlValue[]): boolean {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (a[i] !== b[i]) return false;
		}
		return true;
	}

	/** Returns true if any column covered by a UNIQUE constraint differs between oldRow and newRow. */
	protected uniqueColumnsChanged(oldRow: Row, newRow: Row): boolean {
		const ucs = this.tableSchema?.uniqueConstraints;
		if (!ucs || ucs.length === 0) return false;
		for (const uc of ucs) {
			for (const colIdx of uc.columns) {
				if (compareSqlValues(oldRow[colIdx], newRow[colIdx]) !== 0) return true;
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
	 */
	protected async checkUniqueConstraints(
		inTransaction: boolean,
		newRow: Row,
		selfPks: SqlValue[][],
		onConflict?: ConflictResolution,
	): Promise<UpdateResult | null> {
		const schema = this.tableSchema!;
		const uniqueConstraints = schema.uniqueConstraints;
		if (!uniqueConstraints || uniqueConstraints.length === 0) return null;

		for (const uc of uniqueConstraints) {
			if (uc.columns.some(idx => newRow[idx] === null)) continue;

			const conflict = await this.findUniqueConflict(uc.columns, newRow, selfPks);
			if (!conflict) continue;

			if (onConflict === ConflictResolution.IGNORE) {
				return { status: 'ok', row: undefined };
			}
			if (onConflict === ConflictResolution.REPLACE) {
				await this.deleteRowAt(inTransaction, conflict.pk, conflict.row);
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
	 * `constrainedCols` whose PK is not in `selfPks`. Returns the first match
	 * or null.
	 */
	private async findUniqueConflict(
		constrainedCols: ReadonlyArray<number>,
		newRow: Row,
		selfPks: SqlValue[][],
	): Promise<{ pk: SqlValue[]; row: Row } | null> {
		const store = await this.ensureStore();
		const pending = this.coordinator?.isInTransaction()
			? this.coordinator.getPendingOpsForStore(store)
			: null;

		const matches = (candidate: Row): { pk: SqlValue[]; row: Row } | null => {
			const pk = this.extractPK(candidate);
			for (const skip of selfPks) {
				if (this.keysEqual(pk, skip)) return null;
			}
			for (const idx of constrainedCols) {
				if (compareSqlValues(newRow[idx], candidate[idx]) !== 0) return null;
			}
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
		const key = buildDataKey(pk, this.encodeOptions, this.pkDirections);
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
