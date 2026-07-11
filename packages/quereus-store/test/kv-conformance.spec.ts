/**
 * Runs the shared KVStore conformance suite against the in-memory backend.
 *
 * The suite itself lives in `src/testing/` (so both plugins can import the built
 * `@quereus/store/testing`); this package imports it by relative path. In-memory is
 * non-persistent by design, so the adapter omits `reopen` and the persistence tier
 * is not registered for it.
 */

import { InMemoryKVStore } from '../src/common/memory-store.js';
import { runKVStoreConformance } from '../src/testing/kv-conformance.js';

runKVStoreConformance('InMemoryKVStore', () => ({
	open: async () => new InMemoryKVStore(),
	teardown: async () => {},
}));
