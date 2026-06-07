/**
 * IndexedDB KVStore provider implementation.
 *
 * Uses a unified single-database architecture where all tables share one
 * IndexedDB database with multiple object stores (one per table).
 * This enables cross-table atomic transactions using native IDB transaction support.
 *
 * Storage naming convention:
 *   {schema}.{table}              - Data store (row data)
 *   {schema}.{table}_idx_{name}   - Index store (secondary indexes)
 *   __stats__                     - Unified stats store (row counts for all tables)
 *   __catalog__                   - Catalog store (DDL metadata)
 */

import type { KVStore, KVStoreProvider } from '@quereus/store';
import {
	buildDataStoreName,
	buildIndexStoreName,
	CachedKVStore,
	CATALOG_STORE_NAME,
	STATS_STORE_NAME,
	STORE_SUFFIX,
	type CacheOptions,
} from '@quereus/store';
import { IndexedDBStore } from './store.js';
import { IndexedDBManager } from './manager.js';

/**
 * Options for creating an IndexedDB provider.
 */
export interface IndexedDBProviderOptions {
	/**
	 * Name for the unified IndexedDB database.
	 * All tables share this single database with separate object stores.
	 * @default 'quereus'
	 */
	databaseName?: string;

	/**
	 * Read cache configuration.
	 * Wraps each data/index store with an in-memory LRU cache.
	 */
	cache?: CacheOptions;
}

/**
 * IndexedDB implementation of KVStoreProvider.
 *
 * Uses a unified single-database architecture where all tables share one
 * IndexedDB database with multiple object stores (one per table).
 */
export class IndexedDBProvider implements KVStoreProvider {
	private databaseName: string;
	private stores = new Map<string, KVStore>();
	private catalogStore: IndexedDBStore | null = null;
	private statsStore: IndexedDBStore | null = null;
	private manager: IndexedDBManager;
	private cacheOptions: CacheOptions | undefined;

	constructor(options: IndexedDBProviderOptions = {}) {
		this.databaseName = options.databaseName ?? 'quereus';
		this.manager = IndexedDBManager.getInstance(this.databaseName);
		this.cacheOptions = options.cache;
	}

	async getStore(schemaName: string, tableName: string, _options?: Record<string, unknown>): Promise<KVStore> {
		const storeName = buildDataStoreName(schemaName, tableName);
		return this.getOrCreateStore(storeName);
	}

	async getIndexStore(schemaName: string, tableName: string, indexName: string): Promise<KVStore> {
		const storeName = buildIndexStoreName(schemaName, tableName, indexName);
		return this.getOrCreateStore(storeName);
	}

	async getStatsStore(_schemaName: string, _tableName: string): Promise<KVStore> {
		// Use the unified __stats__ store for all tables
		if (!this.statsStore) {
			this.statsStore = await IndexedDBStore.openForTable(
				this.databaseName,
				STATS_STORE_NAME
			);
		}
		return this.statsStore;
	}

	async getCatalogStore(): Promise<KVStore> {
		if (!this.catalogStore) {
			this.catalogStore = await IndexedDBStore.openForTable(
				this.databaseName,
				CATALOG_STORE_NAME
			);
		}
		return this.catalogStore;
	}

	async closeStore(schemaName: string, tableName: string): Promise<void> {
		const storeName = buildDataStoreName(schemaName, tableName);
		await this.closeStoreByName(storeName);
	}

	async closeIndexStore(schemaName: string, tableName: string, indexName: string): Promise<void> {
		const storeName = buildIndexStoreName(schemaName, tableName, indexName);
		await this.closeStoreByName(storeName);
	}

	async closeAll(): Promise<void> {
		for (const store of this.stores.values()) {
			await store.close();
		}
		this.stores.clear();

		if (this.catalogStore) {
			await this.catalogStore.close();
			this.catalogStore = null;
		}

		if (this.statsStore) {
			await this.statsStore.close();
			this.statsStore = null;
		}

		// Close the shared database manager
		await this.manager.close();
	}

	async deleteIndexStore(schemaName: string, tableName: string, indexName: string): Promise<void> {
		const storeName = buildIndexStoreName(schemaName, tableName, indexName);
		await this.closeStoreByName(storeName);
		await this.manager.deleteObjectStore(storeName);
	}

