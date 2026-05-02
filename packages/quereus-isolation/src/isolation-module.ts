import type { Database, VirtualTableModule, BaseModuleConfig, TableSchema, TableIndexSchema as IndexSchema, ModuleCapabilities, VirtualTable, BestAccessPlanRequest, BestAccessPlanResult, SchemaChangeInfo, FilterInfo, Row, SqlValue } from '@quereus/quereus';
import { MemoryTableModule, PhysicalType, QuereusError, StatusCode } from '@quereus/quereus';
import type { IsolationModuleConfig } from './isolation-types.js';
import { IsolatedTable } from './isolated-table.js';

let overlayIdCounter = 0;

/**
 * Generates a unique overlay ID for each overlay table instance.
 * Used to avoid name conflicts when multiple overlays exist.
 */
export function generateOverlayId(): number {
	return ++overlayIdCounter;
}

/**
 * Per-table state tracking the underlying table (shared across all connections).
 */
export interface UnderlyingTableState {
	underlyingTable: VirtualTable;
}

/**
 * Per-connection overlay state for a specific table.
 * Each connection gets its own overlay that persists across IsolatedTable instances.
 */
export interface ConnectionOverlayState {
	overlayTable: VirtualTable;
	hasChanges: boolean;
}

/**
 * A module wrapper that adds transaction isolation to any underlying module.
 *
 * The isolation layer intercepts reads and writes:
 * - Writes go to an overlay table (uncommitted changes, per-connection)
 * - Reads merge overlay with underlying data
 * - Commit flushes overlay to underlying
 * - Rollback discards overlay
 *
 * Architecture:
 * - Underlying tables are shared across all connections (one per table)
 * - Overlay tables are per-connection per-table (created lazily on first write)
 * - Each IsolatedTable instance looks up its overlay from connection-scoped storage
 *
 * This provides ACID semantics including:
 * - Read-your-own-writes within a transaction
 * - Snapshot isolation (reads see consistent state)
 * - Savepoint support via overlay module's transaction support
 */
export class IsolationModule implements VirtualTableModule<IsolatedTable, BaseModuleConfig> {
	readonly underlying: VirtualTableModule<any, any>;
	readonly overlayModule: VirtualTableModule<any, any>;
	readonly tombstoneColumn: string;

	/** Underlying table state per table, keyed by "schemaName.tableName" */
	private readonly underlyingTables = new Map<string, UnderlyingTableState>();

	/**
	 * Per-connection overlay states, keyed by "connectionId:schemaName.tableName".
	 * The connectionId is derived from the database's transaction context.
	 */
	private readonly connectionOverlays = new Map<string, ConnectionOverlayState>();

	/**
	 * Tracks savepoint depths that were created before the overlay existed, per
	 * connection+table.  Keyed identically to connectionOverlays.
	 * When the overlay is created lazily after some savepoints already exist,
	 * its MemoryVirtualTableConnection stack needs to be padded so that
	 * rollbackToSavepoint(depth) looks up the correct stack index.
	 */
	private readonly preOverlaySavepoints = new Map<string, Set<number>>();

	constructor(config: IsolationModuleConfig) {
		this.underlying = config.underlying;
		this.overlayModule = config.overlay ?? new MemoryTableModule();
		this.tombstoneColumn = config.tombstoneColumn ?? '_tombstone';
	}

	/**
	 * Gets the underlying table state for a table.
	 */
	getUnderlyingState(schemaName: string, tableName: string): UnderlyingTableState | undefined {
		const key = `${schemaName}.${tableName}`.toLowerCase();
		return this.underlyingTables.get(key);
	}

	/**
	 * Sets underlying table state.
	 */
	private setUnderlyingState(schemaName: string, tableName: string, state: UnderlyingTableState): void {
		const key = `${schemaName}.${tableName}`.toLowerCase();
		this.underlyingTables.set(key, state);
	}

	/**
	 * Removes underlying table state.
	 */
	private removeUnderlyingState(schemaName: string, tableName: string): void {
		const key = `${schemaName}.${tableName}`.toLowerCase();
		this.underlyingTables.delete(key);
	}

