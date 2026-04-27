/**
 * Generic Store Module for Quereus.
 *
 * A platform-agnostic VirtualTableModule that uses a KVStoreProvider
 * to create StoreTable instances. This enables any storage backend
 * (LevelDB, IndexedDB, React Native, etc.) to be used with the same
 * table implementation.
 *
 * Storage architecture:
 *   - Data store: {schema}.{table} - row data keyed by encoded PK
 *   - Index stores: {schema}.{table}_idx_{name} - one per secondary index
 *   - {prefix}.__stats__ - Unified stats store (row counts for all tables)
 *   - Catalog store: __catalog__ - DDL metadata keyed by {schema}.{table}
 */

import type {
	Database,
	TableSchema,
	TableIndexSchema,
	VirtualTableModule,
	BaseModuleConfig,
	BestAccessPlanRequest,
	BestAccessPlanResult,
	SqlValue,
	ModuleCapabilities,
	SchemaChangeInfo,
	ColumnSchema,
} from '@quereus/quereus';
import { AccessPlanBuilder, QuereusError, StatusCode, buildColumnIndexMap, columnDefToSchema, inferType, validateAndParse } from '@quereus/quereus';

import type { KVStore, KVStoreProvider } from './kv-store.js';
import type { StoreEventEmitter } from './events.js';
import { TransactionCoordinator } from './transaction.js';
import { StoreTable, type StoreTableConfig, type StoreTableModule } from './store-table.js';
import {
	buildCatalogKey,
	buildCatalogScanBounds,
	buildIndexKey,
	buildFullScanBounds,
	buildStatsKey,
} from './key-builder.js';
import { deserializeRow } from './serialization.js';
import { generateTableDDL } from '@quereus/quereus';

/**
 * Result of catalog rehydration.
 */
export interface RehydrationResult {
	tables: string[];
	indexes: string[];
	errors: RehydrationError[];
}

/**
 * An error encountered while rehydrating a single DDL entry.
 */
export interface RehydrationError {
	ddl: string;
	error: Error;
}

/**
 * Configuration options for StoreModule tables.
 */
export interface StoreModuleConfig extends BaseModuleConfig {
	/** Collation for text keys. Default: 'NOCASE'. */
	collation?: 'BINARY' | 'NOCASE';
	/** Additional platform-specific options. */
	[key: string]: unknown;
}

/**
 * Generic store module that works with any KVStoreProvider.
 *
 * Usage:
 * ```typescript
 * import { StoreModule } from '@quereus/store';
 * import { createLevelDBProvider } from '@quereus/store-leveldb';
 *
 * const provider = createLevelDBProvider({ basePath: './data' });
 * const module = new StoreModule(provider);
 * db.registerModule('store', module);
 * ```
 */
export class StoreModule implements VirtualTableModule<StoreTable, StoreModuleConfig>, StoreTableModule {
	private provider: KVStoreProvider;
	private stores: Map<string, KVStore> = new Map();
	private coordinators: Map<string, TransactionCoordinator> = new Map();
	private tables: Map<string, StoreTable> = new Map();
	private eventEmitter?: StoreEventEmitter;

	constructor(provider: KVStoreProvider, eventEmitter?: StoreEventEmitter) {
		this.provider = provider;
		this.eventEmitter = eventEmitter;
	}

	/**
	 * Returns capability flags for this module.
	 *
	 * The base StoreModule does NOT provide transaction isolation.
	 * Without isolation, queries see only committed data (no read-your-own-writes
	 * within a transaction). To enable isolation, wrap with IsolationModule:
	 *
	 * ```typescript
	 * import { IsolationModule, MemoryTableModule } from '@quereus/quereus';
	 * import { StoreModule } from '@quereus/store';
	 *
	 * const storeModule = new StoreModule(provider);
	 * const isolatedModule = new IsolationModule({
	 *   underlying: storeModule,
	 *   overlay: new MemoryTableModule(),
	 * });
	 * db.registerModule('store', isolatedModule);
	 * ```
	 */
	getCapabilities(): ModuleCapabilities {
		return {
			isolation: false,
			savepoints: false,
			persistent: true,
			secondaryIndexes: true,
			rangeScans: true,
		};
	}

	/**
	 * Get the event emitter for this module.
	 */
	getEventEmitter(): StoreEventEmitter | undefined {
		return this.eventEmitter;
	}

