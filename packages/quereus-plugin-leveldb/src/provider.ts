/**
 * LevelDB KVStore provider implementation.
 *
 * Manages LevelDB stores for the StoreModule.
 *
 * Storage naming convention:
 *   {basePath}/{schema}/{table}              - Data store (row data)
 *   {basePath}/{schema}/{table}_idx_{name}   - Index store (secondary indexes)
 *   {basePath}/__stats__                     - Unified stats store (row counts for all tables)
 *   {basePath}/__catalog__                   - Catalog store (DDL metadata)
 */

import path from 'node:path';
import fs from 'node:fs';
import type { KVStore, KVStoreProvider } from '@quereus/store';
import { STORE_SUFFIX, CATALOG_STORE_NAME, STATS_STORE_NAME } from '@quereus/store';
import { LevelDBStore } from './store.js';

/**
 * Options for creating a LevelDB provider.
 */
export interface LevelDBProviderOptions {
	/**
	 * Base path for all LevelDB stores.
	 * Each table gets a subdirectory under this path.
	 */
	basePath: string;

	/**
	 * Create directories if they don't exist.
	 * @default true
	 */
	createIfMissing?: boolean;
}

/**
 * LevelDB implementation of KVStoreProvider.
 *
 * Creates separate LevelDB databases for each table, stored
 * in subdirectories under the configured base path.
 */
export class LevelDBProvider implements KVStoreProvider {
	private basePath: string;
	private createIfMissing: boolean;
	private stores = new Map<string, LevelDBStore>();
	private storePaths = new Map<string, string>();
	// In-flight opens, keyed by store name, so concurrent getOrCreateStore calls
	// for the same store share a single LevelDB handle instead of each racing to
	// open the directory (LevelDB holds an exclusive LOCK; the loser throws).
	private storeOpening = new Map<string, Promise<LevelDBStore>>();
	private catalogStore: LevelDBStore | null = null;
	private catalogStoreOpening: Promise<LevelDBStore> | null = null;
	private statsStore: LevelDBStore | null = null;
	private statsStoreOpening: Promise<LevelDBStore> | null = null;

	constructor(options: LevelDBProviderOptions) {
		this.basePath = options.basePath;
		this.createIfMissing = options.createIfMissing ?? true;
	}

	async getStore(schemaName: string, tableName: string, options?: Record<string, unknown>): Promise<KVStore> {
		const storeName = `${schemaName}.${tableName}`.toLowerCase();
		const storePath = (options?.path as string) || path.join(this.basePath, schemaName, tableName);
		return this.getOrCreateStore(storeName, storePath);
	}

	async getIndexStore(schemaName: string, tableName: string, indexName: string): Promise<KVStore> {
		const storeName = `${schemaName}.${tableName}${STORE_SUFFIX.INDEX}${indexName}`.toLowerCase();
		const storePath = path.join(this.basePath, schemaName, `${tableName}${STORE_SUFFIX.INDEX}${indexName}`);
		return this.getOrCreateStore(storeName, storePath);
	}

	async getStatsStore(_schemaName: string, _tableName: string): Promise<KVStore> {
		// Use the unified __stats__ store for all tables.
		if (this.statsStore) return this.statsStore;
		if (!this.statsStoreOpening) {
			const statsPath = path.join(this.basePath, STATS_STORE_NAME);
			this.statsStoreOpening = LevelDBStore.open({
				path: statsPath,
				createIfMissing: this.createIfMissing,
			}).then(store => {
				this.statsStore = store;
				this.statsStoreOpening = null;
				return store;
			}).catch(err => {
				this.statsStoreOpening = null;
				throw err;
			});
		}
		return this.statsStoreOpening;
	}