	async renameTableStores(schemaName: string, oldName: string, newName: string): Promise<void> {
		const oldDataStoreName = buildDataStoreName(schemaName, oldName);
		const newDataStoreName = buildDataStoreName(schemaName, newName);

		// Up-front collision guard, mirroring LevelDB's "destination already exists".
		if (this.manager.hasObjectStore(newDataStoreName)) {
			throw new Error(`Cannot rename table '${oldName}' to '${newName}': data store '${newDataStoreName}' already exists`);
		}

		// Build the rename list from the actual object stores: the data store (if
		// it materialized) plus every secondary-index store under the old name.
		const renameList: Array<{ from: string; to: string }> = [];
		if (this.manager.hasObjectStore(oldDataStoreName)) {
			renameList.push({ from: oldDataStoreName, to: newDataStoreName });
		}

		const oldIndexPrefix = `${oldDataStoreName}${STORE_SUFFIX.INDEX}`;
		for (const name of this.manager.getObjectStoreNames()) {
			if (!name.startsWith(oldIndexPrefix)) continue;
			const indexName = name.substring(oldIndexPrefix.length);
			const target = buildIndexStoreName(schemaName, newName, indexName);
			if (this.manager.hasObjectStore(target)) {
				throw new Error(`Cannot rename table '${oldName}' to '${newName}': index store '${target}' already exists`);
			}
			renameList.push({ from: name, to: target });
		}

		// Evict cached handles for every source store BEFORE the relocation so no
		// stale IndexedDBStore/CachedKVStore points at an object store that is about
		// to be deleted. __stats__ is the unified stats store and is left untouched —
		// StoreModule.renameTable relocates the stats key itself.
		for (const { from } of renameList) {
			await this.closeStoreByName(from);
		}

		await this.manager.renameObjectStores(renameList);
	}

	async deleteTableStores(schemaName: string, tableName: string): Promise<void> {
		const dataStoreName = buildDataStoreName(schemaName, tableName);

		// Close and delete data store
		await this.closeStoreByName(dataStoreName);
		if (this.manager.hasObjectStore(dataStoreName)) {
			await this.manager.deleteObjectStore(dataStoreName);
		}

		// Stats are in the unified __stats__ store, so no need to delete a separate store
		// The individual stats entry will be removed by the calling code if needed

		// Find and delete all index stores for this table
		const indexPrefix = `${dataStoreName}${STORE_SUFFIX.INDEX}`;
		const allStores = this.manager.getObjectStoreNames();
		for (const name of allStores) {
			if (name.startsWith(indexPrefix)) {
				await this.closeStoreByName(name);
				await this.manager.deleteObjectStore(name);
			}
		}
	}

	/**
	 * Get the underlying IndexedDB manager for advanced operations.
	 */
	getManager(): IndexedDBManager {
		return this.manager;
	}

	/**
	 * Invalidate the read cache for a specific table's data and index stores.
	 * Called by cross-tab sync when remote data changes are detected.
	 */
	invalidateCache(schemaName: string, tableName: string): void {
		const dataStoreName = buildDataStoreName(schemaName, tableName);
		const indexPrefix = `${dataStoreName}${STORE_SUFFIX.INDEX}`;

		for (const [name, store] of this.stores) {
			if ((name === dataStoreName || name.startsWith(indexPrefix)) && store instanceof CachedKVStore) {
				store.invalidateAll();
			}
		}
	}

	/**
	 * Invalidate all read caches. Called on remote data change events
	 * when the affected store is unknown.
	 */
	invalidateAllCaches(): void {
		for (const store of this.stores.values()) {
			if (store instanceof CachedKVStore) {
				store.invalidateAll();
			}
		}
	}

	private async getOrCreateStore(storeName: string): Promise<KVStore> {
		let store = this.stores.get(storeName);

		if (!store) {
			const raw = await IndexedDBStore.openForTable(this.databaseName, storeName);

			if (!raw) {
				throw new Error(`IndexedDBStore.openForTable returned null/undefined for ${storeName}`);
			}

			store = this.cacheOptions?.enabled === false
				? raw
				: new CachedKVStore(raw, this.cacheOptions);
			this.stores.set(storeName, store);
		}

		return store;
	}

	private async closeStoreByName(storeName: string): Promise<void> {
		const store = this.stores.get(storeName);
		if (store) {
			await store.close();
			this.stores.delete(storeName);
		}
	}
}

/**
 * Create an IndexedDB provider with the given options.
 */
export function createIndexedDBProvider(options?: IndexedDBProviderOptions): IndexedDBProvider {
	return new IndexedDBProvider(options);
}