	/**
	 * Get the KVStoreProvider used by this module.
	 */
	getProvider(): KVStoreProvider {
		return this.provider;
	}

	/**
	 * Creates a new store-backed table.
	 * Called by CREATE TABLE.
	 *
	 * This method eagerly initializes the underlying storage (e.g., IndexedDB object store)
	 * before emitting schema change events. This ensures the storage is ready before any
	 * event handlers (like sync module) try to access it.
	 */
	async create(db: Database, tableSchema: TableSchema): Promise<StoreTable> {
		const tableKey = `${tableSchema.schemaName}.${tableSchema.name}`.toLowerCase();

		if (this.tables.has(tableKey)) {
			throw new QuereusError(
				`Store table '${tableSchema.name}' already exists in schema '${tableSchema.schemaName}'`,
				StatusCode.ERROR
			);
		}

		const config = this.parseConfig(tableSchema.vtabArgs as Record<string, SqlValue> | undefined);

		// Eagerly initialize the store BEFORE creating the table or emitting events.
		// This ensures the underlying storage (e.g., IndexedDB object store) exists
		// before any schema change handlers try to access it.
		const store = await this.provider.getStore(tableSchema.schemaName, tableSchema.name);
		this.stores.set(tableKey, store);

		const table = new StoreTable(
			db,
			this,
			tableSchema,
			config,
			this.eventEmitter
			// isConnected defaults to false for newly created tables
		);

		this.tables.set(tableKey, table);

		// Emit schema change event AFTER storage is initialized
		this.eventEmitter?.emitSchemaChange({
			type: 'create',
			objectType: 'table',
			schemaName: tableSchema.schemaName,
			objectName: tableSchema.name,
			ddl: generateTableDDL(tableSchema),
		});

		return table;
	}

	/**
	 * Connects to an existing store-backed table.
	 * Called when loading schema from persistent storage.
	 */
	async connect(
		db: Database,
		_pAux: unknown,
		_moduleName: string,
		schemaName: string,
		tableName: string,
		options: StoreModuleConfig,
		importedTableSchema?: TableSchema
	): Promise<StoreTable> {
		const tableKey = `${schemaName}.${tableName}`.toLowerCase();

		// Check if we already have this table connected
		const existing = this.tables.get(tableKey);
		if (existing) {
			return existing;
		}

		// Convert options to Record<string, SqlValue> for vtabArgs
		const vtabArgs: Record<string, SqlValue> = {};
		if (options?.collation !== undefined) vtabArgs.collation = options.collation;

		// Resolve the table schema:
		// 1. Use importedTableSchema if provided (from catalog import or runtime)
		// 2. Look up from schemaManager (most common case during runtime queries)
		// 3. Fall back to minimal schema (only for cases where table doesn't exist yet)
		let tableSchema: TableSchema;
		if (importedTableSchema) {
			tableSchema = importedTableSchema;
		} else {
			// Try to look up the schema from schemaManager - this is the common runtime case
			const registeredSchema = db.schemaManager.getTable(schemaName, tableName);
			if (registeredSchema) {
				tableSchema = registeredSchema;
			} else {
				// Fallback to minimal schema - should only happen during catalog import
				// when the schema hasn't been registered yet
				tableSchema = {
					name: tableName,
					schemaName: schemaName,
					columns: Object.freeze([]),
					columnIndexMap: new Map(),
					primaryKeyDefinition: [],
					checkConstraints: Object.freeze([]),
					isTemporary: false,
					isView: false,
					vtabModuleName: 'store',
					vtabArgs,
					vtabModule: this,
					estimatedRows: 0,
				};
			}
		}

		const config = this.parseConfig(vtabArgs);

		const table = new StoreTable(
			db,
			this,
			tableSchema,
			config,
			this.eventEmitter,
			true // isConnected - DDL already exists in storage
		);

		this.tables.set(tableKey, table);
		return table;
	}

