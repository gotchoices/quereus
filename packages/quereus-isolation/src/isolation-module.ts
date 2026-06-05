import type { Database, VirtualTableModule, BaseModuleConfig, TableSchema, TableIndexSchema as IndexSchema, ModuleCapabilities, VirtualTable, BestAccessPlanRequest, BestAccessPlanResult, SchemaChangeInfo, FilterInfo, Row, SqlValue, Schema, MappingAdvertisement, LensDeploymentSnapshot, VtabConcurrencyMode, VirtualTableConnection } from '@quereus/quereus';
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
 * Concurrency-mode strength ranking: weakest → strongest.
 * `'serial'` (0) tolerates the least; `'fully-reentrant'` (2) the most.
 * Used by {@link weakerMode} / {@link clampToReentrantReads} to compute the
 * mode `IsolationModule` forwards (see `IsolationModule.concurrencyMode`).
 */
const MODE_RANK: Record<VtabConcurrencyMode, number> = {
	serial: 0,
	'reentrant-reads': 1,
	'fully-reentrant': 2,
};

/**
 * Returns the weaker (lower-rank) of two concurrency modes. A merged read
 * through `IsolationModule` touches BOTH the underlying and the overlay table,
 * so it is only as concurrency-safe as the weaker of the two.
 */
export function weakerMode(a: VtabConcurrencyMode, b: VtabConcurrencyMode): VtabConcurrencyMode {
	return MODE_RANK[a] <= MODE_RANK[b] ? a : b;
}

/**
 * Caps a mode at `'reentrant-reads'`. `IsolationModule`'s own write path
 * (`IsolatedTable.update` → `ensureOverlay`, `setHasChanges`, the multi-step
 * merged-conflict checks, the savepoint sets) mutates shared per-connection
 * state non-atomically, so the wrapper is never `'fully-reentrant'` no matter
 * how reentrant the underlying/overlay are. This is the single place that
 * invariant is enforced.
 */
