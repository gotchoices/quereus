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
	DatabaseInternal,
	TableSchema,
	TableIndexSchema,
	UniqueConstraintSchema,
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
	SchemaChangeEvent as EngineSchemaChangeEvent,
	ViewSchema,
	MaintainedTableSchema,
	BackingHost,
	LensDeploymentSnapshot,
} from '@quereus/quereus';
import { AccessPlanBuilder, QuereusError, StatusCode, buildColumnIndexMap, columnDefToSchema, compilePredicate, inferType, tryFoldLiteral, validateAndParse, buildAdvertisementsFromTags, resolveNamedConstraintClass, validateCollationForType, buildUniqueConstraintSchema, buildForeignKeyConstraintSchema, buildCheckConstraintSchema, validateForeignKeyOverExistingRows, extractColumnLevelCheckConstraints, extractColumnLevelForeignKeys, appendIndexToTableSchema, resolveKeyNormalizer, serializeRowKey, isMaintainedTable } from '@quereus/quereus';
import type { CompiledPredicate } from '@quereus/quereus';

import type { KVStore, KVStoreProvider } from './kv-store.js';
import type { StoreEventEmitter } from './events.js';
import { TransactionCoordinator } from './transaction.js';
import { StoreBackingHost } from './backing-host.js';
import { StoreTable, resolvePkKeyCollations, type StoreTableConfig, type StoreTableModule } from './store-table.js';
import {
	buildCatalogKey,
	buildCatalogScanBounds,
	buildDataStoreName,
	buildIndexKey,
	buildIndexStoreName,
	buildFullScanBounds,
	buildStatsKey,
	buildViewCatalogKey,
	buildMaterializedViewCatalogKey,
	parseMaterializedViewCatalogKey,
	buildMetaCatalogKey,
	CLEAN_SHUTDOWN_META_NAME,
	classifyCatalogKey,
} from './key-builder.js';
import { deserializeRow } from './serialization.js';
import { generateTableDDL, generateIndexDDL, generateViewDDL, generateMaintainedTableDDL, generateIndexTagsDDL, isHiddenImplicitIndex, exposedImplicitIndexes } from '@quereus/quereus';

/**
 * Result of catalog rehydration.
 *
 * `views` / `materializedViews` are additive (existing consumers — e.g.
 * `quoomb-web` — read only `.errors`). Errors from any phase land in `errors`.
 */