	/**
	 * Destroys a store table and its storage.
	 */
	async destroy(
		_db: Database,
		_pAux: unknown,
		_moduleName: string,
		schemaName: string,
		tableName: string
	): Promise<void> {
		const tableKey = `${schemaName}.${tableName}`.toLowerCase();

		// Clear internal maps synchronously before any await, so a concurrent
		// create() cannot observe the stale table/store/coordinator across a
		// microtask boundary mid-destroy.
		const table = this.tables.get(tableKey);
		this.tables.delete(tableKey);
		this.stores.delete(tableKey);
		this.coordinators.delete(tableKey);

		if (table) {
			await table.disconnect();
		}

		// Delete all stores for this table (data, indexes, stats)
		if (this.provider.deleteTableStores) {
			await this.provider.deleteTableStores(schemaName, tableName);
		} else {
			// Fallback: just close the data store
			await this.provider.closeStore(schemaName, tableName);
		}

		// Remove DDL from catalog
		await this.removeTableDDL(schemaName, tableName);

		// Emit schema change event for table drop
		this.eventEmitter?.emitSchemaChange({
			type: 'drop',
			objectType: 'table',
			schemaName,
			objectName: tableName,
		});
	}

	/**
	 * Creates an index on a store-backed table.
	 */
	async createIndex(
		_db: Database,
		schemaName: string,
		tableName: string,
		indexSchema: TableIndexSchema
	): Promise<void> {
		const tableKey = `${schemaName}.${tableName}`.toLowerCase();
		const table = this.tables.get(tableKey);

		if (!table) {
			throw new QuereusError(
				`Store table '${tableName}' not found in schema '${schemaName}'`,
				StatusCode.NOTFOUND
			);
		}

		// Create the index store
		const indexStore = await this.provider.getIndexStore(schemaName, tableName, indexSchema.name);

		// Build index entries for existing rows
		const dataStore = await this.getStore(tableKey, table.getConfig());
		const tableSchema = table.getSchema();
		await this.buildIndexEntries(dataStore, indexStore, tableSchema, indexSchema);

		// Emit schema change event
		this.eventEmitter?.emitSchemaChange({
			type: 'create',
			objectType: 'index',
			schemaName,
			objectName: indexSchema.name,
		});
	}

	/**
	 * Build index entries for all existing rows in a table.
	 */
	private async buildIndexEntries(
		dataStore: KVStore,
		indexStore: KVStore,
		tableSchema: TableSchema,
		indexSchema: TableIndexSchema
	): Promise<void> {
		const encodeOptions = { collation: 'NOCASE' as const };
		const pkDirections = tableSchema.primaryKeyDefinition.map(pk => !!pk.desc);
		const indexDirections = indexSchema.columns.map(col => !!col.desc);

		// Scan all data rows
		const bounds = buildFullScanBounds();
		const batch = indexStore.batch();

		for await (const entry of dataStore.iterate(bounds)) {
			const row = deserializeRow(entry.value);

			// Extract PK values
			const pkValues = tableSchema.primaryKeyDefinition.map(pk => row[pk.index]);

			// Extract index column values
			const indexValues = indexSchema.columns.map(col => row[col.index]);

			// Build and store index key
			const indexKey = buildIndexKey(
				indexValues,
				pkValues,
				encodeOptions,
				indexDirections,
				pkDirections,
			);
			batch.put(indexKey, new Uint8Array(0)); // Index value is empty
		}

		await batch.write();
	}