	/**
	 * Gets the overlay state for a specific connection and table.
	 */
	getConnectionOverlay(db: Database, schemaName: string, tableName: string): ConnectionOverlayState | undefined {
		const key = this.makeConnectionOverlayKey(db, schemaName, tableName);
		return this.connectionOverlays.get(key);
	}

	/**
	 * Sets the overlay state for a specific connection and table.
	 */
	setConnectionOverlay(db: Database, schemaName: string, tableName: string, state: ConnectionOverlayState): void {
		const key = this.makeConnectionOverlayKey(db, schemaName, tableName);
		this.connectionOverlays.set(key, state);
	}

	/**
	 * Removes the overlay state for a specific connection and table.
	 * Called after commit/rollback to clean up.
	 */
	clearConnectionOverlay(db: Database, schemaName: string, tableName: string): void {
		const key = this.makeConnectionOverlayKey(db, schemaName, tableName);
		this.connectionOverlays.delete(key);
	}

	/**
	 * Returns (creating if absent) the set of savepoint depths that pre-date the overlay
	 * for this connection+table.  Shared across all IsolatedTable instances in the
	 * same connection so that ensureOverlay() on any instance sees the correct set.
	 */
	getPreOverlaySavepoints(db: Database, schemaName: string, tableName: string): Set<number> {
		const key = this.makeConnectionOverlayKey(db, schemaName, tableName);
		let set = this.preOverlaySavepoints.get(key);
		if (!set) {
			set = new Set();
			this.preOverlaySavepoints.set(key, set);
		}
		return set;
	}

	/** Removes the pre-overlay savepoint set for a connection+table. */
	clearPreOverlaySavepoints(db: Database, schemaName: string, tableName: string): void {
		const key = this.makeConnectionOverlayKey(db, schemaName, tableName);
		this.preOverlaySavepoints.delete(key);
	}

	/**
	 * Creates a unique key for connection-scoped overlay storage.
	 * Uses the database instance's identity as the connection identifier.
	 */
	private makeConnectionOverlayKey(db: Database, schemaName: string, tableName: string): string {
		// Use a unique ID from the database instance or its transaction context
		// For now, we use the database's object identity via a WeakMap approach
		// But since we can't easily get a stable ID, we'll use a simple counter
		// that gets assigned to each database instance on first access
		const dbId = this.getDbId(db);
		return `${dbId}:${schemaName}.${tableName}`.toLowerCase();
	}

	/** WeakMap to assign stable IDs to database instances */
	private static dbIdMap = new WeakMap<Database, number>();
	private static nextDbId = 1;

	private getDbId(db: Database): number {
		let id = IsolationModule.dbIdMap.get(db);
		if (id === undefined) {
			id = IsolationModule.nextDbId++;
			IsolationModule.dbIdMap.set(db, id);
		}
		return id;
	}

	/**
	 * Returns capabilities combining underlying module with isolation guarantees.
	 */
	getCapabilities(): ModuleCapabilities {
		const underlyingCaps = this.underlying.getCapabilities?.() ?? {};
		return {
			...underlyingCaps,
			isolation: true,
			savepoints: true,
		};
	}

	/**
	 * Delegates access plan selection to the underlying module.
	 * This ensures the query planner knows about indexes and can generate
	 * appropriate FilterInfo for index scans.
	 */
	getBestAccessPlan(
		db: Database,
		tableInfo: TableSchema,
		request: BestAccessPlanRequest
	): BestAccessPlanResult {
		if (!this.underlying.getBestAccessPlan) {
			// Return a default full scan plan if underlying doesn't implement getBestAccessPlan
			const rows = request.estimatedRows ?? 1000;
			return {
				handledFilters: request.filters.map(() => false),
				rows,
				cost: rows,
			};
		}
		return this.underlying.getBestAccessPlan(db, tableInfo, request);
	}