	async getCatalogStore(): Promise<KVStore> {
		// Memoize the in-flight open so concurrent callers (e.g. a lazy DDL flush
		// racing an ALTER's own catalog write) share a single handle. Caching only
		// the resolved store left a window where a second caller passed the null
		// check and opened a duplicate handle, which LevelDB's exclusive LOCK rejects.
		if (this.catalogStore) return this.catalogStore;
		if (!this.catalogStoreOpening) {
			const catalogPath = path.join(this.basePath, CATALOG_STORE_NAME);
			this.catalogStoreOpening = LevelDBStore.open({
				path: catalogPath,
				createIfMissing: this.createIfMissing,
			}).then(store => {
				this.catalogStore = store;
				this.catalogStoreOpening = null;
				return store;
			}).catch(err => {
				this.catalogStoreOpening = null;
				throw err;
			});
		}
		return this.catalogStoreOpening;
	}

	async closeStore(schemaName: string, tableName: string): Promise<void> {
		const storeName = `${schemaName}.${tableName}`.toLowerCase();
		await this.closeStoreByName(storeName);
	}

	async closeIndexStore(schemaName: string, tableName: string, indexName: string): Promise<void> {
		const storeName = `${schemaName}.${tableName}${STORE_SUFFIX.INDEX}${indexName}`.toLowerCase();
		await this.closeStoreByName(storeName);
	}

	async closeAll(): Promise<void> {
		// Await any in-flight opens first so we don't strand a freshly-opened
		// handle (and its file LOCK) after clearing the maps below.
		await Promise.allSettled([
			...this.storeOpening.values(),
			this.catalogStoreOpening,
			this.statsStoreOpening,
		].filter(Boolean) as Promise<unknown>[]);

		for (const store of this.stores.values()) {
			await store.close();
		}
		this.stores.clear();
		this.storeOpening.clear();

		if (this.catalogStore) {
			await this.catalogStore.close();
			this.catalogStore = null;
		}
		this.catalogStoreOpening = null;

		if (this.statsStore) {
			await this.statsStore.close();
			this.statsStore = null;
		}
		this.statsStoreOpening = null;
	}

	async deleteIndexStore(schemaName: string, tableName: string, indexName: string): Promise<void> {
		const storeName = `${schemaName}.${tableName}${STORE_SUFFIX.INDEX}${indexName}`.toLowerCase();
		const storePath = this.storePaths.get(storeName)
			?? path.join(this.basePath, schemaName, `${tableName}${STORE_SUFFIX.INDEX}${indexName}`);
		await this.closeStoreByName(storeName);
		await removeDir(storePath);
	}

	async renameTableStores(schemaName: string, oldName: string, newName: string, indexNames: readonly string[]): Promise<void> {
		const oldDataStoreName = `${schemaName}.${oldName}`.toLowerCase();
		const newDataStoreName = `${schemaName}.${newName}`.toLowerCase();

		if (this.stores.has(newDataStoreName)) {
			throw new Error(`Cannot rename '${oldName}' to '${newName}': store already open under the new name`);
		}

		// Plan every directory move up front and check ALL destinations before
		// touching anything: a destination check interleaved with the moves would
		// fail only after earlier directories had already relocated, leaving a
		// half-renamed table (and on POSIX, renaming onto an existing EMPTY
		// directory succeeds — a silent clobber, not even an error). Source paths
		// mirror getStore/getIndexStore (original-case `{table}` /
		// `{table}_idx_{index}`), and only directories named in the schema are
		// moved rather than readdir-scanning the `{oldName}_idx_` prefix (which
		// would relocate a sibling table's directory too).
		const schemaDir = path.join(this.basePath, schemaName);
		const moves: Array<{ from: string; to: string }> = [];
		const planMove = async (from: string, to: string) => {
			if (!(await pathExists(from))) return; // not yet materialized — nothing to move
			if (await pathExists(to)) {
				throw new Error(`Cannot rename '${oldName}' to '${newName}': destination path '${to}' already exists`);
			}
			moves.push({ from, to });
		};
		await planMove(path.join(schemaDir, oldName), path.join(schemaDir, newName));
		for (const indexName of indexNames) {
			await planMove(
				path.join(schemaDir, `${oldName}${STORE_SUFFIX.INDEX}${indexName}`),
				path.join(schemaDir, `${newName}${STORE_SUFFIX.INDEX}${indexName}`),
			);
		}

		// Close all open handles for the old table (data + indexes) so LevelDB
		// releases its file locks before we move the directories. Index handles are
		// closed by exact store key, not by scanning `{oldName}_idx_` — that prefix
		// also matches a sibling table named `{oldName}_idx_<x>`.
		await this.closeStoreByName(oldDataStoreName);
		for (const indexName of indexNames) {
			await this.closeStoreByName(`${schemaName}.${oldName}${STORE_SUFFIX.INDEX}${indexName}`.toLowerCase());
		}

		for (const { from, to } of moves) {
			await fs.promises.rename(from, to);
		}
	}