	/**
	 * Alters an existing store table's structure (ADD/DROP/RENAME COLUMN).
	 * Performs eager row migration for ADD and DROP, schema-only update for RENAME.
	 * Returns the updated TableSchema for the engine to register.
	 */
	async alterTable(
		db: Database,
		schemaName: string,
		tableName: string,
		change: SchemaChangeInfo,
	): Promise<TableSchema> {
		const tableKey = `${schemaName}.${tableName}`.toLowerCase();
		const table = this.tables.get(tableKey);

		if (!table) {
			throw new QuereusError(
				`Store table '${tableName}' not found in schema '${schemaName}'. Cannot alter.`,
				StatusCode.ERROR,
			);
		}

		const oldSchema = table.getSchema();
		const defaultNotNull = db.options.getStringOption('default_column_nullability') === 'not_null';

		switch (change.type) {
			case 'addColumn': {
				const newColSchema = columnDefToSchema(change.columnDef, defaultNotNull);

				// Extract default value from column def constraints
				let defaultValue: SqlValue = null;
				const defaultConstraint = change.columnDef.constraints?.find(c => c.type === 'default');
				if (defaultConstraint && defaultConstraint.expr && defaultConstraint.expr.type === 'literal') {
					defaultValue = (defaultConstraint.expr as { value: SqlValue }).value;
				}

				// Refuse NOT NULL without a literal DEFAULT on a non-empty table (SQLite-compatible).
				if (newColSchema.notNull && defaultValue === null) {
					if (await table.hasAnyRows()) {
						throw new QuereusError(
							`Cannot add NOT NULL column '${newColSchema.name}' to non-empty table `
								+ `'${schemaName}.${tableName}' without a DEFAULT value`,
							StatusCode.CONSTRAINT,
						);
					}
				}

				// Build updated schema: append new column
				const updatedColumns: ReadonlyArray<ColumnSchema> = Object.freeze([...oldSchema.columns, newColSchema]);
				const updatedSchema: TableSchema = {
					...oldSchema,
					columns: updatedColumns,
					columnIndexMap: buildColumnIndexMap(updatedColumns),
				};

				// Migrate rows: append default value to each row
				const remap = buildColumnRemap(
					oldSchema.columns.map(c => c.name),
					updatedColumns.map(c => c.name),
				);
				await table.migrateRows(remap, defaultValue);

				// Update table schema and persist DDL
				table.updateSchema(updatedSchema);
				await this.saveTableDDL(updatedSchema);

				this.eventEmitter?.emitSchemaChange({
					type: 'alter',
					objectType: 'table',
					schemaName,
					objectName: tableName,
				});

				return updatedSchema;
			}

			case 'dropColumn': {
				const colNameLower = change.columnName.toLowerCase();
				const colIndex = oldSchema.columns.findIndex(c => c.name.toLowerCase() === colNameLower);
				if (colIndex === -1) {
					throw new QuereusError(`Column '${change.columnName}' not found.`, StatusCode.ERROR);
				}

				// Build updated schema: remove column and reindex PK/indexes
				// Filter by original index BEFORE remapping to avoid incorrectly
				// removing columns that remap to the dropped column's position.
				const updatedColumns = oldSchema.columns.filter((_, idx) => idx !== colIndex);
				const updatedPkDef = oldSchema.primaryKeyDefinition
					.filter(def => def.index !== colIndex)
					.map(def => ({
						...def,
						index: def.index > colIndex ? def.index - 1 : def.index,
					}));
				const updatedIndexes = (oldSchema.indexes || [])
					.map(idx => ({
						...idx,
						columns: idx.columns
							.filter(ic => ic.index !== colIndex)
							.map(ic => ({ ...ic, index: ic.index > colIndex ? ic.index - 1 : ic.index })),
					}))
					.filter(idx => idx.columns.length > 0);

				const updatedSchema: TableSchema = {
					...oldSchema,
					columns: Object.freeze(updatedColumns),
					columnIndexMap: buildColumnIndexMap(updatedColumns),
					primaryKeyDefinition: Object.freeze(updatedPkDef),
					indexes: Object.freeze(updatedIndexes),
				};

				// Migrate rows: remove the dropped column slot
				const remap = buildColumnRemap(
					oldSchema.columns.map(c => c.name),
					updatedColumns.map(c => c.name),
				);
				await table.migrateRows(remap, null);

				// Update table schema and persist DDL
				table.updateSchema(updatedSchema);
				await this.saveTableDDL(updatedSchema);

				this.eventEmitter?.emitSchemaChange({
					type: 'alter',
					objectType: 'table',
					schemaName,
					objectName: tableName,
				});

				return updatedSchema;
			}

			case 'renameColumn': {
				if (!change.newColumnDefAst) {
					throw new QuereusError('RENAME COLUMN requires a new column definition AST', StatusCode.INTERNAL);
				}

				const oldNameLower = change.oldName.toLowerCase();
				const colIndex = oldSchema.columns.findIndex(c => c.name.toLowerCase() === oldNameLower);
				if (colIndex === -1) {
					throw new QuereusError(`Column '${change.oldName}' not found.`, StatusCode.ERROR);
				}

				const newColSchema = columnDefToSchema(change.newColumnDefAst, defaultNotNull);
				const updatedColumns = oldSchema.columns.map((c, i) => i === colIndex ? newColSchema : c);
				const updatedIndexes = (oldSchema.indexes || []).map(idx => ({
					...idx,
					columns: idx.columns.map(ic =>
						ic.index === colIndex ? { ...ic, name: change.newName } : ic
					),
				}));

				const updatedSchema: TableSchema = {
					...oldSchema,
					columns: Object.freeze(updatedColumns),
					columnIndexMap: buildColumnIndexMap(updatedColumns),
					indexes: Object.freeze(updatedIndexes),
				};

				// Rename is schema-only — no row migration needed
				table.updateSchema(updatedSchema);
				await this.saveTableDDL(updatedSchema);

				this.eventEmitter?.emitSchemaChange({
					type: 'alter',
					objectType: 'table',
					schemaName,
					objectName: tableName,
				});

				return updatedSchema;
			}

			case 'alterPrimaryKey': {
				const newPkColumns = change.newPkColumns;
				const updatedSchema: TableSchema = {
					...oldSchema,
					primaryKeyDefinition: Object.freeze(
						newPkColumns.map(pk => ({ index: pk.index, desc: pk.desc })),
					),
				};

				// Re-key the data store. Throws CONSTRAINT on duplicates without
				// mutating the store, giving us all-or-nothing semantics for the
				// validation phase.
				await table.rekeyRows(newPkColumns);

				// Secondary index keys embed the PK suffix — clear + rebuild every
				// index against the now-rekeyed data store.
				const dataStore = await this.getStore(tableKey, table.getConfig());
				for (const indexSchema of oldSchema.indexes ?? []) {
					const indexStore = await this.getIndexStore(schemaName, tableName, indexSchema.name);
					const clearBatch = indexStore.batch();
					for await (const entry of indexStore.iterate(buildFullScanBounds())) {
						clearBatch.delete(entry.key);
					}
					await clearBatch.write();
					await this.buildIndexEntries(dataStore, indexStore, updatedSchema, indexSchema);
				}

				table.updateSchema(updatedSchema);
				await this.saveTableDDL(updatedSchema);

				this.eventEmitter?.emitSchemaChange({
					type: 'alter',
					objectType: 'table',
					schemaName,
					objectName: tableName,
				});

				return updatedSchema;
			}

			case 'alterColumn': {
				const colNameLower = change.columnName.toLowerCase();
				const colIndex = oldSchema.columns.findIndex(c => c.name.toLowerCase() === colNameLower);
				if (colIndex === -1) {
					throw new QuereusError(`Column '${change.columnName}' not found.`, StatusCode.ERROR);
				}
				const oldCol = oldSchema.columns[colIndex];
				let newCol: ColumnSchema = oldCol;

				// Pull exactly one of the three attributes from the change.
				if (change.setNotNull !== undefined) {
					if (change.setNotNull === true && !oldCol.notNull) {
						// Backfill NULLs from a literal DEFAULT, or throw.
						let defaultLiteral: SqlValue | undefined;
						const expr = oldCol.defaultValue;
						if (expr && (expr as { type?: string }).type === 'literal') {
							defaultLiteral = (expr as { value?: SqlValue }).value ?? null;
						}
						const nullCount = await table.rowsWithNullAtIndex(colIndex);
						if (nullCount > 0) {
							if (defaultLiteral === undefined || defaultLiteral === null) {
								throw new QuereusError(
									`column ${change.columnName} contains NULL values`,
									StatusCode.CONSTRAINT,
								);
							}
							const fill = defaultLiteral;
							await table.mapRowsAtIndex(colIndex, (v) => v === null ? fill : v);
						}
						newCol = { ...oldCol, notNull: true };
					} else if (change.setNotNull === false && oldCol.notNull) {
						if (oldSchema.primaryKeyDefinition.some(def => def.index === colIndex)) {
							throw new QuereusError(
								`Cannot DROP NOT NULL on PRIMARY KEY column '${change.columnName}'`,
								StatusCode.CONSTRAINT,
							);
						}
						newCol = { ...oldCol, notNull: false };
					} else {
						return oldSchema; // already in desired state
					}
				} else if (change.setDataType !== undefined) {
					const newLogicalType = inferType(change.setDataType);
					if (newLogicalType.physicalType !== oldCol.logicalType.physicalType) {
						// Physical conversion required — walk every row and attempt parse.
						await table.mapRowsAtIndex(colIndex, (v) => {
							if (v === null) return v;
							try {
								return validateAndParse(v, newLogicalType, change.columnName) as SqlValue;
							} catch {
								throw new QuereusError(
									`Cannot convert value in '${change.columnName}' to ${change.setDataType}`,
									StatusCode.MISMATCH,
								);
							}
						});
					}
					newCol = { ...oldCol, logicalType: newLogicalType };
				} else if (change.setDefault !== undefined) {
					newCol = { ...oldCol, defaultValue: change.setDefault };
				} else {
					throw new QuereusError('ALTER COLUMN requires an attribute to change', StatusCode.INTERNAL);
				}

				const updatedColumns = oldSchema.columns.map((c, i) => i === colIndex ? newCol : c);
				const updatedSchema: TableSchema = {
					...oldSchema,
					columns: Object.freeze(updatedColumns),
					columnIndexMap: buildColumnIndexMap(updatedColumns),
				};

				table.updateSchema(updatedSchema);
				await this.saveTableDDL(updatedSchema);

				this.eventEmitter?.emitSchemaChange({
					type: 'alter',
					objectType: 'table',
					schemaName,
					objectName: tableName,
				});

				return updatedSchema;
			}
		}
	}

