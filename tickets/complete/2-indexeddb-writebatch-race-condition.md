description: IndexedDB WriteBatch.write() race with database upgrade — fixed and tested
files:
  - packages/quereus-plugin-indexeddb/src/store.ts
  - packages/quereus-plugin-indexeddb/src/manager.ts
  - packages/quereus-plugin-indexeddb/test/store.spec.ts
----

## Summary

`IndexedDBWriteBatch.write()` and `MultiStoreWriteBatch.write()` used a synchronous `getDatabase()` call, which returned null during version upgrades (when `doUpgrade()` closes the connection). This caused "Database not open" errors during sync metadata writes, risking CRDT data loss.

## Fix

- **store.ts**: Both `IndexedDBWriteBatch.write()` and `MultiStoreWriteBatch.write()` now call `await this.manager.ensureOpen()` instead of `this.manager.getDatabase()`. This waits for any in-progress upgrade to complete via `upgradePromise` before obtaining the database handle.

- **manager.ts**: `deleteObjectStore()` now serializes via `upgradePromise` the same way `ensureObjectStore()` does, preventing concurrent delete + write races. Added missing `onblocked` handler to `doDeleteObjectStore()` for diagnostic parity with `doUpgrade()`.

- **cached-kv-store.ts**: `CachedWriteBatch.write()` delegates to its inner batch, so the fix flows through automatically — no changes needed.

## Testing

- New test: "should complete write batch during a concurrent version upgrade" in `store.spec.ts`. Triggers a version upgrade via `ensureObjectStore()`, yields one microtask tick so the upgrade is in-flight, then fires `batch.write()`. Verifies both the write and the upgrade succeed without error.

- All 51 IndexedDB plugin tests pass.

## Design note

The fix serializes writes against upgrades via `upgradePromise`. Writes that are already in-flight as IDB transactions when a `versionchange` fires will be aborted by IndexedDB itself — this is expected browser behavior and not preventable. The fix prevents *new* writes from hitting a closed database handle.
