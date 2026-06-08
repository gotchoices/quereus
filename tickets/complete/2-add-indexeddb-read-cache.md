description: Read-through in-memory LRU cache for IndexedDB KVStore — eliminates redundant IDB transactions
files:
  - packages/quereus-store/src/common/cached-kv-store.ts (CachedKVStore class)
  - packages/quereus-store/src/common/index.ts (re-exports CachedKVStore, CacheOptions)
  - packages/quereus-plugin-indexeddb/src/provider.ts (wraps data/index stores with CachedKVStore)
  - packages/quereus-plugin-indexeddb/src/plugin.ts (cache config in IndexedDBPluginConfig)
  - packages/quereus-plugin-indexeddb/src/broadcast.ts (cross-tab cache invalidation)
  - packages/quereus-plugin-indexeddb/test/cache.spec.ts (21 tests)
  - packages/quereus-store/README.md (added CachedKVStore to API table)
  - packages/quereus-plugin-indexeddb/README.md (added cache feature and config docs)
----

## What was built

A `CachedKVStore` wrapper in `@quereus/store` adds read-through in-memory LRU caching
to any `KVStore`. Integrated into the IndexedDB plugin so every data and index store is
automatically wrapped (stats and catalog stores excluded). Enabled by default.

### Cache semantics

- **get()/has()** — cache-first; on miss, reads from underlying and populates cache (including negative entries for absent keys)
- **put()** — write-through; writes to underlying then updates cache
- **delete()** — write-through; deletes from underlying then inserts negative cache entry
- **iterate()/approximateCount()** — always delegates to underlying (no range caching)
- **batch()** — delegates to underlying; invalidates all batch keys on `write()`
- **invalidate(key)/invalidateAll()** — public methods for external invalidation

### Cross-tab invalidation

`CrossTabSync` accepts an optional `IndexedDBProvider` reference. On receiving a remote
`DataChangeEvent`, it invalidates the affected table's data and index caches. Falls back
to `invalidateAllCaches()` if schema/table info is missing.

### Configuration

```typescript
await registerPlugin(db, indexeddbPlugin, {
  databaseName: 'myapp',
  cache: { maxEntries: 2000, maxBytes: 5_000_000, enabled: true }
});
```

## Review fixes applied

1. **Race condition in `addEntry()`** — Two concurrent `get()` calls for the same key could
   both miss, both call `addEntry`, and the second would orphan the first node in the linked
   list (leaking memory, double-counting bytes). Fixed by checking the map in `addEntry`
   before creating a new node.

2. **`invalidateCache()` only invalidated data stores** — Cross-tab changes now also
   invalidate all index store caches for the affected table (matched by store name prefix).

3. **DRY violation in `plugin.ts`** — Inline cache options type replaced with imported
   `CacheOptions` from `@quereus/store`.

4. **Documentation** — Added CachedKVStore/CacheOptions to the `@quereus/store` API table.
   Added cache feature bullet and configuration table to `@quereus/plugin-indexeddb` README.

## Testing

21 tests in `cache.spec.ts` (20 original + 1 concurrent-access race test).
50 total tests passing in the IndexedDB plugin package.

## Design note

The ticket's human update suggests 2Q (two-queue) eviction as potentially better for
database workloads. The current implementation uses pure LRU. A future enhancement could
convert to 2Q by maintaining a mid-insertion point in the linked list, promoting entries
to the hot segment only on second access.