	/**
	 * Rename a store-backed table.
	 *
	 * Drops every in-memory reference to the old name (so the coordinator, open
	 * handles, and cached StoreTable instance don't linger with stale paths),
	 * delegates physical storage relocation to the provider, then rewrites the
	 * persistent catalog DDL under the new key. After this returns, the next
	 * access to `newName` will reconnect via `connect()` and open fresh stores
	 * against the moved directories.
	 */
	async renameTable(
		db: Database,
		schemaName: string,
		oldName: string,
		newName: string,
	): Promise<void> {
		const oldKey = `${schemaName}.${oldName}`.toLowerCase();
		const newKey = `${schemaName}.${newName}`.toLowerCase();

		if (this.tables.has(newKey)) {
			throw new QuereusError(
				`Store table '${newName}' already exists in schema '${schemaName}'`,
				StatusCode.ERROR,
			);
		}

		// Capture the current schema BEFORE we drop in-memory references, so the
		// new catalog DDL reflects the real column set.
		const existing = this.tables.get(oldKey);
		const currentSchema: TableSchema | undefined =
			existing?.getSchema() ?? db.schemaManager.getTable(schemaName, oldName);

		// ALTER TABLE is effectively DDL-committing on a store-backed table:
		// once we move the on-disk directory, prior buffered writes can no
		// longer be rolled back through the coordinator. Flush any pending
		// ops to the old store NOW, before its handle is closed. Subsequent
		// commit() calls on the same coordinator are no-ops (inTransaction
		// is cleared), which keeps the enclosing transaction safe.
		const coordinator = this.coordinators.get(oldKey);
		if (coordinator?.isInTransaction()) {
			await coordinator.commit();
		}

		// Flush any lazy stats the cached handle was buffering; disconnect failures
		// must not block the rename.
		if (existing) {
			try {
				await existing.disconnect();
			} catch {
				/* ignore — physical rename must proceed */
			}
		}

		this.tables.delete(oldKey);
		this.stores.delete(oldKey);
		this.coordinators.delete(oldKey);

		// Move physical storage (data directory + index directories).
		if (this.provider.renameTableStores) {
			await this.provider.renameTableStores(schemaName, oldName, newName);
		}

		// Rewrite persistent catalog under the new name. Write the new DDL first
		// so a crash mid-rename leaves the table discoverable under at least one
		// name rather than neither.
		if (currentSchema) {
			const renamedSchema: TableSchema = { ...currentSchema, name: newName };
			await this.saveTableDDL(renamedSchema);
		}
		await this.removeTableDDL(schemaName, oldName);

		// Relocate the stats entry (unified __stats__ store, keyed by schema.table).
		try {
			const statsStore = await this.provider.getStatsStore(schemaName, newName);
			const oldStatsKey = buildStatsKey(schemaName, oldName);
			await statsStore.delete(oldStatsKey);
		} catch {
			/* stats are advisory — a stale entry under the old key is harmless */
		}

		this.eventEmitter?.emitSchemaChange({
			type: 'alter',
			objectType: 'table',
			schemaName,
			objectName: newName,
		});
	}