	/**
	 * Creates a new isolated table wrapping an underlying table.
	 *
	 * The overlay is NOT created here - it's created lazily on first write
	 * by each IsolatedTable instance, and stored in connection-scoped storage.
	 */
	async create(db: Database, tableSchema: TableSchema): Promise<IsolatedTable> {
		// 1. Create the underlying table
		const underlyingTable = await this.underlying.create(db, tableSchema);

		// 2. Store underlying state (overlay is per-connection, created lazily)
		const state: UnderlyingTableState = { underlyingTable };
		this.setUnderlyingState(tableSchema.schemaName, tableSchema.name, state);

		// 3. Return wrapped table (overlay will be created lazily on first write)
		return new IsolatedTable(db, this, underlyingTable);
	}

	/**
	 * Connects to an existing isolated table.
	 *
	 * Each connect() call returns a fresh IsolatedTable that shares:
	 * - The underlying table (with all connections)
	 * - The overlay table (with the same connection/transaction context)
	 *
	 * The overlay is created lazily on first write.
	 */
	async connect(
		db: Database,
		pAux: unknown,
		moduleName: string,
		schemaName: string,
		tableName: string,
		options: BaseModuleConfig,
		tableSchema?: TableSchema
	): Promise<IsolatedTable> {
		// Check for existing underlying table
		let state = this.getUnderlyingState(schemaName, tableName);

		if (!state) {
			// No existing underlying - connect to it
			const underlyingTable = await this.underlying.connect(
				db, pAux, moduleName, schemaName, tableName, options, tableSchema
			);

			state = { underlyingTable };
			this.setUnderlyingState(schemaName, tableName, state);
		}

		// When the planner requested a committed-snapshot read (committed.<table>), bypass
		// the per-connection overlay so reads reflect only persisted underlying state.
		const readCommitted = (options as { _readCommitted?: boolean } | undefined)?._readCommitted === true;

		// Return a fresh IsolatedTable instance that will look up its overlay
		// from connection-scoped storage (shared with other instances in same transaction)
		return new IsolatedTable(db, this, state.underlyingTable, readCommitted);
	}

	/**
	 * Destroys the underlying table.
	 */
	async destroy(
		db: Database,
		pAux: unknown,
		moduleName: string,
		schemaName: string,
		tableName: string
	): Promise<void> {
		this.removeUnderlyingState(schemaName, tableName);
		await this.underlying.destroy(db, pAux, moduleName, schemaName, tableName);
	}

	/**
	 * Closes all resources held by the underlying module (if it supports closeAll).
	 * Also clears connection overlay state.
	 */
	async closeAll(): Promise<void> {
		this.connectionOverlays.clear();
		this.preOverlaySavepoints.clear();
		this.underlyingTables.clear();
		const underlyingWithClose = this.underlying as { closeAll?: () => Promise<void> };
		if (typeof underlyingWithClose.closeAll === 'function') {
			await underlyingWithClose.closeAll();
		}
	}

	/**
	 * Creates an index on the underlying table.
	 *
	 * Note: Indexes on per-connection overlays are created lazily when the
	 * overlay is created, by copying from the underlying table's schema.
	 *
	 * We use the stored table instance's createIndex() rather than the module-level
	 * method so that the MemoryTable's local tableSchema property stays in sync.
	 * That property is what ensureOverlay() reads when building the overlay schema.
	 */
	async createIndex(
		db: Database,
		schemaName: string,
		tableName: string,
		indexSchema: IndexSchema
	): Promise<void> {
		const state = this.getUnderlyingState(schemaName, tableName);
		if (state?.underlyingTable.createIndex) {
			// Instance-level createIndex keeps MemoryTable.tableSchema fresh
			await state.underlyingTable.createIndex(indexSchema);
		} else if (this.underlying.createIndex) {
			await this.underlying.createIndex(db, schemaName, tableName, indexSchema);
		}
	}