export interface RehydrationResult {
	tables: string[];
	indexes: string[];
	views: string[];
	materializedViews: string[];
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
 * Listener the host binds via {@link StoreModule.setLensDeploymentListener} to
 * forward a logical `apply schema` lens deployment onward (typically to the sync
 * layer's basis-table lifecycle bookkeeping). Kept as a plain callback so
 * `@quereus/store` stays free of a `@quereus/sync` dependency; the worker — which
 * depends on both — wires the two together.
 */
export type LensDeploymentListener = (
	db: Database,
	logicalSchemaName: string,
	snapshot: LensDeploymentSnapshot,
) => void | Promise<void>;

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
	/**
	 * The single transaction coordinator shared by every {@link StoreTable} this
	 * module owns — the unit of cross-table atomicity (see {@link getCoordinator}).
	 * Lives for the module's lifetime: a single table's drop must NOT evict it
	 * (sibling tables still use it); only {@link closeAll} clears it.
	 */
	private moduleCoordinator?: TransactionCoordinator;
	private tables: Map<string, StoreTable> = new Map();
	private eventEmitter?: StoreEventEmitter;

	/**
	 * Optional listener wired by the host (the worker) to forward a logical
	 * `apply schema` lens deployment to the sync layer's lifecycle bookkeeping.
	 * The store module is the only basis-backing host with both persistence and a
	 * `db` handle, so it is the forwarder; `@quereus/store` must not depend on
	 * `@quereus/sync`, so the listener is a plain callback the worker binds.
	 */
	private lensDeploymentListener?: LensDeploymentListener;

	/** Unsubscribe thunk for the engine `SchemaChangeNotifier` listener, set on first hook with a `db`. */
	private schemaListenerUnsub?: () => void;
	/** The `Database` whose notifier we subscribed to. One module instance serves one `Database`. */
	private subscribedDb?: Database;
	/**
	 * Serialized chain of pending catalog writes triggered by engine schema-change
	 * events (catalog-only tag swaps). `notifyChange` invokes listeners synchronously
	 * and does not await them, so the actual read-compare-write runs here, in order,
	 * and is drained by `closeAll` (and `whenCatalogPersisted`) before the provider closes.
	 */
	private persistQueue: Promise<unknown> = Promise.resolve();

	constructor(provider: KVStoreProvider, eventEmitter?: StoreEventEmitter) {
		this.provider = provider;
		this.eventEmitter = eventEmitter;
	}

	/**
	 * Returns capability flags for this module.
	 *
	 * The base StoreModule does NOT provide transaction isolation: there is no
	 * snapshot isolation and no cross-connection isolation (readers on other
	 * connections see only committed data). Within a transaction, reads through
	 * the table's shared coordinator DO see that transaction's own pending
	 * writes (read-your-own-writes — `StoreTable.query` merges the pending op
	 * view over the committed store). For full isolation, wrap with
	 * IsolationModule:
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
			// Coordinator-buffered ops support savepoint create/release/rollback-to
			// within a transaction (advisory flag — not engine-consulted).
			savepoints: true,
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
	 * Backing-host capability (engine `vtab/backing-host.ts`): resolve the
	 * privileged surface for a store table this module owns, or undefined when the
	 * table is unknown to it. The host binds the CURRENT (StoreTable, coordinator)
	 * pair — `destroy` evicts both maps, so a drop+recreate yields fresh instances
	 * and the returned host is pinned to one backing-table incarnation (the engine
	 * resolves hosts fresh per call, never caching them). Resolution goes through
	 * {@link getOrReconnectTable} so a rehydrated-but-untouched (or rename-evicted)
	 * backing still resolves; the ownership pre-check keeps the reconnect fallback
	 * from adopting a registered table owned by a different module (`vtabModule`
	 * must be this StoreModule, or a wrapper — IsolationModule — exposing it as
	 * `underlying`). Attaching the coordinator eagerly makes the shared
	 * StoreTable's read paths merge the host's pending writes (reads-own-writes
	 * for a `select` from the MV mid-transaction).
	 */
	getBackingHost(db: Database, schemaName: string, tableName: string): BackingHost | undefined {
		const table = this.resolveOwnedTable(db, schemaName, tableName);
		if (!table) return undefined;
		return new StoreBackingHost(table, table.attachCoordinator());
	}

	/**
	 * Resolve a {@link StoreTable} this module owns, reconnecting a
	 * rehydrated-but-untouched (or rename-evicted) table via
	 * {@link getOrReconnectTable}. The ownership pre-check keeps the reconnect
	 * fallback from adopting a registered table owned by a DIFFERENT module:
	 * `vtabModule` must be this StoreModule, or a wrapper (IsolationModule)
	 * exposing it as `underlying`. Returns undefined for an unknown/non-owned
	 * table. Shared by {@link getBackingHost} and
	 * {@link getTableForExternalWrite}; neither attaches a coordinator here —
	 * each layers its own pending-state policy on top.
	 */
	private resolveOwnedTable(db: Database, schemaName: string, tableName: string): StoreTable | undefined {
		const tableKey = `${schemaName}.${tableName}`.toLowerCase();
		if (!this.tables.has(tableKey)) {
			const registered = db.schemaManager.getTable(schemaName, tableName);
			const wrapper = registered?.vtabModule as { underlying?: unknown } | undefined;
			if (!registered || (registered.vtabModule !== this && wrapper?.underlying !== this)) {
				return undefined;
			}
		}
		return this.getOrReconnectTable(db, schemaName, tableName);
	}

	/**
	 * Resolve the live {@link StoreTable} for an externally-applied write to a
	 * SOURCE table (committed put/delete + secondary-index + stats maintenance via
	 * {@link StoreTable.applyExternalRowChanges}). Returns undefined when the table
	 * is not this module's.
	 *
	 * Resolution goes through {@link resolveOwnedTable} (the shared ownership
	 * pre-check + reconnect fallback). Unlike `getBackingHost` it attaches no
	 * coordinator: external writes target committed storage, and the before-image
	 * read (`readEffectiveRowByKey`) merges any already-attached coordinator's
	 * pending state on its own (none when the table is freshly reconnected).
	 */
	getTableForExternalWrite(db: Database, schemaName: string, tableName: string): StoreTable | undefined {
		return this.resolveOwnedTable(db, schemaName, tableName);
	}

	/**
	 * Get the event emitter for this module.
	 */
	getEventEmitter(): StoreEventEmitter | undefined {
		return this.eventEmitter;
	}

	/**
	 * Bind (or clear, with `undefined`) the lens-deployment forwarder. The host
	 * (worker) calls this to route a logical `apply schema`'s deployment to the
	 * sync layer; see {@link notifyLensDeployment}.
	 */
	setLensDeploymentListener(listener: LensDeploymentListener | undefined): void {
		this.lensDeploymentListener = listener;
	}

	/**
	 * Engine `notifyLensDeployment` hook: a logical `apply schema X` fires this on
	 * every registered module once the lens catalog mutation + snapshot rotation
	 * complete (see `VirtualTableModule.notifyLensDeployment`). The store module —
	 * the basis-backing host — forwards the deployment to the bound listener so the
	 * sync layer can update its basis-table lifecycle bookkeeping.
	 *
	 * INVERSION OF THE ENGINE FIRING CONTRACT: the engine documents that a throwing
	 * notification aborts `apply schema X`. We deliberately wrap the listener in
	 * try/catch and SWALLOW (structured-log only) here — lifecycle bookkeeping is
	 * advisory and must never brick a schema apply. A bookkeeping bug is a logged
	 * warning, not a failed deploy.
	 */
	async notifyLensDeployment(
		db: Database,
		logicalSchemaName: string,
		snapshot: LensDeploymentSnapshot,
	): Promise<void> {
		if (!this.lensDeploymentListener) return;
		try {
			await this.lensDeploymentListener(db, logicalSchemaName, snapshot);
		} catch (e) {
			// Advisory bookkeeping — swallow so a listener bug cannot abort the deploy.
			console.warn(
				`[StoreModule] lens-deployment listener failed for logical schema '${logicalSchemaName}'; `
					+ `lifecycle bookkeeping skipped: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}

	/**
	 * Get the KVStoreProvider used by this module.
	 */
	getProvider(): KVStoreProvider {
		return this.provider;
	}

	/**
	 * Build the set of physical store names this module's data/index stores
	 * currently occupy in `schemaName`, mapping each name to a human description
	 * of the logical object that owns it (for sited collision messages).
	 *
	 * Physical store names are built by string concatenation (`{schema}.{table}` /
	 * `{schema}.{table}_idx_{index}`) and the `_idx_` delimiter is itself a legal
	 * substring of any identifier, so two distinct logical objects (e.g. index
	 * `archive` on `t` and a sibling table `t_idx_archive`) can collapse to the
	 * same physical name. This set is the authoritative occupancy used by
	 * {@link assertStoreNameFree} to reject such a collision at CREATE time.
	 *
	 * The occupancy is the union of two sources, robust to lazy connection and the
	 * isolation wrapper (see the ticket's "Enumeration source" section):
	 *   1. `this.tables` — every store table this module touched this session.
	 *   2. the target schema's catalog tables whose `vtabModule === this` and which
	 *      are not views — store-backed tables not yet lazily connected.
	 * Names embed the schema prefix, so cross-schema entries never collide and no
	 * per-schema filter on `this.tables` is needed. Memory-backed siblings and
	 * views own no store in this provider and are excluded (the `=== this` /
	 * `!isView` filter) to avoid false-positive rejects.
	 *
	 * No self-exclusion: at each guarded call the candidate object is not yet
	 * registered (create/createIndex run before the engine adds it) so it cannot
	 * self-collide; and for renameTable the renamed table's OWN stores stay in the
	 * set deliberately. Any overlap between a name the rename introduces and an
	 * own current store is a footprint-swap rename (`t` with index `x` → `t_idx_x`,
	 * or table `u_idx_x` with index `x` → `u`) that providers cannot relocate
	 * safely — relocation order determines whether a source is clobbered before it
	 * is moved — while no benign rename produces such an overlap. Keeping own
	 * stores in the set therefore causes no false rejects and keeps the
	 * reject-before-any-side-effect guarantee uniform.
	 */
	private collectOccupiedStoreNames(db: Database, schemaName: string): Map<string, string> {
		const names = new Map<string, string>();
		const add = (s: TableSchema) => {
			const dataName = buildDataStoreName(s.schemaName, s.name);
			if (!names.has(dataName)) {
				names.set(dataName, `data store of table '${s.schemaName}.${s.name}'`);
			}
			for (const idx of s.indexes ?? []) {
				const idxName = buildIndexStoreName(s.schemaName, s.name, idx.name);
				if (!names.has(idxName)) {
					names.set(idxName, `index store of index '${idx.name}' on table '${s.schemaName}.${s.name}'`);
				}
			}
		};
		for (const t of this.tables.values()) {
			add(t.getSchema());
		}
		for (const t of db.schemaManager.getSchemaOrFail(schemaName).getAllTables()) {
			if (t.vtabModule !== this || t.isView) continue;
			add(t);
		}
		return names;
	}

	/**
	 * Throws `StatusCode.ERROR` when `candidate` (a physical store name produced by
	 * the key-builder for an object about to be created/renamed) already names an
	 * existing data or index store in `schemaName`. `candidateDesc` describes the
	 * incoming logical object; the message names the candidate physical store and
	 * both conflicting logical objects and is actionable (rename one of them).
	 *
	 * Must run BEFORE any storage side-effect (`getStore` / `getIndexStore` / the
	 * physical relocation): the provider opens/creates the store eagerly, so a
	 * guard that ran after would already have aliased the colliding object's store.
	 *
	 * Callers checking several candidates against the same occupancy (renameTable
	 * checks the new data store plus every relocated index store) pass a
	 * precomputed `occupied` map so the occupancy is collected once, not per call.
	 */
	private assertStoreNameFree(
		db: Database,
		schemaName: string,
		candidate: string,
		candidateDesc: string,
		occupied?: Map<string, string>,
	): void {
		const occupiedBy = (occupied ?? this.collectOccupiedStoreNames(db, schemaName)).get(candidate);
		if (occupiedBy !== undefined) {
			throw new QuereusError(
				`Physical store-name collision: the ${candidateDesc} would map to physical store `
					+ `'${candidate}', which already backs the ${occupiedBy}. These two objects would `
					+ `share one physical store and silently corrupt each other. Rename the table or the `
					+ `colliding index.`,
				StatusCode.ERROR,
			);
		}
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
		this.ensureSchemaSubscription(db);
		const tableKey = `${tableSchema.schemaName}.${tableSchema.name}`.toLowerCase();

		if (this.tables.has(tableKey)) {
			throw new QuereusError(
				`Store table '${tableSchema.name}' already exists in schema '${tableSchema.schemaName}'`,
				StatusCode.ERROR
			);
		}

		const config = this.parseConfig(tableSchema.vtabArgs as Record<string, SqlValue> | undefined);

		// Apply the store's default key collation K to any IMPLICIT-default text PK column
		// (an explicit per-column PK collation is honored natively by the per-column key
		// encoding — see reconcilePkCollations / StoreTable.pkKeyCollations). The reconciled
		// schema is what StoreTable holds and what `finalizeCreatedTableSchema` registers, so
		// an undecorated text PK reports/keys under K rather than the engine BINARY default.
		const keyCollation = (config.collation || 'NOCASE').toUpperCase();
		const reconciledSchema = reconcilePkCollations(tableSchema, keyCollation);

		// Reject when this new table's physical data store name already names an
		// existing store (the only real positive here is data-vs-index: a sibling
		// index store `{schema}.t_idx_<x>` already occupies `{schema}.{thisTable}` —
		// data-vs-data is prevented by engine table-name uniqueness). Must precede
		// `getStore`, which eagerly opens/creates the directory.
		const dataStoreName = buildDataStoreName(tableSchema.schemaName, tableSchema.name);
		this.assertStoreNameFree(
			db,
			tableSchema.schemaName,
			dataStoreName,
			`data store of new table '${tableSchema.schemaName}.${tableSchema.name}'`,
		);

		// Eagerly initialize the store BEFORE creating the table or emitting events.
		// This ensures the underlying storage (e.g., IndexedDB object store) exists
		// before any schema change handlers try to access it.
		const store = await this.provider.getStore(tableSchema.schemaName, tableSchema.name);
		this.stores.set(tableKey, store);

		const table = new StoreTable(
			db,
			this,
			reconciledSchema,
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
			ddl: generateTableDDL(reconciledSchema),
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
		this.ensureSchemaSubscription(db);
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

		// The load path does NOT reconcile PK collations: a persisted / hand-authored
		// DDL stays loadable as-declared. Physical key bytes are always K-encoded by
		// `StoreTable.encodeOptions`, so a legacy divergent text-PK collation is a
		// stale `table_info` declaration, not a correctness risk. Reconciling the
		// transient `StoreTable` here would be pointless anyway — `importCatalog`'s
		// post-import reconcile loop (`table.updateSchema(fresh)`) immediately
		// overwrites it with the `SchemaManager`-registered schema. A genuine
		// reopen-time migration (an engine import-path hook reconciling the
		// *registered* schema to K) was considered and deliberately not built:
		// only pre-`store-pk-collate-create-time-divergence` data can carry such a
		// DDL, and backwards compatibility is out of scope (AGENTS.md). If legacy
		// migration ever comes into scope, the fix is a module-consulted
		// normalization hook on `importCatalog`/`rehydrateCatalog`.
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
		db: Database,
		_pAux: unknown,
		_moduleName: string,
		schemaName: string,
		tableName: string
	): Promise<void> {
		const tableKey = `${schemaName}.${tableName}`.toLowerCase();

		// Capture the schema BEFORE we drop in-memory references so we can hand the
		// provider the authoritative index list (exact store names) rather than let
		// it prefix-scan `{table}_idx_`, which would also delete a sibling table
		// literally named `{table}_idx_<x>`. Prefer the cached StoreTable's own
		// schema; fall back to the schema manager (mirrors renameTable). If neither
		// yields a schema (already deregistered), fall back to [] — index stores
		// can't be swept by name then, but that is no worse than today for the
		// no-sibling case and strictly safer for the sibling case.
		const table = this.tables.get(tableKey);
		const currentSchema: TableSchema | undefined =
			table?.getSchema() ?? db.schemaManager.getTable(schemaName, tableName);
		const indexNames = (currentSchema?.indexes ?? []).map(i => i.name);

		await this.tearDownTableStorage(schemaName, tableName, indexNames);

		// Emit schema change event for table drop
		this.eventEmitter?.emitSchemaChange({
			type: 'drop',
			objectType: 'table',
			schemaName,
			objectName: tableName,
		});
	}

	/**
	 * Reclaim the local storage of a DETACHED basis table by name — the store-side
	 * target of the sync layer's basis-eviction sweep
	 * (`SyncManager.evictExpiredBasisTables`, `docs/migration.md` § 4 Contract).
	 *
	 * Unlike {@link destroy}, the table is no longer in the engine schema (it was
	 * removed from the basis on detach; only its physical storage lingered), so
	 * there is no `db`/schema to consult and NO schema-change event is emitted — the
	 * engine already saw the detach. The caller (the sync recorder) supplies the
	 * captured secondary-index name list it retained from before detach, because the
	 * table schema (and its index list) is gone: passing the exact names avoids the
	 * provider prefix-scanning `{table}_idx_`, which can clobber a sibling table
	 * literally named `{table}_idx_<x>`.
	 *
	 * Idempotent: any cached handles are evicted and disconnected, then the data /
	 * index / stats stores and the catalog DDL are removed. Storage already gone (a
	 * prior real `drop table` ran `destroy`) is treated as success — the provider's
	 * `deleteTableStores` no-ops on absent stores and `removeTableDDL` no-ops on an
	 * absent key.
	 */
	async reclaimDetachedTable(
		schemaName: string,
		tableName: string,
		indexNames: readonly string[],
	): Promise<void> {
		await this.tearDownTableStorage(schemaName, tableName, indexNames);
	}

	/**
	 * Tear down a table's in-memory handles and physical storage: evict the cached
	 * StoreTable / store / coordinator (synchronously, before any await, so a
	 * concurrent reconnect cannot observe a stale instance mid-teardown), disconnect
	 * the handle, delete the provider's data / index / stats stores (by the exact
	 * index names — never a `{table}_idx_` prefix scan, which could clobber a sibling
	 * table literally named `{table}_idx_<x>`), and remove the catalog DDL.
	 *
	 * Shared by {@link destroy} (live `drop table`) and {@link reclaimDetachedTable}
	 * (post-detach eviction). The caller owns the index-name source (live schema vs.
	 * the captured pre-detach list) and any schema-change event. Idempotent: the
	 * provider no-ops on absent stores and `removeTableDDL` no-ops on an absent key.
	 */
	private async tearDownTableStorage(
		schemaName: string,
		tableName: string,
		indexNames: readonly string[],
	): Promise<void> {
		const tableKey = `${schemaName}.${tableName}`.toLowerCase();

		const table = this.tables.get(tableKey);
		this.tables.delete(tableKey);
		this.stores.delete(tableKey);
		// NOTE: the coordinator is module-wide and shared by sibling tables, so a
		// single table's teardown must NOT evict the coordinator itself. But the
		// evicted StoreTable's stats-callback pair MUST be deregistered, or its
		// closures (capturing this instance) stay pinned on the shared coordinator
		// for the module's lifetime — a leak bounded by drop/recreate count.
		// table.dispose() both flushes pending stats and runs that disposer.
		if (table) {
			await table.dispose();
		}

		// Delete all stores for this table (data, indexes, stats)
		if (this.provider.deleteTableStores) {
			await this.provider.deleteTableStores(schemaName, tableName, indexNames);
		} else {
			// Fallback: just close the data store
			await this.provider.closeStore(schemaName, tableName);
		}

		// Remove DDL from catalog
		await this.removeTableDDL(schemaName, tableName);
	}

	/**
	 * Returns the connected StoreTable for `schemaName.tableName`, lazily
	 * reconnecting from the engine's schema registry when absent.
	 *
	 * `renameTable` evicts the old key from `this.tables` and expects the next
	 * `connect()` to repopulate under the new name, but `apply schema` can run
	 * follow-up DDL (ALTER TABLE, CREATE/DROP INDEX) against the new name
	 * without an intervening connect. Mirror connect()'s schemaManager lookup
	 * so that DDL finds the moved table. Safe for the index paths because
	 * SchemaManager calls the module BEFORE mutating the registered table
	 * schema, so the reconnected cache matches what a connected instance holds.
	 */
	private getOrReconnectTable(db: Database, schemaName: string, tableName: string): StoreTable | undefined {
		const tableKey = `${schemaName}.${tableName}`.toLowerCase();
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
		return table;
	}

	/**
	 * Creates an index on a store-backed table.
	 */
	async createIndex(
		db: Database,
		schemaName: string,
		tableName: string,
		indexSchema: TableIndexSchema
	): Promise<void> {
		const tableKey = `${schemaName}.${tableName}`.toLowerCase();
		const table = this.getOrReconnectTable(db, schemaName, tableName);

		if (!table) {
			throw new QuereusError(
				`Store table '${tableName}' not found in schema '${schemaName}'`,
				StatusCode.NOTFOUND
			);
		}

		// Reject when this new index's physical store name already names an existing
		// store: a sibling table's data store (`{schema}.t_idx_<x>` == sibling table
		// `t_idx_<x>`) or another table's index store (index-vs-index, e.g.
		// `a.b_idx_c` vs `a_idx_b.c` both → `{schema}.a_idx_b_idx_c`). The new index
		// is not yet registered in the schema or the table's cached schema at this
		// point, so the candidate cannot self-collide. Must precede `getIndexStore`,
		// which opens/creates the directory that `buildIndexEntries` then writes into.
		const indexStoreName = buildIndexStoreName(schemaName, tableName, indexSchema.name);
		this.assertStoreNameFree(
			db,
			schemaName,
			indexStoreName,
			`index store of new index '${indexSchema.name}' on table '${schemaName}.${tableName}'`,
		);

		// Create the index store
		const indexStore = await this.provider.getIndexStore(schemaName, tableName, indexSchema.name);

		// Build index entries for existing rows
		const dataStore = await this.getStore(tableKey, table.getConfig());
		const tableSchema = table.getSchema();
		const keyCollation = (table.getConfig().collation || 'NOCASE').toUpperCase();
		await this.buildIndexEntries(dataStore, indexStore, tableSchema, indexSchema, keyCollation);

		// Refresh the connected table's cached schema so subsequent DML
		// maintains the new index (the engine's schema registry is updated
		// separately by SchemaManager.createIndex, but the StoreTable instance
		// holds its own reference captured at connect time). The shared
		// appendIndexToTableSchema also synthesizes the UNIQUE → derived
		// uniqueConstraint entry so checkUniqueConstraints enforces it; the
		// `derivedFromIndex` tag lets StoreModule.dropIndex filter it back out
		// symmetrically (mirrors SchemaManager.dropIndex / MemoryTableManager.dropIndex).
		const updatedSchema = appendIndexToTableSchema(tableSchema, indexSchema);
		table.updateSchema(updatedSchema);

		// Authoritative catalog write: persist the table's bundle now (including the
		// new index), so the index survives close → reopen even when the table has
		// no rows yet and was never lazily persisted. `markDdlSaved` suppresses the
		// later lazy table-only write on first store access (StoreTable.ddlSaved), so
		// this is the only catalog write the createIndex produces. SchemaManager fires
		// a follow-up `table_modified` whose listener regenerates the SAME bundle and
		// skips (identical) — see persistCatalogIfChanged.
		await this.saveTableDDL(updatedSchema);
		table.markDdlSaved();

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
		db: Database,
		schemaName: string,
		tableName: string,
		indexName: string,
	): Promise<void> {
		const table = this.getOrReconnectTable(db, schemaName, tableName);

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

		// Rewrite the catalog bundle without the dropped index, before the physical
		// teardown — so on reopen the index does not resurrect even if the store
		// delete below fails. `markDdlSaved` keeps the lazy first-access save from
		// re-writing the same bundle. SchemaManager's follow-up `table_modified`
		// regenerates an identical bundle and skips.
		await this.saveTableDDL(updatedSchema);
		table.markDdlSaved();

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
		indexSchema: TableIndexSchema,
		keyCollation: string,
	): Promise<void> {
		// Index COLUMN values use the table-level key collation K; the PK SUFFIX uses
		// each PK column's own key collation, so the suffix bytes match the data-store
		// keys (and `StoreTable.updateSecondaryIndexes`' maintenance writes) exactly.
		const encodeOptions = { collation: keyCollation };
		const pkDirections = tableSchema.primaryKeyDefinition.map(pk => !!pk.desc);
		const pkCollations = resolvePkKeyCollations(tableSchema.primaryKeyDefinition, tableSchema.columns, keyCollation);
		const indexDirections = indexSchema.columns.map(col => !!col.desc);

		const predicate: CompiledPredicate | undefined = indexSchema.predicate
			? compilePredicate(indexSchema.predicate, tableSchema.columns)
			: undefined;
		const seen: Set<string> | undefined = indexSchema.unique ? new Set() : undefined;

		// Per-column normalizers for the in-pass UNIQUE dup check, drawing each
		// column's collation from the index column (if it carries one) else the
		// underlying table column — so the dedup signature honors a per-column
		// NOCASE/RTRIM collation, matching write-time enforcement.
		const indexColIndices = indexSchema.columns.map(col => col.index);
		const indexNormalizers = seen
			? indexSchema.columns.map(col =>
				resolveKeyNormalizer(col.collation ?? tableSchema.columns[col.index].collation))
			: undefined;

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
				// serializeRowKey returns null when any indexed column is NULL —
				// SQL UNIQUE allows multiple NULLs, so those rows never collide.
				const keySig = serializeRowKey(row, indexColIndices, indexNormalizers!);
				if (keySig !== null) {
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
				pkCollations,
			);
			batch.put(indexKey, new Uint8Array(0)); // Index value is empty
		}

		await batch.write();
	}

	/**
	 * Clear and rebuild every secondary index of `schema` against the (already
	 * re-encoded) data store. Secondary-index keys embed the PK suffix, so they must
	 * be rewritten whenever the data-store PK key bytes change — which happens both
	 * on `ALTER PRIMARY KEY` (the PK columns change) and on an `ALTER COLUMN … SET
	 * COLLATE` on a PK member (a PK column's key collation changes). Shared by both
	 * arms so the clear-then-rebuild stays identical. `schema` must already be the
	 * post-ALTER schema (its `primaryKeyDefinition` + column collations drive the new
	 * PK-suffix encoding via {@link buildIndexEntries}).
	 */
	private async rebuildSecondaryIndexes(
		schemaName: string,
		tableName: string,
		tableKey: string,
		table: StoreTable,
		schema: TableSchema,
	): Promise<void> {
		const keyCollation = (table.getConfig().collation || 'NOCASE').toUpperCase();
		const dataStore = await this.getStore(tableKey, table.getConfig());
		for (const indexSchema of schema.indexes ?? []) {
			const indexStore = await this.getIndexStore(schemaName, tableName, indexSchema.name);
			const clearBatch = indexStore.batch();
			for await (const entry of indexStore.iterate(buildFullScanBounds())) {
				clearBatch.delete(entry.key);
			}
			await clearBatch.write();
			await this.buildIndexEntries(dataStore, indexStore, schema, indexSchema, keyCollation);
		}
	}

	/**
	 * Validates the existing rows in `dataStore` against a UNIQUE constraint,
	 * throwing `CONSTRAINT` on the first duplicate before any schema mutation.
	 * Used by `ADD CONSTRAINT UNIQUE` (validate against the current collation) and
	 * by `SET COLLATE` (pass an `updatedSchema` whose altered column carries the
	 * NEW collation, so the dedup is performed under it). Mirrors the duplicate
	 * detection in {@link buildIndexEntries}: a `seen` Set keyed on a per-column
	 * collation-aware signature of the constrained values, with SQL NULL semantics
	 * (a row with any NULL constrained value never counts as a duplicate) and the
	 * partial `predicate` honored.
	 *
	 * No index store is written — store UNIQUE enforcement is a full-scan over
	 * `uniqueConstraints` at write time. The signature is built by
	 * {@link serializeRowKey} with one normalizer per constrained column drawn from
	 * `tableSchema.columns[idx].collation`, so a per-column NOCASE/RTRIM collation
	 * is honored (matching write-time `compareSqlValues` enforcement). Residual: a
	 * custom comparator-only collation has no string normalizer and falls back to
	 * BINARY for the dedup (see docs/schema.md store-collation note).
	 */
	private async validateUniqueOverExistingRows(
		dataStore: KVStore,
		tableSchema: TableSchema,
		uc: UniqueConstraintSchema,
	): Promise<void> {
		const predicate: CompiledPredicate | undefined = uc.predicate
			? compilePredicate(uc.predicate, tableSchema.columns)
			: undefined;
		const normalizers = uc.columns.map(idx => resolveKeyNormalizer(tableSchema.columns[idx].collation));
		const seen = new Set<string>();

		for await (const entry of dataStore.iterate(buildFullScanBounds())) {
			const row = deserializeRow(entry.value);

			// Partial constraint: only rows the predicate unambiguously accepts count.
			if (predicate && predicate.evaluate(row) !== true) continue;

			// serializeRowKey returns null when any constrained column is NULL —
			// SQL UNIQUE allows multiple NULLs, so those rows never collide.
			const keySig = serializeRowKey(row, uc.columns, normalizers);
			if (keySig === null) continue;

			if (seen.has(keySig)) {
				const colNames = uc.columns.map(i => tableSchema.columns[i]?.name ?? String(i)).join(', ');
				throw new QuereusError(
					`UNIQUE constraint failed: ${tableSchema.name} (${colNames})`,
					StatusCode.CONSTRAINT,
				);
			}
			seen.add(keySig);
		}
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
		this.ensureSchemaSubscription(db);
		const tableKey = `${schemaName}.${tableName}`.toLowerCase();
		const table = this.getOrReconnectTable(db, schemaName, tableName);

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
				// Honor the session `default_collation` for an ADD COLUMN that omits an
				// explicit COLLATE, matching the CREATE path so an ADD-COLUMN-ed text column
				// gets the same collation a CREATE-d one would. The persisted DDL re-emits an
				// explicit COLLATE for any non-BINARY collation, so reopen stays stable.
				const newColSchema = columnDefToSchema(change.columnDef, defaultNotNull, db.options.getStringOption('default_collation'));

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

				// Extract any column-level CHECK / FK to persist (see the persist block below).
				// Hoisted above the row migration so a malformed constraint (e.g. a multi-column
				// FK on a single ADD COLUMN, which `extractColumnLevelForeignKeys` rejects) throws
				// BEFORE any rows are migrated or the in-memory schema is swapped — validate-before-
				// mutate, matching the engine's ordering in `runAddColumn`.
				const newCheckConstraints = extractColumnLevelCheckConstraints(change.columnDef);
				const newForeignKeys = extractColumnLevelForeignKeys(change.columnDef, schemaName);

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

				// Update table schema (column-only) and persist DDL.
				//
				// The engine's `runAddColumn` re-merges the column-level FK/CHECK extracted
				// from `columnDef.constraints` into the LIVE in-memory schema AFTER this hook
				// returns, so the schema handed back to it must stay column-only — returning a
				// constrained schema would double the constraint in the live SchemaManager (and,
				// on the next persist, in the DDL). But that engine-side merge is in-memory only:
				// it never reaches the catalog, so persistence must carry the column-level
				// CHECK/FK itself or they vanish on `rehydrateCatalog`. Build a separate
				// `persistedSchema` for `saveTableDDL` when (and only when) the column declares
				// such a constraint; the common path persists `updatedSchema` unchanged. This is
				// unconditional on the default kind — a per-row (evaluator) DEFAULT extracts the
				// same AST constraints as a literal one.
				table.updateSchema(updatedSchema);

				let persistedSchema = updatedSchema;
				if (newCheckConstraints.length > 0 || newForeignKeys.length > 0) {
					// The new column is appended last; resolve each FK's child column to its index
					// (matching how the engine resolves `resolvedForeignKeys` via columnIndexMap).
					const newColIdx = updatedColumns.length - 1;
					const resolvedForeignKeys = newForeignKeys.map(fk => ({ ...fk, columns: Object.freeze([newColIdx]) }));
					persistedSchema = {
						...updatedSchema,
						checkConstraints: Object.freeze([...updatedSchema.checkConstraints, ...newCheckConstraints]),
						foreignKeys: Object.freeze([...(updatedSchema.foreignKeys ?? []), ...resolvedForeignKeys]),
					};
				}
				await this.saveTableDDL(persistedSchema);

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

				// Prune any UNIQUE constraint over the dropped column, mirroring the index
				// filtering above. Store-backed UNIQUE is enforced by a full scan over
				// `uniqueConstraints`, so a stranded constraint whose column index dangles past
				// the column array would break the next insert's validation (and the persisted
				// DDL). A UNIQUE that includes the dropped column is removed outright; remaining
				// constraints have their column indices shifted to track the removed slot. This
				// also covers the engine's ADD COLUMN + inline-UNIQUE revert, which drops the
				// just-added (uniquely-constrained) column.
				const updatedUniqueConstraints = (oldSchema.uniqueConstraints ?? [])
					.filter(uc => !uc.columns.includes(colIndex))
					.map(uc => ({ ...uc, columns: Object.freeze(uc.columns.map(i => i > colIndex ? i - 1 : i)) }));

				const updatedSchema: TableSchema = {
					...oldSchema,
					columns: Object.freeze(updatedColumns),
					columnIndexMap: buildColumnIndexMap(updatedColumns),
					primaryKeyDefinition: Object.freeze(updatedPkDef),
					indexes: Object.freeze(updatedIndexes),
					uniqueConstraints: updatedUniqueConstraints.length > 0
						? Object.freeze(updatedUniqueConstraints)
						: undefined,
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
				await this.rebuildSecondaryIndexes(schemaName, tableName, tableKey, table, updatedSchema);

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
				const constraint = change.constraint;
				let updatedSchema: TableSchema;

				if (constraint.type === 'unique') {
					// Store enforces inline UNIQUE by full-scan over `uniqueConstraints`
					// (no separate index store), so there is nothing physical to build —
					// but we must validate the existing rows before persisting.
					const uc = buildUniqueConstraintSchema(constraint, oldSchema.columnIndexMap);
					const dataStore = await this.getStore(tableKey, table.getConfig());
					await this.validateUniqueOverExistingRows(dataStore, oldSchema, uc);
					updatedSchema = {
						...oldSchema,
						uniqueConstraints: Object.freeze([...(oldSchema.uniqueConstraints ?? []), uc]),
					};
				} else if (constraint.type === 'foreignKey') {
					const fk = buildForeignKeyConstraintSchema(constraint, oldSchema.columnIndexMap, oldSchema.name, oldSchema.schemaName);
					updatedSchema = {
						...oldSchema,
						foreignKeys: Object.freeze([...(oldSchema.foreignKeys ?? []), fk]),
					};
					// Pragma-gated existing-row validation; throws before persistence on an orphan.
					await validateForeignKeyOverExistingRows(db, updatedSchema, fk);
				} else if (constraint.type === 'check') {
					// Schema-only: a CHECK has no physical structure and (matching the
					// engine's prior in-emitter behavior) no existing-row scan. Routing it
					// here — rather than catalog-only — keeps the persisted DDL and the
					// connected-table schema in lock-step so DROP/RENAME CONSTRAINT resolve it.
					const check = buildCheckConstraintSchema(constraint, oldSchema.checkConstraints.length);
					updatedSchema = {
						...oldSchema,
						checkConstraints: Object.freeze([...oldSchema.checkConstraints, check]),
					};
				} else {
					throw new QuereusError(
						`Store table ADD CONSTRAINT does not support constraint type '${constraint.type}'`,
						StatusCode.UNSUPPORTED,
					);
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
				// A collation change needs existing-row UNIQUE re-validation below
				// (non-PK, Option A); the other attribute changes do not.
				let collationChanged = false;

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
				} else if (change.setCollation !== undefined) {
					// Per-column collation update. PRIMARY KEY uniqueness/ordering is enforced
					// PHYSICALLY in the key bytes under a PER-COLUMN key collation
					// (`StoreTable.pkKeyCollations`), so a PK-column SET COLLATE is honored
					// natively by physically re-keying the data store + rebuilding every
					// secondary index under the new collation (the `isPkColumn` block below),
					// mirroring the memory module's primary re-key. A re-key that would collide
					// under the new collation throws CONSTRAINT before any mutation. For non-PK
					// UNIQUE constraints we re-validate existing rows under the new collation
					// (Option A). Query-layer ORDER BY / `=` / `table_info().collation` pick the
					// new collation up from the column schema once this updated schema re-registers.
					const normalized = validateCollationForType(change.setCollation, oldCol.logicalType, change.columnName);
					const nameMatches = normalized === (oldCol.collation || 'BINARY');
					if (nameMatches && oldCol.collationExplicit) {
						return oldSchema; // already explicit in the desired collation — no scan, no re-key, no re-persist
					}
					// SET COLLATE is a user declaration with the same standing as a
					// CREATE-time COLLATE clause, so mark the collation explicit (rank 2
					// in the comparison lattice) regardless of the column's creation
					// history — including SET COLLATE binary. When only the name matches
					// but the column was not yet explicit (a defaulted collation, or one
					// inherited from session default_collation), flip the flag as a
					// METADATA-ONLY change: the collation bytes are unchanged, so keep
					// collationChanged false to skip rekeyRows / validateUniqueOverExistingRows
					// below while still re-registering the schema and re-persisting DDL.
					// A different name takes the full physical re-key path AND sets the flag.
					newCol = { ...oldCol, collation: normalized, collationExplicit: true };
					collationChanged = !nameMatches;
				} else {
					throw new QuereusError('ALTER COLUMN requires an attribute to change', StatusCode.INTERNAL);
				}

				const updatedColumns = oldSchema.columns.map((c, i) => i === colIndex ? newCol : c);
				// Mirror the memory module (MemoryTableManager.alterColumn): a per-column
				// collation change propagates into every index column ordering by this
				// column, so a `derivedFromIndex` UNIQUE re-keys its enforcement under the
				// new collation. StoreTable.uniqueEnforcementCollations reads the index's
				// per-column collation, so without this the index entry would stay stale
				// and the derived UNIQUE would keep enforcing the OLD collation after the
				// ALTER. Metadata-only: the store's index KEY bytes use the table-level key
				// collation K (see buildIndexEntries / updateSecondaryIndexes), so no index
				// entry re-encode is required for a non-PK column. An index column with an
				// explicit COLLATE is re-collated too — matching memory, which clobbers it
				// the same way (no surface preserves a differing index COLLATE across an
				// ALTER COLUMN SET COLLATE on its column).
				const updatedIndexes = (collationChanged && oldSchema.indexes)
					? oldSchema.indexes.map(idx => ({
						...idx,
						columns: idx.columns.map(ic =>
							ic.index === colIndex ? { ...ic, collation: newCol.collation } : ic),
					}))
					: oldSchema.indexes;
				const updatedSchema: TableSchema = {
					...oldSchema,
					columns: Object.freeze(updatedColumns),
					columnIndexMap: buildColumnIndexMap(updatedColumns),
					indexes: updatedIndexes ? Object.freeze(updatedIndexes) : updatedIndexes,
				};

				// SET COLLATE existing-row re-validation (Option A, non-PK UNIQUE): a new
				// per-column collation can make rows that were distinct under the old
				// collation collide. Re-scan every UNIQUE constraint covering the altered
				// column under the NEW collation (`updatedSchema` carries it). The first
				// collision throws CONSTRAINT BEFORE any mutation/persist, so the table is
				// left unchanged and writable (matches the ADD CONSTRAINT rollback shape).
				// The PK is intentionally excluded — it never appears in `uniqueConstraints`;
				// its physical re-key/re-validation is the `isPkColumn` block below.
				if (collationChanged) {
					const coveringConstraints = (updatedSchema.uniqueConstraints ?? [])
						.filter(uc => uc.columns.includes(colIndex));
					if (coveringConstraints.length > 0) {
						const dataStore = await this.getStore(tableKey, table.getConfig());
						for (const uc of coveringConstraints) {
							await this.validateUniqueOverExistingRows(dataStore, updatedSchema, uc);
						}
					}
				}

				// SET COLLATE on a PRIMARY KEY member (Option B physical re-key): re-encode
				// every data-store key under the column's new key collation, then rebuild every
				// secondary index (its keys embed the PK suffix). `rekeyRows` validates in a
				// first pass and throws CONSTRAINT on a collision under the new collation WITHOUT
				// mutating the store — so a coarser collation that collapses two distinct PKs
				// (e.g. 'a'/'A' under BINARY→NOCASE) is rejected all-or-nothing, mirroring
				// ALTER PRIMARY KEY. Runs AFTER the non-PK UNIQUE re-validation above so both
				// throw-only checks precede the first store mutation. `updatedSchema.columns`
				// carries the new collation, so the new key bytes follow it.
				if (collationChanged && oldSchema.primaryKeyDefinition.some(def => def.index === colIndex)) {
					await table.rekeyRows(oldSchema.primaryKeyDefinition, updatedSchema.columns);
					await this.rebuildSecondaryIndexes(schemaName, tableName, tableKey, table, updatedSchema);
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

		// Capture the current schema BEFORE the guard (and before we drop in-memory
		// references): the guard needs the index list to compute every relocated
		// store name, and the new catalog DDL must reflect the real column set.
		const existing = this.tables.get(oldKey);
		const currentSchema: TableSchema | undefined =
			existing?.getSchema() ?? db.schemaManager.getTable(schemaName, oldName);

		// Authoritative index list (exact store names): the provider relocates
		// exactly these index stores instead of prefix-scanning `{oldName}_idx_`,
		// which would also catch a sibling table named `{oldName}_idx_<x>`.
		const indexNames = (currentSchema?.indexes ?? []).map(i => i.name);

		// Reject when ANY physical name the rename introduces — the new data store
		// AND each relocated index store `{schema}.{newName}_idx_{x}` — already
		// names an existing store. E.g. rename some table to `q_idx_archive` while
		// table `q` has index `archive` (both → `{schema}.q_idx_archive`); or rename
		// `t`→`u` while `t` has index `x` and a sibling table is literally named
		// `u_idx_x`, which would relocate `t`'s index onto the sibling's data store.
		// The renamed table's own current stores stay in the occupied set (see
		// collectOccupiedStoreNames): an introduced name can only equal an own store
		// in a footprint-swap rename providers cannot relocate safely. All checks
		// run before the FIRST side effect (the coordinator commit, disconnect, and
		// cache evictions below, then the physical relocation) so a colliding
		// rename is a clean no-op.
		const occupied = this.collectOccupiedStoreNames(db, schemaName);
		this.assertStoreNameFree(
			db,
			schemaName,
			buildDataStoreName(schemaName, newName),
			`data store of table '${schemaName}.${newName}' (rename target)`,
			occupied,
		);
		for (const indexName of indexNames) {
			this.assertStoreNameFree(
				db,
				schemaName,
				buildIndexStoreName(schemaName, newName, indexName),
				`index store of index '${indexName}' on table '${schemaName}.${newName}' (rename target)`,
				occupied,
			);
		}

		// ALTER TABLE is effectively DDL-committing on a store-backed table:
		// once we move the on-disk directory, prior buffered writes can no
		// longer be rolled back through the coordinator. Flush any pending
		// ops NOW, before the old store's handle is closed. Subsequent
		// commit() calls on the same coordinator are no-ops (inTransaction
		// is cleared), which keeps the enclosing transaction safe.
		//
		// The coordinator is module-wide, so this DDL-commits the WHOLE module
		// transaction — every table's pending ops, not just the renamed table's —
		// in one all-or-nothing batch. That is the correct, consistent posture
		// for a store DDL-commit: an ALTER cannot half-commit some sibling tables.
		if (this.moduleCoordinator?.isInTransaction()) {
			await this.moduleCoordinator.commit();
		}

		// Hard-dispose the evicted handle: flush any lazy stats it was buffering AND
		// deregister its coordinator stats-callback pair (the renamed instance is
		// gone after this — the next connect()/getOrReconnectTable mints a fresh one
		// that re-registers against the shared coordinator). Dispose failures must
		// not block the physical rename.
		if (existing) {
			try {
				await existing.dispose();
			} catch {
				/* ignore — physical rename must proceed */
			}
		}

		this.tables.delete(oldKey);
		this.stores.delete(oldKey);
		// The coordinator is module-wide (flushed above); it is not per-table, so
		// it is not evicted here.

		// Evict the disposed instance's registered engine connection. It is bound to
		// the OLD qualified name and its owning StoreTable is now disposed, so it is
		// definitively stale. Unlike drop — where the engine's schema manager calls
		// `removeConnectionsForTable` for us — the generic rename path
		// (`alter-table.ts` renameTableImpl) does NOT, so the store must evict it
		// here or the connection leaks one per rename. Safe because the module
		// DDL-commit above already flushed its pending ops (no uncommitted writes to
		// lose).
		(db as DatabaseInternal).removeConnectionsForTable(schemaName, oldName);

		// Move physical storage (data directory + index directories).
		if (this.provider.renameTableStores) {
			await this.provider.renameTableStores(schemaName, oldName, newName, indexNames);
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
	 *
	 * Every plan is stamped with `honorsCollatedRangeBounds`: the store's post-fetch
	 * row filter (`StoreTable.matchesFilters` → `compareValues`) compares each pushed
	 * constraint — including LT/LE/GT/GE range bounds — under the column's declared
	 * collation, so the access path's collation-cover analysis may keep a
	 * collation-matched non-BINARY (NOCASE/RTRIM) PK range/BETWEEN seek instead of
	 * declining to a SeqScan + residual (see `classifyConstraintCover` in
	 * rule-select-access-path.ts). The seek really does narrow: `StoreTable.scanPKRange`
	 * (via `StoreTable.buildPKRangeBounds`) encodes the LT/LE/GT/GE bounds under the
	 * same per-column key collations the data keys use and iterates that
	 * seek-start/early-termination window. The window is a SUPERSET, so the post-fetch
	 * row filter still reproduces the exact collation semantics — and a comparator-only
	 * collation with no byte encoder safely falls back to a full scan. Mirrors the
	 * memory module's advertisement.
	 */
	getBestAccessPlan(
		_db: Database,
		tableInfo: TableSchema,
		request: BestAccessPlanRequest
	): BestAccessPlanResult {
		return { ...this.computeBestAccessPlan(tableInfo, request), honorsCollatedRangeBounds: true };
	}

	private computeBestAccessPlan(
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
			// the leading PK column. The scan seeks to the window start and
			// early-terminates (StoreTable.buildPKRangeBounds derives the encoded
			// bounds), and the leading-PK order guarantee holds throughout.
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
	 * Get (lazily constructing) the SINGLE transaction coordinator shared by every
	 * table this module owns — the unit of cross-table atomicity. Every
	 * {@link StoreTable} attaches to the same instance, so a transaction touching
	 * several of the module's tables commits/rolls back as one all-or-nothing
	 * batch.
	 *
	 * Synchronously constructible: ops are addressed by explicit store handle, so
	 * the coordinator never needs to open a store to be created. This lets callers
	 * that must stay synchronous (e.g. a `BackingHost.connect()`) obtain a working
	 * coordinator before any table's store has been opened.
	 */
	getCoordinator(): TransactionCoordinator {
		if (!this.moduleCoordinator) {
			this.moduleCoordinator = new TransactionCoordinator(
				this.eventEmitter,
				// Re-evaluated per commit (see TransactionCoordinator.atomicBatchFactory)
				// so a provider that gains/loses the capability is always honored.
				() => this.provider.beginAtomicBatch?.(),
			);
		}
		return this.moduleCoordinator;
	}

	/**
	 * Build the catalog entry for a table: its CREATE TABLE DDL, one
	 * `CREATE [UNIQUE] INDEX` statement per persistable secondary index, and one
	 * `alter index … set tags (…)` statement per exposed implicit index carrying
	 * user tags, newline-joined into a single multi-statement bundle keyed by
	 * `{schema}.{table}`.
	 *
	 * Bundling the indexes into the table's own entry means every existing
	 * re-persist path — `saveTableDDL` (each `alterTable` arm, `renameTable`) and
	 * the `table_modified` listener (`persistCatalogIfChanged`) — carries the
	 * indexes along for free, and `removeTableDDL` drops them with the table. The
	 * bundle is consumed on reopen by `rehydrateCatalog` → `importCatalog`, whose
	 * `parser.parseAll` splits it AST-by-AST (never on `\n`) and imports each
	 * statement in document order, so the table registers before its indexes.
	 *
	 * Both the table DDL and the index DDL are emitted without a `db` arg, keeping
	 * the persistence-safe fully-qualified form. Hidden implicit covering indexes
	 * (the auto-built BTree backing a declared UNIQUE constraint) are excluded —
	 * they are a backing detail that round-trips via the table's UNIQUE constraint,
	 * not as a standalone CREATE INDEX. For store tables `buildTableSchemaFromAST`
	 * synthesizes none of those, so in practice every index is included; the guard
	 * is defensive. A `CREATE UNIQUE INDEX`'s derived UNIQUE constraint is already
	 * excluded from the table DDL by the generator, so it round-trips solely via
	 * its own `CREATE UNIQUE INDEX` line — no doubling.
	 *
	 * An *exposed* implicit index (a non-derived UNIQUE constraint tagged
	 * `quereus.expose_implicit_index = true`, never materialized in store mode)
	 * must NOT get a synthetic `CREATE INDEX` line — re-import would materialize a
	 * real `IndexSchema` and change the store-mode shape. Its user tags
	 * (`UniqueConstraintSchema.exposedIndexTags`) instead ride a trailing
	 * `alter index … set tags` line, which `importDDL` re-applies silently after
	 * the CREATE TABLE in the same entry has registered the constraint. Empty tag
	 * records emit no line, and `exposedImplicitIndexes` returns `[]` for
	 * memory-mode tables (name materialized) and orders descriptors by the
	 * `uniqueConstraints` array, so the bundle stays byte-deterministic — which
	 * the compare-write in `persistCatalogIfChanged` relies on.
	 */
	private buildCatalogEntry(tableSchema: TableSchema): string {
		const parts: string[] = [generateTableDDL(tableSchema)];
		for (const idx of tableSchema.indexes ?? []) {
			if (isHiddenImplicitIndex(tableSchema, idx.name)) continue;
			parts.push(generateIndexDDL(idx, tableSchema));
		}
		for (const desc of exposedImplicitIndexes(tableSchema)) {
			if (desc.tags && Object.keys(desc.tags).length > 0) {
				parts.push(generateIndexTagsDDL(tableSchema.schemaName, desc.name, desc.tags));
			}
		}
		return parts.join('\n');
	}

	/**
	 * Save table DDL (bundled with its secondary index DDL) to the catalog store.
	 */
	async saveTableDDL(tableSchema: TableSchema): Promise<void> {
		const ddl = this.buildCatalogEntry(tableSchema);
		const catalogKey = buildCatalogKey(tableSchema.schemaName, tableSchema.name);
		const encoder = new TextEncoder();
		const encodedDDL = encoder.encode(ddl);

		const catalogStore = await this.provider.getCatalogStore();
		await catalogStore.put(catalogKey, encodedDDL);
	}

	/**
	 * Load all DDL **values** from the catalog store (keys discarded).
	 * Used to restore persisted tables on startup and by tests asserting persisted DDL.
	 * Note: this returns table, view, AND materialized-view entries intermixed —
	 * {@link rehydrateCatalog} uses {@link loadCatalogEntries} (keys retained) to
	 * classify them. Meta entries (e.g. the clean-shutdown marker) are not DDL
	 * and are filtered out.
	 */
	async loadAllDDL(): Promise<string[]> {
		const catalogStore = await this.provider.getCatalogStore();
		const bounds = buildCatalogScanBounds();
		const decoder = new TextDecoder();
		const ddlStatements: string[] = [];

		for await (const entry of catalogStore.iterate(bounds)) {
			if (classifyCatalogKey(entry.key) === 'meta') continue;
			const ddl = decoder.decode(entry.value);
			ddlStatements.push(ddl);
		}

		return ddlStatements;
	}

	/**
	 * Load every catalog entry as `{ key, ddl }`. Unlike {@link loadAllDDL} (values
	 * only) this retains the key so {@link rehydrateCatalog} can classify each entry
	 * (table / view / materialized view) by its reserved key prefix.
	 */
	private async loadCatalogEntries(): Promise<Array<{ key: Uint8Array; ddl: string }>> {
		const catalogStore = await this.provider.getCatalogStore();
		const decoder = new TextDecoder();
		const entries: Array<{ key: Uint8Array; ddl: string }> = [];
		for await (const entry of catalogStore.iterate(buildCatalogScanBounds())) {
			entries.push({ key: entry.key, ddl: decoder.decode(entry.value) });
		}
		return entries;
	}

	/**
	 * Rehydrate the persisted catalog into the in-memory schema manager, in
	 * dependency order.
	 *
	 * Establishes the engine schema-change subscription up front (so a reopened DB
	 * persists subsequent DDL even when its first post-reopen statement is a view/MV,
	 * which never routes through a module hook — all the lazy subscription points are
	 * table hooks). Then loads every catalog entry once, classifies each by its key
	 * prefix into {tables, views, materialized views}, and imports in three phases:
	 *
	 *   1. **Tables** — `importCatalog` (connect to existing storage; refresh connected
	 *      `StoreTable` schemas).
	 *   2. **Views** — `importCatalog` (engine silent-register; body validation deferred
	 *      to query time, so order among views — and view-over-MV / view-over-view —
	 *      does not matter, and no schema-change event fires → phase 2 writes nothing).
	 *   3. **Materialized views** — `importCatalog` per entry (engine re-materialize:
	 *      rebuilds the memory backing from current source data, re-registers row-time
	 *      maintenance, re-runs the eligibility gate — the same core the create emitter
	 *      uses, but silent: no `materialized_view_added` fires, so phase 3 writes
	 *      nothing back to the catalog). A store-hosted backing that phase 1 already
	 *      rehydrated is **adopted without the refill** when the engine's adopt gates
	 *      pass — see the clean-shutdown marker below.
	 *
	 * **Clean-shutdown marker.** Before anything loads, the reserved
	 * `\x00meta\x00clean_shutdown` catalog entry (written by {@link closeAll} after
	 * every batch flushed) is consumed: parsed into `{ trusted, staleAtClose }`, then
	 * **deleted immediately** — single-use, so a crash later in this session (or a
	 * second rehydrate without an intervening clean close) is detected at the next open
	 * and every adopt falls back to the always-correct drop+refill, self-healing any
	 * crash-window divergence (coordinated commit is not 2PC across stores). The marker
	 * payload is the JSON set of MVs that were **stale-at-close** (row-time maintenance
	 * detached, so the durable backing may be behind); phase 3 withholds trust per-entry
	 * for those — `trustBackings: trusted && !staleAtClose.has(name)` — so a
	 * stale-at-close MV refills (recomputing content and re-arming maintenance) while
	 * every live-at-close MV keeps the fast path. The one shared `adoptedBackings` set
	 * composes across fixpoint rounds (an upstream MV adopted in round 1 enables its
	 * dependent in round 2, while a refilled — or stale-at-close — upstream is never
	 * added to it, forcing dependents to refill).
	 *
	 * **MV-over-MV ordering** is handled by a fixpoint retry rather than a static topo
	 * sort: an MV's resolved `sourceTables` are computed at import time, not serialized
	 * in the DDL, so they are unavailable before import. Each round passes the names of
	 * every OTHER still-pending MV entry as `pendingDerivations`; the engine defers any
	 * entry whose body reads one (its source already pre-exists as a phase-1 plain
	 * table, so the body would otherwise plan against content the upstream's own import
	 * may be about to replace). The loop repeats while any MV makes progress — robust to
	 * arbitrary nesting depth. A genuinely unbuildable MV — a missing (e.g. memory)
	 * source, or an unresolvable cycle — makes no progress in a round and is recorded in
	 * `errors`.
	 *
	 * Per-entry errors in any phase are collected (not fatal) so one bad object does not
	 * abort the rest.
	 *
	 * Call after `db.registerModule()` (and `db.setDefaultVtabName()` if DDL may lack a
	 * USING clause).
	 */
	async rehydrateCatalog(db: Database): Promise<RehydrationResult> {
		// Subscribe up front: a reopened DB whose first post-reopen DDL is a view/MV
		// would otherwise miss the event (the lazy `ensureSchemaSubscription` points are
		// all table hooks). Done even for an empty catalog. (Documented gap: a brand-new
		// DB — never rehydrated — whose very first DDL is a view still relies on a prior
		// store-table create/connect to establish the subscription.)
		this.ensureSchemaSubscription(db);

		// Consume the clean-shutdown marker FIRST (before the catalog scan): its
		// presence is the adopt trust basis for this rehydration only, and deleting
		// it immediately makes it single-use. Its payload names the MVs that were
		// stale-at-close — those are withheld from the fast path per-entry below.
		const { trusted, staleAtClose } = await this.consumeCleanShutdownMarker();

		const entries = await this.loadCatalogEntries();
		const result: RehydrationResult = { tables: [], indexes: [], views: [], materializedViews: [], errors: [] };
		if (entries.length === 0) return result;

		const recordError = (ddl: string, e: unknown): void => {
			const error = e instanceof Error ? e : new Error(String(e));
			console.warn(
				`[StoreModule] Failed to rehydrate DDL entry, skipping: ${error.message}\n  DDL: ${ddl.substring(0, 120)}`,
			);
			result.errors.push({ ddl, error });
		};

		// Classify every loaded entry by key prefix. The full-range catalog scan returns
		// table, view, and MV entries intermixed; each must reach the correct phase — a
		// view/MV entry fed to the table-phase importCatalog would fail-loud or mis-handle.
		const tableDDLs: string[] = [];
		const viewDDLs: string[] = [];
		// MV entries retain their qualified `schema.mv` name (derived from the catalog
		// key) so phase 3 can withhold the adopt fast path per-entry for any MV that
		// was stale-at-close.
		const mvEntries: Array<{ name: string; ddl: string }> = [];
		for (const { key, ddl } of entries) {
			switch (classifyCatalogKey(key)) {
				case 'view': { viewDDLs.push(ddl); break; }
				case 'materializedView': { mvEntries.push({ name: parseMaterializedViewCatalogKey(key), ddl }); break; }
				// Meta entries are store-internal, never DDL. (The marker itself was
				// already consumed above; this guards any future meta key.)
				case 'meta': { break; }
				default: { tableDDLs.push(ddl); break; }
			}
		}

		// Phase 1 — tables. Per-entry import isolates a corrupt entry so the rest load.
		for (const ddl of tableDDLs) {
			try {
				const imported = await db.schemaManager.importCatalog([ddl]);
				result.tables.push(...imported.tables);
				result.indexes.push(...imported.indexes);
			} catch (e) {
				recordError(ddl, e);
			}
		}

		// Phase 2 — views (silent register; deferred body validation → order-independent).
		for (const ddl of viewDDLs) {
			try {
				const imported = await db.schemaManager.importCatalog([ddl]);
				result.views.push(...imported.views);
			} catch (e) {
				recordError(ddl, e);
			}
		}

		// Phase 3 — materialized views, dependency-ordered via fixpoint retry (see
		// docstring). One shared adopt ledger across all rounds: adopted upstream
		// backings unlock their dependents' adoption in later rounds.
		const adoptedBackings = new Set<string>();
		let pending = mvEntries;
		while (pending.length > 0) {
			const failed: Array<{ entry: { name: string; ddl: string }; error: unknown }> = [];
			let progressed = false;
			for (const entry of pending) {
				try {
					// Ordering gate (unified model): a dependent's source may already
					// pre-exist as the upstream's phase-1 *plain* table, so its body
					// PLANS before the upstream's own MV entry has imported. Pass the
					// names of every OTHER still-pending MV entry; the engine defers
					// (throws → retried next round) any entry whose body reads one.
					const pendingDerivations = new Set(
						pending.filter(p => p !== entry).map(p => p.name),
					);
					// Trust this backing only under a clean shutdown AND when the MV was
					// not stale-at-close — a stale-at-close MV's row-time maintenance was
					// detached mid-session, so its durable backing may be behind. Refilling
					// it recomputes content and re-arms maintenance (clearing `stale`); a
					// refilled MV is also never added to `adoptedBackings`, so the ledger
					// gate forces its MV-over-MV dependents to refill too.
					const imported = await db.schemaManager.importCatalog([entry.ddl], {
						trustBackings: trusted && !staleAtClose.has(entry.name),
						adoptedBackings,
						pendingDerivations,
					});
					result.materializedViews.push(...imported.materializedViews);
					progressed = true;
				} catch (e) {
					failed.push({ entry, error: e });
				}
			}
			if (!progressed) {
				// No MV built this round → the remaining failures are genuine (missing
				// source, ineligible body, unresolvable cycle). Record them and stop.
				for (const f of failed) recordError(f.entry.ddl, f.error);
				break;
			}
			pending = failed.map(f => f.entry);
		}

		// Refresh each connected StoreTable from the now-current registry. During
		// import, `importTable` connects a StoreTable holding the table-only schema,
		// then `importIndex` appends the index (and its derived UNIQUE constraint) to
		// the SchemaManager's registered schema but NOT to that live StoreTable
		// instance — `importCatalog` deliberately skips module hooks to stay generic,
		// so the store module reconciles here. Without this, DML on a rehydrated table
		// would not maintain its indexes and the derived UNIQUE would not enforce.
		for (const table of this.tables.values()) {
			const current = table.getSchema();
			const fresh = db.schemaManager.getTable(current.schemaName, current.name);
			if (fresh) table.updateSchema(fresh);
		}

		return result;
	}

	/**
	 * Consume the clean-shutdown marker, deleting it in the same breath (single-use).
	 *
	 * Returns `{ trusted, staleAtClose }`:
	 * - `trusted` — the marker was present AND its payload parsed as a string array.
	 *   Absence (a fresh store, a crash, or a prior rehydrate without an intervening
	 *   {@link closeAll}) yields `false`, so every adopt this session falls back to
	 *   refill.
	 * - `staleAtClose` — the qualified lowercased `schema.mv` names that were
	 *   stale-at-close (written by {@link closeAll}); those MVs refill even under trust.
	 *
	 * Conservative parse: any unparseable / wrong-shape payload (including a legacy
	 * bare `'1'`, which parses to a number, not an array) degrades to
	 * `{ trusted: false, staleAtClose: ∅ }` — refill everything — rather than
	 * trust-everything. The marker is deleted regardless of parse outcome.
	 */
	private async consumeCleanShutdownMarker(): Promise<{ trusted: boolean; staleAtClose: ReadonlySet<string> }> {
		const catalogStore = await this.provider.getCatalogStore();
		const markerKey = buildMetaCatalogKey(CLEAN_SHUTDOWN_META_NAME);
		const raw = await catalogStore.get(markerKey);
		if (raw === undefined) return { trusted: false, staleAtClose: new Set() };
		// Single-use AND durable-before-session-writes: forcing this delete to stable
		// storage before any of the session's (independently flushed, different-store)
		// data writes can land closes the power-loss window where a persisted data write
		// outlives a lost marker-delete and resurrects a consumed marker. (Backends
		// without a durability knob no-op the hint — losing it is conservative there, and
		// memory has no crash.) See docs/materialized-views.md § Cross-module atomicity.
		await catalogStore.delete(markerKey, { sync: true }); // single-use, regardless of parse outcome

		try {
			const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
			if (!Array.isArray(parsed) || !parsed.every((s): s is string => typeof s === 'string')) {
				console.warn('[StoreModule] clean-shutdown marker payload is not a string array; refilling all backings.');
				return { trusted: false, staleAtClose: new Set() };
			}
			return { trusted: true, staleAtClose: new Set(parsed) };
		} catch (e) {
			console.warn(
				`[StoreModule] clean-shutdown marker payload did not parse as JSON; refilling all backings: ${
					e instanceof Error ? e.message : String(e)
				}`,
			);
			return { trusted: false, staleAtClose: new Set() };
		}
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
	 * Persist a plain view's catalog entry (DDL via `generateViewDDL`), keyed by its
	 * reserved view prefix. Compare-write (skip identical) — see
	 * {@link persistObjectCatalogEntryIfChanged}.
	 */
	async saveViewDDL(view: ViewSchema): Promise<void> {
		await this.persistObjectCatalogEntryIfChanged(
			buildViewCatalogKey(view.schemaName, view.name),
			generateViewDDL(view),
		);
	}

	/** Remove a plain view's catalog entry (on DROP VIEW). */
	async removeViewDDL(schemaName: string, viewName: string): Promise<void> {
		const catalogStore = await this.provider.getCatalogStore();
		await catalogStore.delete(buildViewCatalogKey(schemaName, viewName));
	}

	/**
	 * Persist a materialized view's catalog entry (DDL via `generateMaintainedTableDDL`
	 * over the maintained table — the unified record), keyed by its reserved MV
	 * prefix. Compare-write (skip identical) — see
	 * {@link persistObjectCatalogEntryIfChanged}.
	 */
	async saveMaterializedViewDDL(mv: MaintainedTableSchema): Promise<void> {
		await this.persistObjectCatalogEntryIfChanged(
			buildMaterializedViewCatalogKey(mv.schemaName, mv.name),
			generateMaintainedTableDDL(mv),
		);
	}

	/** Remove a materialized view's catalog entry (on DROP MATERIALIZED VIEW). */
	async removeMaterializedViewDDL(schemaName: string, mvName: string): Promise<void> {
		const catalogStore = await this.provider.getCatalogStore();
		await catalogStore.delete(buildMaterializedViewCatalogKey(schemaName, mvName));
	}

	/**
	 * Compare-write a view/MV catalog entry: write only when the entry is absent or its
	 * DDL differs from `newDDL` (skip identical). Unlike the table path's
	 * {@link persistCatalogIfChanged} there is **no** absent→skip self-filter — a view/MV
	 * belongs to this db's catalog unconditionally (one module instance serves one
	 * Database). Skipping identical writes makes any event whose regenerated DDL is
	 * unchanged (e.g. a `materialized_view_refreshed`) a no-op, so a second consecutive
	 * reopen yields identical catalog bytes. (Rehydration itself fires no view/MV events
	 * at all — `importCatalog` is silent.)
	 */
	private async persistObjectCatalogEntryIfChanged(key: Uint8Array, newDDL: string): Promise<void> {
		const catalogStore = await this.provider.getCatalogStore();
		const existing = await catalogStore.get(key);
		if (existing !== undefined && new TextDecoder().decode(existing) === newDDL) return;
		await catalogStore.put(key, new TextEncoder().encode(newDDL));
	}

	/**
	 * Parse module configuration from vtab args.
	 */
	private parseConfig(args: Record<string, SqlValue> | undefined): StoreModuleConfig {
		return {
			collation: (args?.collation as 'BINARY' | 'NOCASE') || 'NOCASE',
		};
	}

	// --- Engine schema-change subscription (catalog-only tag persistence) ---

	/**
	 * Subscribe (once) to the engine's `SchemaChangeNotifier` so catalog-only
	 * mutations that bypass `module.alterTable` — notably `ALTER … SET TAGS` and the
	 * programmatic `setTableTags`/`setColumnTags`/`setConstraintTags` — still re-persist
	 * the table's catalog DDL. Called lazily from the first `create`/`connect`/
	 * `alterTable` hook that hands us a `db`.
	 *
	 * One `StoreModule` instance is assumed to serve one `Database`. A later hook
	 * carrying a *different* `db` keeps the existing subscription (multi-database
	 * sharing of a single module instance is out of scope) and logs.
	 */
	private ensureSchemaSubscription(db: Database): void {
		if (this.schemaListenerUnsub) {
			if (this.subscribedDb && this.subscribedDb !== db) {
				console.warn(
					'[StoreModule] ensureSchemaSubscription called with a different Database; '
						+ 'keeping the existing subscription (one module instance is assumed to serve one Database).',
				);
			}
			return;
		}
		this.subscribedDb = db;
		this.schemaListenerUnsub = db.schemaManager.getChangeNotifier().addListener(this.onEngineSchemaChange);
	}

	/**
	 * Engine schema-change listener. Persists the catalog incrementally for the events
	 * that bypass `module.alterTable` / `module.destroy`:
	 *
	 * - `table_modified` — every catalog-only tag swap (and the redundant follow-up a
	 *   structural ALTER fires). Keeps a connected `StoreTable`'s cached schema consistent
	 *   (SET TAGS does not call `updateSchema`) then read-compare-writes the table bundle.
	 * - `view_added` / `view_modified` / `view_removed` — plain `CREATE`/`ALTER … SET TAGS`/
	 *   `DROP VIEW` (the engine fires these from the runtime emitters).
	 * - `materialized_view_added` / `_modified` / `_refreshed` / `_removed` — MV lifecycle.
	 *   Like `table_modified`, the `_added`/`_modified`/`_refreshed` arms also synchronously
	 *   refresh the connected `StoreTable`'s cached schema so a tag change (e.g.
	 *   `quereus.sync.replicate`) takes effect immediately without reopen.
	 *
	 * Unlike the table path there is **no** catalog-absent self-filter for view/MV
	 * add/remove: one `StoreModule` instance serves one `Database`, so that database's
	 * views/MVs belong in its catalog unconditionally. A MEMORY-hosted maintained table
	 * fires `table_added`/`table_removed`/`table_modified` like any table; those stay
	 * ignored (`table_added`/`table_removed` fall through; its `table_modified` is
	 * catalog-absent → skipped), so only the MV entry persists for it. A STORE-hosted
	 * maintained table additionally persists its own table bundle through the ordinary
	 * store-table machinery (which phase-1 rehydrate connects for the adopt fast path).
	 *
	 * Synchronous by contract (`notifyChange` does not await listeners); every async write
	 * rides `persistQueue`, drained by `closeAll`/`whenCatalogPersisted`.
	 */
	private onEngineSchemaChange = (event: EngineSchemaChangeEvent): void => {
		switch (event.type) {
			case 'table_modified': {
				// SET TAGS does not call `table.updateSchema`, so a connected instance's cached
				// schema would otherwise go stale (and a later lazy `saveTableDDL` could re-write
				// tag-less DDL). Persistence below always reads `newObject`, never this cache.
				const tableKey = `${event.schemaName}.${event.objectName}`.toLowerCase();
				const connected = this.tables.get(tableKey);
				if (connected) connected.updateSchema(event.newObject);
				const key = buildCatalogKey(event.schemaName, event.objectName);
				const newObject = event.newObject;
				this.enqueuePersist(() => this.persistCatalogIfChanged(key, newObject));
				return;
			}
			case 'view_added':
			case 'view_modified': {
				const view = event.newObject;
				this.enqueuePersist(() => this.saveViewDDL(view));
				return;
			}
			case 'view_removed': {
				const { schemaName, objectName } = event;
				this.enqueuePersist(() => this.removeViewDDL(schemaName, objectName));
				return;
			}
			case 'materialized_view_added':
			case 'materialized_view_modified':
				// Unified model: the payload is the maintained table itself.
				this.refreshConnectedMaterializedView(event.schemaName, event.objectName, event.newObject);
				return;
			case 'materialized_view_refreshed':
				// DDL is usually unchanged by a REFRESH (body/tags identical) → compare-skip,
				// but re-read tags in case they were updated alongside the refresh.
				this.refreshConnectedMaterializedView(event.schemaName, event.objectName, event.object);
				return;
			case 'materialized_view_removed': {
				const { schemaName, objectName } = event;
				// DROP MAINTAINED detaches catalog-only: the engine has already swapped the
				// catalog entry to a plain (derivation-less) schema before firing this event,
				// but a connected `StoreTable` still caches the maintained schema. The store's
				// `alterTable` reads that cache (`getSchema`), so a following structural ALTER
				// would spread the stale `derivation` onto the rebuilt schema and re-register
				// the table as a materialized view (rejecting the next ALTER). Refresh the cache
				// to the now-plain catalog entry. When the entry is gone entirely (DROP TABLE /
				// DROP MATERIALIZED VIEW), there is nothing to refresh — `destroy` retires it.
				const plain = this.subscribedDb?.schemaManager.getTable(schemaName, objectName);
				if (plain && !isMaintainedTable(plain)) {
					const connected = this.tables.get(`${schemaName}.${objectName}`.toLowerCase());
					if (connected) connected.updateSchema(plain);
				}
				this.enqueuePersist(() => this.removeMaterializedViewDDL(schemaName, objectName));
				return;
			}
			default:
				return;
		}
	};

	/**
	 * Shared MV add/modify/refresh handling. Narrow defensively — a derivation-less
	 * payload would be an engine bug, so skip. Otherwise, mirror `table_modified`:
	 * synchronously refresh a connected `StoreTable`'s cached schema (so a tag change
	 * such as `quereus.sync.replicate` takes effect immediately without reopen) before
	 * enqueuing the catalog DDL persist.
	 */
	private refreshConnectedMaterializedView(schemaName: string, objectName: string, payload: TableSchema): void {
		if (!isMaintainedTable(payload)) return;
		const key = `${schemaName}.${objectName}`.toLowerCase();
		const connected = this.tables.get(key);
		if (connected) connected.updateSchema(payload);
		this.enqueuePersist(() => this.saveMaterializedViewDDL(payload));
	}

	/**
	 * Append a catalog-persistence task to the serialized `persistQueue`, so successive
	 * mutations (e.g. SET TAGS (a=1) then SET TAGS ()) apply in order and are drained by
	 * `closeAll`/`whenCatalogPersisted` before the provider closes. Errors are
	 * swallowed+logged to mirror `notifyChange`'s own try/catch contract — a listener
	 * rejection must never escape.
	 */
	private enqueuePersist(work: () => Promise<void>): void {
		this.persistQueue = this.persistQueue
			.then(work)
			.catch((err: unknown) => {
				const message = err instanceof Error ? err.message : String(err);
				console.warn(`[StoreModule] Failed to persist catalog DDL after schema change: ${message}`);
			});
	}

	/**
	 * Read-compare-write the catalog DDL for a table that just fired `table_modified`.
	 *
	 * - **Absent** catalog entry → the table is not store-backed in this catalog (a
	 *   memory table in the same `db`, or a store table never persisted) → skip. This
	 *   self-filters foreign-module tables without relying on `vtabModule` identity
	 *   (which points at the isolation wrapper when wrapped).
	 * - **Present** but identical DDL → skip (no redundant write). This is what makes a
	 *   structural ALTER — whose own `alterTable` already wrote the final DDL, then fires
	 *   `table_modified` with that same final schema — a no-op here (no double-write).
	 * - **Present** and different DDL → re-persist (the tag swap; or a beneficial
	 *   propagated rewrite of a dependent store table).
	 */
	private async persistCatalogIfChanged(key: Uint8Array, newObject: TableSchema): Promise<void> {
		const catalogStore = await this.provider.getCatalogStore();
		const existing = await catalogStore.get(key);
		if (existing === undefined) return; // not store-backed in this catalog — skip

		// Regenerate the full bundle (table DDL + index DDL + exposed-implicit-index
		// tag DDL): a SET TAGS on an index fires `table_modified` on the OWNING table
		// with the updated index in `tableSchema.indexes` — or, for an exposed
		// implicit index, with the updated `exposedIndexTags` on the originating
		// UNIQUE constraint — so the changed DDL re-persists here with no
		// index-specific plumbing. An identical bundle is what makes a structural
		// ALTER (and the createIndex follow-up event) a no-op — no double-write.
		const newDDL = this.buildCatalogEntry(newObject);
		const existingDDL = new TextDecoder().decode(existing);
		if (existingDDL === newDDL) return; // identical — no redundant write

		await catalogStore.put(key, new TextEncoder().encode(newDDL));
	}

	/**
	 * Resolve once all catalog writes queued by async schema-change listeners
	 * (catalog-only tag swaps) have settled. A durability barrier: `closeAll` awaits
	 * it internally; callers/tests that need the persisted catalog current without a
	 * full close can await it directly. Never rejects — queued errors are logged in
	 * the chain.
	 */
	async whenCatalogPersisted(): Promise<void> {
		await this.persistQueue;
	}

	/**
	 * Close all stores.
	 */
	async closeAll(): Promise<void> {
		// Capture the stale-at-close MV set BEFORE the unsubscribe block clears
		// `subscribedDb`. Nothing between here and the marker write can change these
		// flags (closeAll only drains the persist queue and disconnects tables).
		// `stale` is in-memory-only runtime state — an MV whose row-time maintenance was
		// detached mid-session (any `table_modified` on a source: an ALTER, even a
		// `create index`) so subsequent source writes never reached its backing. Carrying
		// the names lets the next open exclude exactly those from the adopt fast path.
		//
		// No subscribed db (this module was opened but never rehydrated and never had a
		// store table created/connected) ⇒ the empty set: every path that can mark an MV
		// stale requires a session in which this module observed the db — a store source
		// create/connect (both call `ensureSchemaSubscription`) or `rehydrateCatalog`
		// (subscribes up front) — so a session without `subscribedDb` never detached any
		// persisted MV's maintenance. Memory-backed MVs that appear in the set are
		// harmless: their catalog entries always refill (no phase-1 pre-existing backing),
		// so withholding trust from them is a no-op.
		const staleAtClose = this.subscribedDb
			? this.subscribedDb.schemaManager.getAllMaintainedTables()
				.filter(mv => mv.derivation.stale)
				.map(mv => `${mv.schemaName}.${mv.name}`.toLowerCase())
			: [];

		// Stop listening first so no new persist work is enqueued mid-close, then drain
		// the queued catalog writes (tag swaps) before the provider closes.
		if (this.schemaListenerUnsub) {
			this.schemaListenerUnsub();
			this.schemaListenerUnsub = undefined;
			this.subscribedDb = undefined;
		}
		await this.persistQueue;

		for (const table of this.tables.values()) {
			await table.disconnect();
		}
		this.tables.clear();
		this.moduleCoordinator = undefined;

		// Every batch has flushed (persist queue drained, tables disconnected):
		// attest the clean shutdown so the next open may take the materialized-view
		// adopt fast path. The marker VALUE is the JSON stale-at-close set (`[]` when
		// nothing is stale) — `rehydrateCatalog` excludes those MVs from the fast path
		// so they refill. Consumed (single-use) by `rehydrateCatalog`. Written LAST,
		// immediately before the provider closes — anything that dies before this line
		// leaves no marker and the next open refills everything.
		const catalogStore = await this.provider.getCatalogStore();
		await catalogStore.put(
			buildMetaCatalogKey(CLEAN_SHUTDOWN_META_NAME),
			new TextEncoder().encode(JSON.stringify(staleAtClose)),
		);

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
 * Reconcile each text PRIMARY KEY column's declared collation at CREATE time.
 *
 * The store now encodes PRIMARY KEY uniqueness/ordering PHYSICALLY with a
 * PER-COLUMN key collation (`StoreTable.pkKeyCollations`, drawn from each PK
 * column's declared `collation`), so ANY declared PK collation is honored
 * natively — an explicit `collate binary` text PK is keyed under BINARY, a
 * `collate nocase` under NOCASE, etc. The only thing this reconcile still does is
 * supply the store's table-level DEFAULT (`keyCollation` = K = `config.collation`,
 * default NOCASE) to a text PK column that declares NO explicit collation, so an
 * implicit-default text PK keeps the store's historical NOCASE-keyed behavior
 * (rather than the engine's BINARY column default). An EXPLICIT collation — even
 * one diverging from K — is left exactly as declared and re-keyed natively.
 *
 * Collation governs key bytes only for text, so only PK members whose logical type
 * is textual are touched (an `integer primary key` keeps its BINARY; temporal
 * text-physical types carry no collation). Non-PK columns are never touched.
 *
 * This is the CREATE path only — the load path (`connect` / rehydrate) does not
 * reconcile; the persisted DDL is the source of truth on reopen, and the column's
 * (BINARY-elided) `COLLATE` clause round-trips the per-column key collation.
 *
 * Returns the schema unchanged when no implicit text PK column needs the default
 * applied; otherwise a new schema with a rebuilt `columns` array + `columnIndexMap`.
 */
function reconcilePkCollations(
	schema: TableSchema,
	keyCollation: string,
): TableSchema {
	const pkIndices = new Set(schema.primaryKeyDefinition.map(def => def.index));
	if (pkIndices.size === 0) return schema;

	let changed = false;
	const newColumns = schema.columns.map((col, idx) => {
		if (!pkIndices.has(idx)) return col;
		// Collation governs key bytes only for text; non-text PK columns (integer,
		// real, blob, …) are encoded type-natively and keep their declared collation.
		if (!col.logicalType.isTextual) return col;
		// An EXPLICIT collation is honored as-declared — the per-column key encoding
		// keys the column under it (Option B physical re-key parity with memory).
		if (col.collationExplicit) return col;
		const declared = (col.collation || 'BINARY').toUpperCase();
		if (declared === keyCollation) return col; // implicit default already == K

		// Implicit default diverges from K (e.g. the engine's BINARY column default
		// under the store's NOCASE K): apply the store's table-level default so an
		// undecorated text PK keeps the store's historical NOCASE-keyed semantics.
		changed = true;
		return { ...col, collation: keyCollation };
	});

	if (!changed) return schema;
	const columns = Object.freeze(newColumns);
	return { ...schema, columns, columnIndexMap: buildColumnIndexMap(columns) };
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