	/**
	 * Modern access planning interface.
	 */
	getBestAccessPlan(
		_db: Database,
		tableInfo: TableSchema,
		request: BestAccessPlanRequest
	): BestAccessPlanResult {
		const estimatedRows = request.estimatedRows ?? 1000;

		// Check for primary key equality constraints
		const pkColumns = tableInfo.primaryKeyDefinition.map(pk => pk.index);
		const pkFilters = request.filters.filter(f =>
			f.columnIndex !== undefined &&
			pkColumns.includes(f.columnIndex) &&
			f.op === '='
		);

		if (pkFilters.length === pkColumns.length && pkColumns.length > 0) {
			// Full PK match - point lookup
			const handledFilters = request.filters.map(f =>
				pkFilters.some(pf => pf.columnIndex === f.columnIndex && pf.op === f.op)
			);
			return AccessPlanBuilder
				.eqMatch(1, 0.1)
				.setHandledFilters(handledFilters)
				.setIsSet(true)
				.setExplanation('Store primary key lookup')
				.build();
		}

		// Check for range constraints on the leading PK column.
		// The legacy access-path rule (rule-select-access-path.ts) only forwards
		// range bounds for primaryKeyDefinition[0]; ranges on later PK columns
		// are silently dropped if marked handled. So only claim handled=true
		// when the range is on the first PK column.
		const rangeOps = ['<', '<=', '>', '>='];
		const firstPkColumn = tableInfo.primaryKeyDefinition[0]?.index;
		const rangeFilters = firstPkColumn !== undefined
			? request.filters.filter(f =>
				f.columnIndex === firstPkColumn &&
				rangeOps.includes(f.op))
			: [];

		if (rangeFilters.length > 0) {
			// Range scan on first PK column
			const handledFilters = request.filters.map(f =>
				rangeFilters.some(rf => rf.columnIndex === f.columnIndex && rf.op === f.op)
			);
			const rangeRows = Math.max(1, Math.floor(estimatedRows * 0.3));
			return AccessPlanBuilder
				.rangeScan(rangeRows, 0.2)
				.setHandledFilters(handledFilters)
				.setExplanation('Store primary key range scan')
				.build();
		}

		// Check for secondary index usage
		// Note: query() does not yet implement secondary index scans — it falls
		// back to a full table scan + matchesFilters.  We still advertise better
		// cost estimates when a usable index exists (so the planner prefers this
		// table access) but we must NOT mark filters as handled, otherwise the
		// engine won't supply them to matchesFilters and rows pass unfiltered.
		const indexes = tableInfo.indexes || [];
		for (const index of indexes) {
			const indexColumns = index.columns.map(c => c.index);
			const indexFilters = request.filters.filter(f =>
				f.columnIndex !== undefined &&
				indexColumns.includes(f.columnIndex) &&
				f.op === '='
			);

			if (indexFilters.length > 0) {
				const matchedRows = Math.max(1, Math.floor(estimatedRows * 0.1));
				return AccessPlanBuilder
					.eqMatch(matchedRows, 0.3)
					.setHandledFilters(new Array(request.filters.length).fill(false))
					.setExplanation(`Store index scan on ${index.name}`)
					.build();
			}
		}

		// Fallback to full scan
		return AccessPlanBuilder
			.fullScan(estimatedRows)
			.setHandledFilters(new Array(request.filters.length).fill(false))
			.setExplanation('Store full table scan')
			.build();
	}