	async deleteTableStores(schemaName: string, tableName: string, indexNames: readonly string[]): Promise<void> {
		// Close and remove data store directory
		const dataStoreName = `${schemaName}.${tableName}`.toLowerCase();
		const dataStorePath = this.storePaths.get(dataStoreName)
			?? path.join(this.basePath, schemaName, tableName);
		await this.closeStoreByName(dataStoreName);
		await removeDir(dataStorePath);

		// Stats are in the unified __stats__ store, so no need to close a separate store
		// The individual stats entry will be removed by the calling code if needed

		// Close and remove exactly the table's index directories (by name). This
		// also covers the post-restart case — the names come from the rehydrated
		// schema — without the ambiguity of a `{tableName}_idx_` directory sweep,
		// which would also delete a sibling table named `{tableName}_idx_<x>`.
		// Tradeoff: a truly orphaned index dir not present in the schema (e.g. left
		// by a crash mid-DROP INDEX) is no longer incidentally swept.
		const schemaDir = path.join(this.basePath, schemaName);
		for (const indexName of indexNames) {
			const storeName = `${schemaName}.${tableName}${STORE_SUFFIX.INDEX}${indexName}`.toLowerCase();
			const indexPath = this.storePaths.get(storeName)
				?? path.join(schemaDir, `${tableName}${STORE_SUFFIX.INDEX}${indexName}`);
			await this.closeStoreByName(storeName);
			await removeDir(indexPath);
		}
	}

	private async getOrCreateStore(storeName: string, storePath: string): Promise<LevelDBStore> {
		const existing = this.stores.get(storeName);
		if (existing) return existing;

		// Share a single in-flight open across concurrent callers for the same
		// store name; opening a second LevelDB handle on the same directory while
		// the first is still open trips the exclusive LOCK.
		let opening = this.storeOpening.get(storeName);
		if (!opening) {
			opening = LevelDBStore.open({
				path: storePath,
				createIfMissing: this.createIfMissing,
			}).then(store => {
				this.stores.set(storeName, store);
				this.storePaths.set(storeName, storePath);
				this.storeOpening.delete(storeName);
				return store;
			}).catch(err => {
				this.storeOpening.delete(storeName);
				throw err;
			});
			this.storeOpening.set(storeName, opening);
		}
		return opening;
	}

	private async closeStoreByName(storeName: string): Promise<void> {
		const store = this.stores.get(storeName);
		if (store) {
			// Remove from maps before awaiting close, so a concurrent
			// getOrCreateStore cannot observe a store that is about to be closed.
			this.stores.delete(storeName);
			this.storePaths.delete(storeName);
			await store.close();
		}
	}
}

async function removeDir(dirPath: string): Promise<void> {
	await fs.promises.rm(dirPath, { recursive: true, force: true });
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await fs.promises.access(p);
		return true;
	} catch {
		return false;
	}
}

/**
 * Create a LevelDB provider with the given options.
 */
export function createLevelDBProvider(options: LevelDBProviderOptions): LevelDBProvider {
	return new LevelDBProvider(options);
}