export function clampToReentrantReads(mode: VtabConcurrencyMode): VtabConcurrencyMode {
	return MODE_RANK[mode] > MODE_RANK['reentrant-reads'] ? 'reentrant-reads' : mode;
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

	/**
	 * In-flight covering-connection builds, keyed identically to
	 * {@link connectionOverlays} (`<dbId>:<schema>.<table>` via
	 * {@link makeConnectionOverlayKey}). Connection registration is a
	 * per-connection (per-db+table) invariant, not a per-wrapper one, so the memo
	 * lives here — at the layer that spans every `IsolatedTable` wrapper for one
	 * (db, table) — rather than on the wrapper instance.
	 *
	 * `IsolatedTable.ensureConnection()` `await`s the overlay `createConnection()`
	 * / the database `registerConnection()` between its covering-reuse lookup and
	 * the `registeredConnection` set. This module forwards `'reentrant-reads'` (see
	 * {@link concurrencyMode}), so the runtime may drive two concurrent
	 * merged-overlay scans of one table — and it connects a FRESH `IsolatedTable`
	 * per scan (see {@link connect}), so the two scans land on DISTINCT wrapper
	 * instances. A per-wrapper memo cannot coalesce them: both see
	 * `registeredConnection === null`, both miss the existing-covering lookup, both
	 * `registerConnection` — double-registering, which makes
	 * `DeferredConstraintQueue.findConnection()` throw on multiple covering
	 * candidates. Keying the memo per (db, table) coalesces across wrappers: the
	 * first scan to enter creates the build promise; concurrent peers `await` it
	 * and resolve to the SAME covering connection. Typed in
	 * `VirtualTableConnection` terms (not `IsolatedConnection`) to keep this module
	 * free of an `isolated-connection` import; the resolved value is an
	 * `IsolatedConnection`. Mirrors `LaminaTable.connectionInFlight`.
	 */
	private readonly connectionInFlight = new Map<string, Promise<VirtualTableConnection>>();

	constructor(config: IsolationModuleConfig) {
		this.underlying = config.underlying;
		this.overlayModule = config.overlay ?? new MemoryTableModule();
		this.tombstoneColumn = config.tombstoneColumn ?? '_tombstone';
	}

	/**
	 * Forwards a concurrency-mode hint so a host that wraps a reentrant module
	 * in `IsolationModule` keeps the plan-level `concurrencySafe` it would get
	 * registering the underlying directly (read by
	 * `TableReferenceNode.computePhysical` via `getModuleConcurrencyMode`).
	 *
	 * Merged reads touch BOTH the underlying table and the overlay table (a
	 * `MemoryTable` by default, or a host-injected `config.overlay`), so the
	 * forwarded mode is the {@link weakerMode weaker} of the two — a serial
	 * underlying OR a serial custom overlay degrades the whole wrapper to
	 * `'serial'`. The result is then {@link clampToReentrantReads capped} at
	 * `'reentrant-reads'`: `IsolationModule`'s write path is never reentrant.
	 *
	 * A live getter (not a construction-time snapshot): the underlying's mode is
	 * a static module property today, but mirroring `expectedLatencyMs` — whose
	 * value is learned lazily at connect time — keeps both forwards reading live
	 * each plan. Always returns a concrete value (never `undefined`), satisfying
	 * the optional `concurrencyMode?` under `exactOptionalPropertyTypes`.
	 */
	get concurrencyMode(): VtabConcurrencyMode {
		const underlying = this.underlying.concurrencyMode ?? 'serial';
		const overlay = this.overlayModule.concurrencyMode ?? 'serial';
		return clampToReentrantReads(weakerMode(underlying, overlay));
	}

	/**
	 * Forwards the underlying module's first-row-latency planner hint so a cold
	 * `NodeFsProvider` / OPFS install's scan node carries the latency estimate
	 * through the wrapper (read by `TableReferenceNode.computePhysical`, which
	 * only lifts the value when `> 0`). The overlay is an in-memory staging table
	 * with no meaningful latency, so only the underlying contributes.
	 *
	 * Returns `0` (never `undefined`) when the underlying declares none — `0` is
	 * observably identical to omitting the hint, and a concrete value satisfies
	 * the optional `expectedLatencyMs?` under `exactOptionalPropertyTypes`. A
	 * getter, not a stored field: `LaminaModule.expectedLatencyMs` is itself a
	 * getter whose value is learned lazily at connect time, so a construction-time
	 * snapshot would capture a stale `0`.
	 */
	get expectedLatencyMs(): number {
		return this.underlying.expectedLatencyMs ?? 0;
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
	 * Coalesces concurrent covering-connection builds for one (db, table) onto a
	 * single in-flight promise, keyed identically to {@link connectionOverlays}
	 * (see {@link connectionInFlight}).
	 *
	 * On a cache hit, returns the existing in-flight build so a concurrent peer
	 * resolves to the SAME covering connection. On a miss, calls `build()` and
	 * stores the returned promise with **no `await` between the `get` and the
	 * `set`** — `build()` runs its synchronous prefix (including the
	 * covering-reuse lookup) and returns at its first `await`, so a second caller
	 * cannot interleave into the synchronous get→set region and always observes
	 * the populated memo. This holds regardless of where the build's internal
	 * `await`s fall or how microtasks order.
	 *
	 * The memo is cleared on settle (fulfil AND reject), identity-guarded so a
	 * later rebuild's promise is never clobbered by an earlier build's clear — a
	 * failed build must let the next read retry.
	 */
	coalesceConnectionBuild(
		db: Database,
		schemaName: string,
		tableName: string,
		build: () => Promise<VirtualTableConnection>,
	): Promise<VirtualTableConnection> {
		const key = this.makeConnectionOverlayKey(db, schemaName, tableName);
		const existing = this.connectionInFlight.get(key);
		if (existing) return existing;

		const inFlight = build();
		this.connectionInFlight.set(key, inFlight);
		const clear = (): void => {
			if (this.connectionInFlight.get(key) === inFlight) this.connectionInFlight.delete(key);
		};
		inFlight.then(clear, clear);
		return inFlight;
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
	 * Forwards mapping-advertisement discovery to the underlying module.
	 *
	 * The lens compiler's advertisement resolver reaches a basis table's
	 * `vtabModule` — which is this wrapper when a memory/store basis is isolated —
	 * and calls the optional `getMappingAdvertisements` hook. A decomposition's
	 * storage/access shape is a property of the underlying basis relations and is
	 * isolation-transparent (the overlay does not change the decomposition shape),
	 * so a straight delegate is correct. Without this forward, `quereus.lens.decomp.*`
	 * tags on isolation-wrapped basis tables are silently dropped and a logical
	 * table over the decomposition fails body compilation with "no basis backing".
	 */
	getMappingAdvertisements(db: Database, basisSchema: Schema): readonly MappingAdvertisement[] {
		return this.underlying.getMappingAdvertisements?.(db, basisSchema) ?? [];
	}

	/**
	 * Forwards APPLY SCHEMA's batch-begin signal to the underlying module.
	 *
	 * APPLY SCHEMA's migration loop fires `beginSchemaBatch`/`endSchemaBatch`
	 * on the *registered* module that owns each table — which is this wrapper
	 * when a basis is isolated. A batching-capable underlying module folds the
	 * whole APPLY SCHEMA into a single substrate commit by opening a batch here
	 * that its subsequent create/destroy/alter callbacks (which IsolationModule
	 * forwards to the underlying) join. Without this forward the underlying is
	 * never reached and silently falls back to per-DDL commits.
	 *
	 * This is a straight delegate to the underlying: APPLY SCHEMA migrations are
	 * DDL against the underlying substrate, not staged data writes, so the
	 * per-connection overlays do not participate. Overlays hold uncommitted
	 * *data* writes inside a user transaction; schema DDL does not route through
	 * them, so there is nothing for the overlay/commit lifecycle to flush as
	 * part of the batch.
	 */
	async beginSchemaBatch(db: Database, schemaName: string): Promise<void> {
		await this.underlying.beginSchemaBatch?.(db, schemaName);
	}

	/**
	 * Forwards APPLY SCHEMA's batch-end signal to the underlying module.
	 * See `beginSchemaBatch` for why a straight delegate is correct.
	 */
	async endSchemaBatch(db: Database, schemaName: string, error?: unknown): Promise<void> {
		await this.underlying.endSchemaBatch?.(db, schemaName, error);
	}

	/**
	 * Forwards APPLY SCHEMA's lens deployment notification to the underlying module.
	 *
	 * A logical `apply schema X` fires `notifyLensDeployment` on the *registered*
	 * module (this wrapper when a basis is isolated), handing it the freshly
	 * deployed `LensDeploymentSnapshot` so a basis-backing module can reconcile its
	 * storage against the new lens. The deployed lens shape is a property of the
	 * declared logical/basis schemas and is isolation-transparent (the overlay does
	 * not change it), so a straight delegate is correct — mirroring the
	 * `getMappingAdvertisements` forward. Without this forward an isolation-wrapped
	 * basis module would silently never hear the deployment.
	 */
	async notifyLensDeployment(db: Database, logicalSchemaName: string, snapshot: LensDeploymentSnapshot): Promise<void> {
		await this.underlying.notifyLensDeployment?.(db, logicalSchemaName, snapshot);
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
	 * Drops an index on the underlying table.
	 *
	 * Mirrors createIndex: when the underlying VirtualTable exposes an
	 * instance-level dropIndex (e.g. MemoryTable, which forwards to its manager
	 * so MemoryTable.tableSchema stays fresh), prefer that. Otherwise fall back
	 * to the module-level dropIndex (e.g. StoreModule, which refreshes the
	 * StoreTable's cached tableSchema and tears down the index store).
	 *
	 * Any per-connection overlay that already exists for this table is
	 * rebuilt under the post-drop schema, preserving staged rows. A bare
	 * forward to `overlay.dropIndex` is insufficient: when the overlay's
	 * MemoryTable has an active write `TransactionLayer`, its
	 * `tableSchemaAtCreation` is frozen at layer-creation time, so the
	 * synthesized UNIQUE constraint keeps firing inside the overlay's
	 * own UC check on the next write even after the manager's schema is
	 * refreshed. Rebuilding gives the new MemoryTable a fresh
	 * transaction layer that captures the post-drop schema. Overlays
	 * created AFTER this point inherit the post-drop schema from the
	 * underlying at ensureOverlay time.
	 */
	async dropIndex(
		db: Database,
		schemaName: string,
		tableName: string,
		indexName: string
	): Promise<void> {
		const state = this.getUnderlyingState(schemaName, tableName);
		if (state?.underlyingTable.dropIndex) {
			await state.underlyingTable.dropIndex(indexName);
		} else if (this.underlying.dropIndex) {
			await this.underlying.dropIndex(db, schemaName, tableName, indexName);
		}

		// After the underlying drop, state.underlyingTable.tableSchema reflects the
		// post-drop schema. Rebuild every affected overlay against that schema so
		// the synthesized UC is fully gone from the overlay's transaction layer.
		const updatedSchema = state?.underlyingTable.tableSchema;
		if (!updatedSchema) return;

		const suffix = `:${schemaName}.${tableName}`.toLowerCase();
		for (const [key, overlayState] of this.connectionOverlays.entries()) {
			if (key.endsWith(suffix)) {
				const newState = await this.migrateOverlayForDropIndex(db, overlayState, updatedSchema);
				this.connectionOverlays.set(key, newState);
			}
		}
	}

	/**
	 * Rebuilds an overlay table under the post-drop-index schema, preserving
	 * staged rows (including tombstones). Column layout is unchanged by
	 * DROP INDEX, so rows can be copied verbatim.
	 */
	private async migrateOverlayForDropIndex(
		db: Database,
		oldState: ConnectionOverlayState,
		updatedSchema: TableSchema,
	): Promise<ConnectionOverlayState> {
		const oldOverlay = oldState.overlayTable;

		const newOverlaySchema = this.createOverlaySchema(updatedSchema);
		const newOverlayTable = await this.overlayModule.create(db, newOverlaySchema);

		if (oldState.hasChanges && oldOverlay.query) {
			for await (const oldRow of oldOverlay.query(this.makeFullScanFilterInfo())) {
				await newOverlayTable.update({ operation: 'insert', values: oldRow as SqlValue[], preCoerced: true });
			}
		}

		return { overlayTable: newOverlayTable, hasChanges: oldState.hasChanges };
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
			case 'addConstraint':
			case 'dropConstraint':
			case 'renameConstraint':
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
