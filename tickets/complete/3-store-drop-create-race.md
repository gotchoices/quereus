description: Serialized DROP TABLE destruction to eliminate the DROP/CREATE race against async store destruction
files:
  packages/quereus/src/schema/manager.ts
  packages/quereus-store/src/common/store-module.ts
  packages/quereus-plugin-leveldb/src/provider.ts
  docs/schema.md
----

## What was fixed

`SchemaManager.dropTable` previously kicked off `module.destroy(...)` and returned without awaiting it. Because `StoreModule.destroy` yields on `await table.disconnect()` and `await provider.deleteTableStores(...)`, a follow-up `CREATE TABLE` of the same name could observe the still-mapped old `LevelDBStore`, bind a new `StoreTable` to it, and then have its store closed and directory wiped when the in-flight destroy resumed. The next INSERT then hit "LevelDBStore is closed".

### Primary change
- `SchemaManager.dropTable` (`packages/quereus/src/schema/manager.ts:430`) is now `async` and `await`s the `destroyPromise` before returning. The sole caller (`packages/quereus/src/runtime/emit/drop-table.ts:24`) already awaited it, so no further wiring was needed.

### Defence in depth
- `LevelDBProvider.closeStoreByName` (`packages/quereus-plugin-leveldb/src/provider.ts:231`): deletes `stores`/`storePaths` map entries **before** `await store.close()` so a concurrent `getOrCreateStore` cannot return a handle that is about to be closed.
- `StoreModule.destroy` (`packages/quereus-store/src/common/store-module.ts:264`): clears `tables`, `stores`, and `coordinators` map entries synchronously at the top of the method, before any `await`, so a concurrent `create(...)` sees "no such table" across microtask boundaries instead of stale state.

### Docs
- `docs/schema.md` updated to reflect the new async signature and ordering.

## Testing

- `yarn build` — green.
- `yarn test` — 59 + 34 + 121 tests pass across packages.
- `yarn test:store` — 566 passing, 19 pending, 1 unrelated pre-existing failure (`50-declarative-schema.sqllogic:274`).
- The regression cases in `40-constraints.sqllogic` and `102-schema-catalog-edge-cases.sqllogic` pass under store mode.

## Out of scope (separate ticket)

The sibling `ALTER TABLE ... RENAME TO ...` StoreModule bug (`41-alter-table.sqllogic:104`) is unrelated to this race — `runRenameTable` in `packages/quereus/src/runtime/emit/alter-table.ts:83-87` only updates MemoryTableModule state and never tells StoreModule about the rename.

## Review notes

- `dropTable` signature change to `Promise<boolean>` is the only public-API change; the lone caller already awaited.
- Map-clear-before-await ordering in `StoreModule.destroy` is intentional: even if `table.disconnect()` throws, the maps are clean so the slot is recreatable.
- `closeStoreByName` reorder is safe: store handle is captured in a local before the map delete, so the subsequent `await store.close()` still targets the correct instance.
- `.catch` on `destroyPromise` is preserved, so a failing destroy still allows the schema removal event to fire — but `dropTable` only resolves once destroy has settled.