	// --- StoreTableModule interface implementation ---

	/**
	 * Get or create a data store for a table.
	 */
	async getStore(tableKey: string, _config: StoreTableConfig): Promise<KVStore> {
		let store = this.stores.get(tableKey);
		if (!store) {
			const [schemaName, tableName] = tableKey.split('.');
			store = await this.provider.getStore(schemaName, tableName);

			if (!store) {
				throw new Error(`Provider.getStore returned null/undefined for ${tableKey}`);
			}

			this.stores.set(tableKey, store);
		}
		return store;
	}

	/**
	 * Get or create an index store for a table.
	 */
	async getIndexStore(schemaName: string, tableName: string, indexName: string): Promise<KVStore> {
		return this.provider.getIndexStore(schemaName, tableName, indexName);
	}

	/**
	 * Get or create a stats store for a table.
	 */
	async getStatsStore(schemaName: string, tableName: string): Promise<KVStore> {
		return this.provider.getStatsStore(schemaName, tableName);
	}

	/**
	 * Get or create a transaction coordinator for a table.
	 */
	async getCoordinator(tableKey: string, config: StoreTableConfig): Promise<TransactionCoordinator> {
		let coordinator = this.coordinators.get(tableKey);
		if (!coordinator) {
			const store = await this.getStore(tableKey, config);
			coordinator = new TransactionCoordinator(store, this.eventEmitter);
			this.coordinators.set(tableKey, coordinator);
		}
		return coordinator;
	}

