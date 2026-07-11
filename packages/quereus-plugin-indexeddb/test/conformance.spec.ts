/**
 * Runs the shared KVStore conformance suite against the IndexedDB backend, under
 * `fake-indexeddb/auto` in Node/Mocha (same harness as every other IndexedDB spec).
 * Real-browser execution is a separate concern — see
 * tickets/backlog/feat-indexeddb-real-browser-smoke.md.
 *
 * The suite lives in `@quereus/store/testing` (built to dist — run the store build,
 * or `yarn build`, before this spec so the import resolves). The adapter opens one
 * object store within a per-test database; `reopen` drops the manager/handle WITHOUT
 * deleting the database and re-opens it, so persisted data survives — driving the
 * persistence tier.
 */

import 'fake-indexeddb/auto';
import type { KVStore } from '@quereus/store';
import { runKVStoreConformance } from '@quereus/store/testing';
import { IndexedDBStore } from '../src/store.js';
import { IndexedDBManager } from '../src/manager.js';

const STORE_NAME = 'conformance-store';

// Per-test unique database name. A counter (not Date.now/random) keeps names stable
// and collision-free across the suite's many tests within one process.
let seq = 0;

/** Delete a fake-indexeddb database by name and await completion. */
function deleteDatabase(dbName: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const req = indexedDB.deleteDatabase(dbName);
		req.onsuccess = () => resolve();
		req.onerror = () => reject(req.error);
	});
}

runKVStoreConformance('IndexedDBStore', () => {
	const dbName = `quereus-kv-conf-idb-${seq++}`;
	let store: IndexedDBStore | undefined;

	async function dropHandles(): Promise<void> {
		if (store) await store.close();
		// Close + forget the singleton manager so a subsequent open re-reads the
		// persisted database from scratch (a genuine reopen), rather than reusing the
		// still-open in-memory handle.
		const manager = IndexedDBManager.getInstance(dbName);
		await manager.close();
		IndexedDBManager.resetInstance(dbName);
		store = undefined;
	}

	return {
		async open(): Promise<KVStore> {
			store = await IndexedDBStore.openForTable(dbName, STORE_NAME);
			return store;
		},
		async reopen(): Promise<KVStore> {
			await dropHandles(); // does NOT delete the database — data persists
			store = await IndexedDBStore.openForTable(dbName, STORE_NAME);
			return store;
		},
		async teardown(): Promise<void> {
			await dropHandles();
			await deleteDatabase(dbName);
		},
	};
});