	/**
	 * Delegates ALTER TABLE to the underlying module and migrates any per-connection
	 * overlays to the post-alter schema without discarding staged rows.
	 *
	 * ADD COLUMN  — appends null to each overlay row's data columns.
	 * DROP COLUMN — removes the dropped column from each overlay row.
	 * RENAME / ALTER COLUMN — data column indices are unchanged; only schema metadata rotates.
	 */
	async alterTable(
		db: Database,
		schemaName: string,
		tableName: string,
		change: SchemaChangeInfo,
	): Promise<TableSchema> {
		if (!this.underlying.alterTable) {
			throw new QuereusError(
				`Underlying module does not support ALTER TABLE for '${schemaName}.${tableName}'`,
				StatusCode.UNSUPPORTED,
			);
		}

		// Collect affected overlays before the underlying schema is mutated.
		const suffix = `:${schemaName}.${tableName}`.toLowerCase();
		const affected: [string, ConnectionOverlayState][] = [];
		for (const [key, state] of this.connectionOverlays.entries()) {
			if (key.endsWith(suffix)) {
				affected.push([key, state]);
			}
		}

		// For dropColumn we need the pre-alter column index, readable from any overlay schema.
		let dropColumnIdx: number | undefined;
		if (change.type === 'dropColumn' && affected.length > 0) {
			const overlaySchema = affected[0][1].overlayTable.tableSchema;
			dropColumnIdx = overlaySchema?.columnIndexMap.get(change.columnName.toLowerCase());
		}

		const updated = await this.underlying.alterTable(db, schemaName, tableName, change);

		// Migrate each affected overlay to the new schema, preserving staged rows.
		for (const [key, oldState] of affected) {
			const newState = await this.migrateOverlayForAlter(db, oldState, updated, change, dropColumnIdx);
			this.connectionOverlays.set(key, newState);
		}

		return updated;
	}

	/**
	 * Renames a table through the isolation layer.
	 *
	 * Forwards to the underlying module so it can re-key its handles and move
	 * any physical storage, then re-keys our own tracking maps so subsequent
	 * connect() calls under the new name find the existing underlying state
	 * and any in-flight per-connection overlays.
	 *
	 * Done in this order so a failure in the underlying rename leaves our
	 * internal maps untouched (the engine will not update the schema catalog
	 * if this method throws).
	 */
	async renameTable(
		db: Database,
		schemaName: string,
		oldName: string,
		newName: string,
	): Promise<void> {
		if (this.underlying.renameTable) {
			await this.underlying.renameTable(db, schemaName, oldName, newName);
		}

		// Drop our cached underlying VirtualTable for the old name. It may have
		// been disconnected by the underlying module (e.g. StoreModule closes
		// and re-opens stores during rename), so reusing it would yield "store
		// is closed" errors. The next connect() under the new name will fetch a
		// fresh underlying table from the underlying module.
		this.removeUnderlyingState(schemaName, oldName);

		// Re-key per-connection overlay and savepoint state, preserving the
		// connection-id prefix so overlays created earlier in an open
		// transaction remain visible under the new name.
		this.rekeyConnectionScopedMap(this.connectionOverlays, schemaName, oldName, newName);
		this.rekeyConnectionScopedMap(this.preOverlaySavepoints, schemaName, oldName, newName);
	}

	/**
	 * Re-keys all entries of a connection-scoped map (`<dbId>:<schema>.<table>`)
	 * from oldName to newName, leaving entries for other tables untouched.
	 */
	private rekeyConnectionScopedMap<V>(
		map: Map<string, V>,
		schemaName: string,
		oldName: string,
		newName: string,
	): void {
		const oldSuffix = `:${schemaName}.${oldName}`.toLowerCase();
		const newSuffix = `:${schemaName}.${newName}`.toLowerCase();
		const moved: Array<[string, V]> = [];
		for (const [key, value] of map.entries()) {
			if (key.endsWith(oldSuffix)) {
				const prefix = key.substring(0, key.length - oldSuffix.length);
				moved.push([`${prefix}${newSuffix}`, value]);
				map.delete(key);
			}
		}
		for (const [newKey, value] of moved) {
			map.set(newKey, value);
		}
	}

