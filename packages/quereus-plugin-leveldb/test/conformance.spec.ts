/**
 * Runs the shared KVStore conformance suite against the LevelDB backend.
 *
 * The suite lives in `@quereus/store/testing` (built to dist — run the store build,
 * or `yarn build`, before this spec so the import resolves). The adapter opens a
 * standalone LevelDBStore over a per-test temp directory; `reopen` re-opens the same
 * path WITHOUT wiping it, driving the persistence tier.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { KVStore } from '@quereus/store';
import { runKVStoreConformance } from '@quereus/store/testing';
import { LevelDBStore } from '../src/store.js';

// A per-test unique directory. A counter (not Date.now/random) keeps names stable and
// collision-free across the suite's many tests within one process.
let seq = 0;

runKVStoreConformance('LevelDBStore', () => {
	const dir = path.join(os.tmpdir(), `quereus-kv-conf-lvl-${process.pid}-${seq++}`);
	let store: LevelDBStore | undefined;

	return {
		async open(): Promise<KVStore> {
			fs.mkdirSync(dir, { recursive: true });
			store = await LevelDBStore.open({ path: dir });
			return store;
		},
		async reopen(): Promise<KVStore> {
			if (store) await store.close();
			store = await LevelDBStore.open({ path: dir }); // same path, data intact
			return store;
		},
		async teardown(): Promise<void> {
			if (store) await store.close();
			fs.rmSync(dir, { recursive: true, force: true });
			store = undefined;
		},
	};
});