	/**
	 * Save table DDL to the catalog store.
	 */
	async saveTableDDL(tableSchema: TableSchema): Promise<void> {
		const ddl = generateTableDDL(tableSchema);
		const catalogKey = buildCatalogKey(tableSchema.schemaName, tableSchema.name);
		const encoder = new TextEncoder();
		const encodedDDL = encoder.encode(ddl);

		const catalogStore = await this.provider.getCatalogStore();
		await catalogStore.put(catalogKey, encodedDDL);
	}

	/**
	 * Load all DDL statements from the catalog store.
	 * Used to restore persisted tables on startup.
	 */
	async loadAllDDL(): Promise<string[]> {
		const catalogStore = await this.provider.getCatalogStore();
		const bounds = buildCatalogScanBounds();
		const decoder = new TextDecoder();
		const ddlStatements: string[] = [];

		for await (const entry of catalogStore.iterate(bounds)) {
			const ddl = decoder.decode(entry.value);
			ddlStatements.push(ddl);
		}

		return ddlStatements;
	}

	/**
	 * Rehydrate persisted catalog into the in-memory schema manager.
	 *
	 * Loads all DDL from the catalog store and imports each entry
	 * individually. Parse failures are collected rather than fatal,
	 * so a single corrupt entry does not prevent other tables from
	 * loading.
	 *
	 * Call after `db.registerModule()` (and `db.setDefaultVtabName()`
	 * if DDL may lack a USING clause).
	 */
	async rehydrateCatalog(db: Database): Promise<RehydrationResult> {
		const ddlStatements = await this.loadAllDDL();
		const result: RehydrationResult = { tables: [], indexes: [], errors: [] };

		if (ddlStatements.length === 0) {
			return result;
		}

		for (const ddl of ddlStatements) {
			try {
				const imported = await db.schemaManager.importCatalog([ddl]);
				result.tables.push(...imported.tables);
				result.indexes.push(...imported.indexes);
			} catch (e: unknown) {
				const error = e instanceof Error ? e : new Error(String(e));
				console.warn(
					`[StoreModule] Failed to rehydrate DDL entry, skipping: ${error.message}\n  DDL: ${ddl.substring(0, 120)}`
				);
				result.errors.push({ ddl, error });
			}
		}

		return result;
	}

	/**
	 * Remove DDL from the catalog store when a table is dropped.
	 */
	async removeTableDDL(schemaName: string, tableName: string): Promise<void> {
		const catalogKey = buildCatalogKey(schemaName, tableName);
		const catalogStore = await this.provider.getCatalogStore();
		await catalogStore.delete(catalogKey);
	}

	/**
	 * Parse module configuration from vtab args.
	 */
	private parseConfig(args: Record<string, SqlValue> | undefined): StoreModuleConfig {
		return {
			collation: (args?.collation as 'BINARY' | 'NOCASE') || 'NOCASE',
		};
	}

	/**
	 * Close all stores.
	 */
	async closeAll(): Promise<void> {
		for (const table of this.tables.values()) {
			await table.disconnect();
		}
		this.tables.clear();
		this.coordinators.clear();

		await this.provider.closeAll();
		this.stores.clear();
	}

	/**
	 * Get a table by schema and name.
	 */
	getTable(schemaName: string, tableName: string): StoreTable | undefined {
		const tableKey = `${schemaName}.${tableName}`.toLowerCase();
		return this.tables.get(tableKey);
	}
}

/**
 * Build a column remap array: newColumnIndex -> oldColumnIndex | -1.
 * Maps each column in the new layout to its position in the old layout.
 * -1 means the column is new (fill with default).
 */
function buildColumnRemap(oldColumnNames: string[], newColumnNames: string[]): number[] {
	const oldIndexByName = new Map<string, number>();
	for (let i = 0; i < oldColumnNames.length; i++) {
		oldIndexByName.set(oldColumnNames[i].toLowerCase(), i);
	}
	return newColumnNames.map(name => {
		const oldIdx = oldIndexByName.get(name.toLowerCase());
		return oldIdx !== undefined ? oldIdx : -1;
	});
}