	/**
	 * Rebuilds an overlay table under the post-alter schema, translating each
	 * staged row to the new column layout.
	 */
	private async migrateOverlayForAlter(
		db: Database,
		oldState: ConnectionOverlayState,
		updatedSchema: TableSchema,
		change: SchemaChangeInfo,
		dropColumnIdx: number | undefined,
	): Promise<ConnectionOverlayState> {
		const oldOverlay = oldState.overlayTable;
		const oldOverlaySchema = oldOverlay.tableSchema;

		const newOverlaySchema = this.createOverlaySchema(updatedSchema);
		const newOverlayTable = await this.overlayModule.create(db, newOverlaySchema);

		if (oldState.hasChanges && oldOverlaySchema && oldOverlay.query) {
			const oldTombstoneIdx = oldOverlaySchema.columnIndexMap.get(this.tombstoneColumn.toLowerCase());
			if (oldTombstoneIdx === undefined) {
				throw new QuereusError(`Tombstone column '${this.tombstoneColumn}' missing from overlay schema`, StatusCode.INTERNAL);
			}
			for await (const oldRow of oldOverlay.query(this.makeFullScanFilterInfo())) {
				const newRow = this.translateOverlayRow(oldRow, oldTombstoneIdx, change, dropColumnIdx);
				await newOverlayTable.update({ operation: 'insert', values: newRow, preCoerced: true });
			}
		}

		return { overlayTable: newOverlayTable, hasChanges: oldState.hasChanges };
	}

	/**
	 * Translates a single overlay row from the pre-alter to the post-alter column layout.
	 * The tombstone value is preserved in the last position.
	 */
	private translateOverlayRow(
		oldRow: Row,
		oldTombstoneIdx: number,
		change: SchemaChangeInfo,
		dropColumnIdx: number | undefined,
	): SqlValue[] {
		const tombstoneValue = oldRow[oldTombstoneIdx] as SqlValue;
		const data = Array.from(oldRow.slice(0, oldTombstoneIdx)) as SqlValue[];

		let newData: SqlValue[];
		switch (change.type) {
			case 'addColumn':
				// New column is always appended after existing data columns.
				newData = [...data, null];
				break;
			case 'dropColumn':
				newData = dropColumnIdx !== undefined
					? [...data.slice(0, dropColumnIdx), ...data.slice(dropColumnIdx + 1)]
					: data;
				break;
			case 'renameColumn':
			case 'alterColumn':
			case 'alterPrimaryKey':
				newData = data;
				break;
			default: {
				const _exhaustive: never = change;
				newData = data;
			}
		}

		return [...newData, tombstoneValue];
	}

	/** Creates a FilterInfo for a full table scan (no constraints). */
	private makeFullScanFilterInfo(): FilterInfo {
		return {
			idxNum: 0,
			idxStr: null,
			constraints: [],
			args: [],
			indexInfoOutput: {
				nConstraint: 0,
				aConstraint: [],
				nOrderBy: 0,
				aOrderBy: [],
				colUsed: 0n,
				aConstraintUsage: [],
				idxNum: 0,
				idxStr: null,
				orderByConsumed: false,
				estimatedCost: 1000000,
				estimatedRows: 1000000n,
				idxFlags: 0,
			},
		};
	}

	/**
	 * Creates overlay schema from underlying schema.
	 * Adds tombstone column and uses unique name to avoid conflicts.
	 *
	 * Called by IsolatedTable when lazily creating its overlay.
	 */
	createOverlaySchema(baseSchema: TableSchema): TableSchema {
		const tombstoneColumn = {
			name: this.tombstoneColumn,
			logicalType: {
				name: 'INTEGER',
				physicalType: PhysicalType.INTEGER,
			},
			notNull: true,
			primaryKey: false,
			pkOrder: 0,
			defaultValue: null,
			collation: 'BINARY',
			generated: false,
		};

		const newColumns = [...baseSchema.columns, tombstoneColumn];
		const newColumnIndexMap = new Map(baseSchema.columnIndexMap);
		newColumnIndexMap.set(this.tombstoneColumn.toLowerCase(), newColumns.length - 1);

		// Use unique ID to avoid conflicts when multiple overlays exist
		const overlayId = generateOverlayId();

		return {
			...baseSchema,
			name: `_overlay_${baseSchema.name}_${overlayId}`,
			columns: newColumns,
			columnIndexMap: newColumnIndexMap,
			// Copy indexes - they'll be created on the overlay table
			indexes: baseSchema.indexes,
		};
	}
}
