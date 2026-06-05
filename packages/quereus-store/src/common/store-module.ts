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
	OrderingSpec,
	SqlValue,
	ModuleCapabilities,
	SchemaChangeInfo,
	ColumnSchema,
	Schema,
	MappingAdvertisement,
} from '@quereus/quereus';
import { AccessPlanBuilder, QuereusError, StatusCode, buildColumnIndexMap, columnDefToSchema, compilePredicate, inferType, tryFoldLiteral, validateAndParse, buildAdvertisementsFromTags, resolveNamedConstraintClass } from '@quereus/quereus';
import type { CompiledPredicate } from '@quereus/quereus';

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
	 * Generic-module mapping advertisements: assembled from the `quereus.lens.decomp.*`
	 * reserved tags on this basis schema's tables. Returns `[]` when the schema has no
	 * such tags, leaving the lens default mapper on its name-match path.
	 * See `docs/lens.md` § The Default Mapper.
	 */
	getMappingAdvertisements(_db: Database, basisSchema: Schema): readonly MappingAdvertisement[] {
		return buildAdvertisementsFromTags(basisSchema);
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

		// Refresh the connected table's cached schema so subsequent DML
		// maintains the new index (the engine's schema registry is updated
		// separately by SchemaManager.createIndex, but the StoreTable instance
		// holds its own reference captured at connect time). Mirrors
		// SchemaManager.addIndexToTableSchema, including the UNIQUE → derived
		// uniqueConstraint entry so checkUniqueConstraints enforces it.
		const updatedIndexes = Object.freeze([
			...(tableSchema.indexes ?? []),
			indexSchema,
		]);
		const updatedSchema: TableSchema = { ...tableSchema, indexes: updatedIndexes };
		if (indexSchema.unique) {
			// `derivedFromIndex` tags this synthesized constraint so a future
			// `StoreModule.dropIndex` can filter it out symmetrically (mirrors
			// SchemaManager.dropIndex / MemoryTableManager.dropIndex). Without that
			// filter on the drop side, the UNIQUE check would survive the index.
			updatedSchema.uniqueConstraints = Object.freeze([
				...(tableSchema.uniqueConstraints ?? []),
				{
					name: indexSchema.name,
					columns: Object.freeze(indexSchema.columns.map(c => c.index)),
					predicate: indexSchema.predicate,
					derivedFromIndex: indexSchema.name,
				},
			]);
		}
		table.updateSchema(updatedSchema);

		// Emit schema change event
		this.eventEmitter?.emitSchemaChange({
			type: 'create',
			objectType: 'index',
			schemaName,
			objectName: indexSchema.name,
		});
	}

	/**
	 * Drops an index on a store-backed table.
	 *
	 * Mirrors createIndex: refreshes the connected StoreTable's cached
	 * tableSchema (removing the index entry and any UNIQUE constraint
	 * synthesized from it, tagged with `derivedFromIndex`), releases the
	 * cached index-store handle, and tears down the underlying index store.
	 */
	async dropIndex(
		_db: Database,
		schemaName: string,
		tableName: string,
		indexName: string,
	): Promise<void> {
		const tableKey = `${schemaName}.${tableName}`.toLowerCase();
		const table = this.tables.get(tableKey);

		if (!table) {
			throw new QuereusError(
				`Store table '${tableName}' not found in schema '${schemaName}'`,
				StatusCode.NOTFOUND,
			);
		}

		const tableSchema = table.getSchema();
		const lowerIndexName = indexName.toLowerCase();

		// Mirror SchemaManager.dropIndex: strip the index AND any UNIQUE
		// constraint synthesized from it (tagged with `derivedFromIndex` by
		// StoreModule.createIndex). Collapse uniqueConstraints to undefined
		// when empty.
		const updatedIndexes = Object.freeze(
			(tableSchema.indexes ?? []).filter(
				idx => idx.name.toLowerCase() !== lowerIndexName,
			),
		);
		const remainingUniqueConstraints = (tableSchema.uniqueConstraints ?? []).filter(
			uc => uc.derivedFromIndex?.toLowerCase() !== lowerIndexName,
		);
		const updatedSchema: TableSchema = {
			...tableSchema,
			indexes: updatedIndexes,
			uniqueConstraints: remainingUniqueConstraints.length > 0
				? Object.freeze(remainingUniqueConstraints)
				: undefined,
		};
		// Update the cached schema BEFORE tearing down the store so that a
		// failure of the physical drop doesn't leave the schema enforcing an
		// index whose backing store has already been mutated.
		table.updateSchema(updatedSchema);

		// Drop the cached handle on the table side and tear down the
		// underlying KVStore. `deleteIndexStore` (if the provider implements
		// it) closes the handle before removing the directory; otherwise we
		// just close it.
		await table.releaseIndexStore(indexName);
		if (this.provider.deleteIndexStore) {
			await this.provider.deleteIndexStore(schemaName, tableName, indexName);
		} else {
			await this.provider.closeIndexStore(schemaName, tableName, indexName);
		}

		this.eventEmitter?.emitSchemaChange({
			type: 'drop',
			objectType: 'index',
			schemaName,
			objectName: indexName,
		});
	}

	/**
	 * Build index entries for all existing rows in a table.
	 *
	 * For UNIQUE indexes, performs an in-pass duplicate check (honoring partial
	 * predicates and SQL NULL semantics: multiple NULLs are allowed) and throws
	 * CONSTRAINT before any entries are written. Mirrors the memory module's
	 * populateNewIndex so `CREATE UNIQUE INDEX` over duplicated data fails
	 * atomically.
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

		const predicate: CompiledPredicate | undefined = indexSchema.predicate
			? compilePredicate(indexSchema.predicate, tableSchema.columns)
			: undefined;
		const seen: Set<string> | undefined = indexSchema.unique ? new Set() : undefined;

		// Scan all data rows
		const bounds = buildFullScanBounds();
		const batch = indexStore.batch();

		for await (const entry of dataStore.iterate(bounds)) {
			const row = deserializeRow(entry.value);

			// Partial index: skip rows whose predicate is not unambiguously TRUE.
			if (predicate && predicate.evaluate(row) !== true) continue;

			// Extract PK values
			const pkValues = tableSchema.primaryKeyDefinition.map(pk => row[pk.index]);

			// Extract index column values
			const indexValues = indexSchema.columns.map(col => row[col.index]);

			if (seen) {
				// SQL UNIQUE allows multiple NULLs: skip dup detection when any
				// indexed column is NULL for this row.
				const hasNull = indexValues.some(v => v === null);
				if (!hasNull) {
					const keySig = JSON.stringify(indexValues);
					if (seen.has(keySig)) {
						const colNames = indexSchema.columns
							.map(c => tableSchema.columns[c.index]?.name ?? String(c.index))
							.join(', ');
						throw new QuereusError(
							`UNIQUE constraint failed: ${tableSchema.name} (${colNames})`,
							StatusCode.CONSTRAINT,
						);
					}
					seen.add(keySig);
				}
			}

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
		// Lazy-connect: `renameTable` evicts the old key from `this.tables` and
		// expects the next `connect()` to repopulate under the new name, but
		// `apply schema` can call `alterTable` immediately after a rename without
		// an intervening connect. Mirror connect()'s schemaManager lookup so the
		// follow-up ALTER finds the moved table.
		let table = this.tables.get(tableKey);
		if (!table) {
			const registeredSchema = db.schemaManager.getTable(schemaName, tableName);
			if (registeredSchema) {
				table = new StoreTable(
					db,
					this,
					registeredSchema,
					this.parseConfig(registeredSchema.vtabArgs ?? {}),
					this.eventEmitter,
					true, // isConnected - DDL already exists in storage
				);
				this.tables.set(tableKey, table);
			}
		}

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

				// Extract default value from column def constraints. Use the shared
				// `tryFoldLiteral` helper so signed numerics like `-123.0`
				// (a UnaryExpr in the AST) are recognized — matching the
				// memory-mode path and the engine-level ALTER validation.
				let defaultValue: SqlValue = null;
				const defaultConstraint = change.columnDef.constraints?.find(c => c.type === 'default');
				if (defaultConstraint?.expr) {
					const folded = tryFoldLiteral(defaultConstraint.expr);
					if (folded !== undefined) {
						defaultValue = folded;
					}
				}

				// A non-foldable DEFAULT (e.g. `new.<col>`) backfills each existing row from
				// its own value via the engine-supplied evaluator (mirrors the memory path).
				const backfillEvaluator = change.backfillEvaluator;

				// Refuse NOT NULL without a usable DEFAULT on a non-empty table
				// (SQLite-compatible). A per-row evaluator IS usable — its NOT NULL is enforced
				// per row during migration — so it is exempt from this no-default rejection.
				if (newColSchema.notNull && defaultValue === null && !backfillEvaluator) {
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

				// Migrate rows: append the new column's value — a single literal default, or a
				// per-row value derived from the existing row when a backfill evaluator is set.
				const remap = buildColumnRemap(
					oldSchema.columns.map(c => c.name),
					updatedColumns.map(c => c.name),
				);
				await table.migrateRows(
					remap,
					defaultValue,
					backfillEvaluator
						? { evaluator: backfillEvaluator, notNull: newColSchema.notNull, columnName: newColSchema.name }
						: undefined,
				);

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

			case 'addConstraint': {
				throw new QuereusError(
					`Store table does not support ADD CONSTRAINT ${change.constraint.type}`,
					StatusCode.UNSUPPORTED,
				);
			}

			case 'dropConstraint': {
				// Schema-only catalog rewrite: store-backed UNIQUE enforcement is a
				// full-scan over `uniqueConstraints` (no separate index store for an
				// inline UNIQUE), so dropping the constraint stops enforcement with no
				// physical teardown. A UNIQUE derived from a CREATE UNIQUE INDEX is
				// rejected upstream (drop the index instead), so we never strand a store.
				const constraintClass = resolveNamedConstraintClass(oldSchema, change.constraintName);
				const lower = change.constraintName.toLowerCase();
				let updatedSchema: TableSchema;
				if (constraintClass === 'check') {
					updatedSchema = {
						...oldSchema,
						checkConstraints: Object.freeze(oldSchema.checkConstraints.filter(c => c.name?.toLowerCase() !== lower)),
					};
				} else if (constraintClass === 'foreignKey') {
					const remaining = (oldSchema.foreignKeys ?? []).filter(c => c.name?.toLowerCase() !== lower);
					updatedSchema = { ...oldSchema, foreignKeys: remaining.length > 0 ? Object.freeze(remaining) : undefined };
				} else {
					const remaining = (oldSchema.uniqueConstraints ?? []).filter(c => c.name?.toLowerCase() !== lower);
					updatedSchema = { ...oldSchema, uniqueConstraints: remaining.length > 0 ? Object.freeze(remaining) : undefined };
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

			case 'renameConstraint': {
				const constraintClass = resolveNamedConstraintClass(oldSchema, change.oldName);
				const oldLower = change.oldName.toLowerCase();
				let updatedSchema: TableSchema;
				if (constraintClass === 'check') {
					updatedSchema = {
						...oldSchema,
						checkConstraints: Object.freeze(
							oldSchema.checkConstraints.map(c => (c.name?.toLowerCase() === oldLower ? { ...c, name: change.newName } : c)),
						),
					};
				} else if (constraintClass === 'foreignKey') {
					updatedSchema = {
						...oldSchema,
						foreignKeys: Object.freeze(
							oldSchema.foreignKeys!.map(c => (c.name?.toLowerCase() === oldLower ? { ...c, name: change.newName } : c)),
						),
					};
				} else {
					updatedSchema = {
						...oldSchema,
						uniqueConstraints: Object.freeze(
							oldSchema.uniqueConstraints!.map(c => (c.name?.toLowerCase() === oldLower ? { ...c, name: change.newName } : c)),
						),
					};
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
			// Full PK match - point lookup (single row; no monotonic advertisement)
			const handledFilters = request.filters.map(f =>
				pkFilters.some(pf => pf.columnIndex === f.columnIndex && pf.op === f.op)
			);
			return AccessPlanBuilder
				.eqMatch(1, 0.1)
				.setHandledFilters(handledFilters)
				.setIsSet(true)
				.setIndexName('_primary_')
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
			// Range scan on first PK column. Iteration is by PK key order (see
			// StoreTable.scanPKRange), so we can advertise monotonic emission on
			// the leading PK column. The scan still visits the entire data store
			// today (TODO in scanPKRange to refine bounds), but the order
			// guarantee already holds.
			const handledFilters = request.filters.map(f =>
				rangeFilters.some(rf => rf.columnIndex === f.columnIndex && rf.op === f.op)
			);
			const rangeRows = Math.max(1, Math.floor(estimatedRows * 0.3));
			const plan = AccessPlanBuilder
				.rangeScan(rangeRows, 0.2)
				.setHandledFilters(handledFilters)
				.setIndexName('_primary_')
				.setSeekColumns([firstPkColumn!])
				.setExplanation('Store primary key range scan')
				.build();
			return { ...plan, ...this.buildPkOrderingAdvertisement(tableInfo, request) };
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

		// Fallback to full scan. The store iterates rows in PK key order
		// (see StoreTable.query / store.iterate over buildFullScanBounds), so
		// the scan is monotonic on the leading PK column. Advertise that so
		// downstream rules (merge-join, asof-scan) can fire on store-backed
		// tables, matching memory-mode behavior.
		const plan = AccessPlanBuilder
			.fullScan(estimatedRows)
			.setHandledFilters(new Array(request.filters.length).fill(false))
			.setExplanation('Store full table scan')
			.build();
		return { ...plan, ...this.buildPkOrderingAdvertisement(tableInfo, request) };
	}

	/**
	 * Compute the PK-ordering advertisement for a scan-style plan. Returns the
	 * `providesOrdering` / `monotonicOn` / `supportsAsofRight` fields for a plan
	 * whose iteration is driven by the primary-key key order (full scan or PK
	 * range scan).
	 *
	 * `providesOrdering` is set only when it actually matches what the caller
	 * needs:
	 *   - When the request carries `requiredOrdering`, claim it only if the
	 *     requested keys form a prefix of the PK with matching directions.
	 *     Claiming PK order against an `ORDER BY <other column>` would cause
	 *     the absorb-Sort rule to drop the Sort and yield wrong-order rows.
	 *   - When no `requiredOrdering` is present, advertise the full PK
	 *     ordering so downstream rules (merge-join, sort elision after a
	 *     filter) can opportunistically use it.
	 *
	 * `monotonicOn` reflects the access path itself and is independent of any
	 * `requiredOrdering`; it always advertises the leading PK column. Strict
	 * monotonicity is claimed iff the PK is single-column — composite PKs can
	 * repeat values on the leading column.
	 *
	 * Returns an empty object when there is no PK (heap-only table) — without a
	 * leading key column there is no natural emit order.
	 */
	private buildPkOrderingAdvertisement(
		tableInfo: TableSchema,
		request: BestAccessPlanRequest,
	): Pick<BestAccessPlanResult, 'providesOrdering' | 'orderingIndexName' | 'monotonicOn' | 'supportsAsofRight'> {
		const pk = tableInfo.primaryKeyDefinition;
		if (pk.length === 0) return {};

		const leading = pk[0];
		const monotonicOn = {
			columnIndex: leading.index,
			direction: leading.desc ? 'desc' as const : 'asc' as const,
			strict: pk.length === 1,
		};

		const pkOrdering: OrderingSpec[] = pk.map(col => ({
			columnIndex: col.index,
			desc: !!col.desc,
		}));

		// Pick the providesOrdering to advertise based on requiredOrdering.
		const required = request.requiredOrdering;
		let providesOrdering: readonly OrderingSpec[] | undefined;
		if (required && required.length > 0) {
			// Only claim ordering when the requested keys form a prefix of the
			// PK with matching directions. nullsFirst is intentionally not
			// matched here — if the request specifies an explicit NULLS
			// FIRST/LAST, leave the Sort in place rather than assume the PK
			// scan's natural NULL placement matches.
			if (required.length > pk.length) return { monotonicOn, supportsAsofRight: true };
			for (let i = 0; i < required.length; i++) {
				if (required[i].columnIndex !== pkOrdering[i].columnIndex) return { monotonicOn, supportsAsofRight: true };
				if (required[i].desc !== pkOrdering[i].desc) return { monotonicOn, supportsAsofRight: true };
				if (required[i].nullsFirst !== undefined) return { monotonicOn, supportsAsofRight: true };
			}
			providesOrdering = required;
		} else {
			providesOrdering = pkOrdering;
		}

		return {
			providesOrdering,
			orderingIndexName: '_primary_',
			monotonicOn,
			supportsAsofRight: true,
		};
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
