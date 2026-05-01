description: StoreModule now implements ALTER TABLE ... RENAME TO via a module-level renameTable hook on VirtualTableModule, with physical storage relocation delegated to the KVStoreProvider and persistent catalog rewritten under the new name.
files:
  packages/quereus/src/vtab/module.ts
  packages/quereus/src/vtab/memory/module.ts
  packages/quereus/src/runtime/emit/alter-table.ts
  packages/quereus-store/src/common/kv-store.ts
  packages/quereus-store/src/common/store-module.ts
  packages/quereus-plugin-leveldb/src/provider.ts
  packages/quereus-store/test/alter-table.spec.ts
----

### Summary

Adds RENAME TABLE support for store-backed (persistent) tables, fixing the original defect at `41-alter-table.sqllogic:104` where renaming a populated store table caused subsequent reads against the new name to return empty.

### What was built

- **`VirtualTableModule.renameTable(db, schemaName, oldName, newName): Promise<void>`** — new optional module-level hook (`packages/quereus/src/vtab/module.ts:207`). Modules that persist data keyed by table name (LevelDB, IndexedDB) implement it; in-memory modules can ignore it (the runtime no-ops).
- **`runRenameTable`** in `packages/quereus/src/runtime/emit/alter-table.ts` calls `module.renameTable` *before* mutating the in-memory schema catalog, so a module failure leaves the catalog untouched. The legacy `instanceof MemoryTableModule` special-case is gone.
- **`KVStoreProvider.renameTableStores(schemaName, oldName, newName)`** — new optional provider hook (`packages/quereus-store/src/common/kv-store.ts:218`). The LevelDB provider implements it: closes open handles for the data store and every `{oldName}_idx_*` store, then `fs.rename`s the directories under `{basePath}/{schema}/`, sweeping unopened index dirs via `readdir`.
- **`StoreModule.renameTable`** in `packages/quereus-store/src/common/store-module.ts:688` orchestrates: flushes pending coordinator ops (DDL-committing, consistent with DROP TABLE), disconnects the cached `StoreTable` (flushes lazy stats), drops `tables`/`stores`/`coordinators` map entries, delegates to `provider.renameTableStores`, writes the new catalog DDL, deletes the old catalog entry (new-first ordering for crash safety), removes the stale `__stats__` entry, and emits an `alter`/`table` schema-change event.
- **MemoryTableModule.renameTable** (`packages/quereus/src/vtab/memory/module.ts:507`) updated to the new async signature; behavior unchanged.

### Tests

Five new unit tests in `packages/quereus-store/test/alter-table.spec.ts` exercise an in-memory provider that implements `renameTableStores`:

- renames a populated table; reads under the new name return all rows
- inserts under the new name persist after rename
- the old name is no longer resolvable
- rename to an existing table errors with "already exists"
- persisted catalog DDL is rewritten under the new name (old key removed)

### Validation

- `yarn test` — all packages green (2443 quereus + 216 store + 121 workspace).
- `yarn workspace @quereus/store test` — 216 passing, including the 5 new RENAME TABLE cases.
- Store-mode logic tests advance past the original `41-alter-table.sqllogic:104` rename failure.

### Notes & known limitations

- **DDL-committing semantics**: rename flushes pending ops on the old coordinator before the physical move, since renaming a directory is not reversible. Subsequent `commit()` calls on the same coordinator are no-ops because `inTransaction` is cleared, keeping the enclosing transaction safe.
- **StoreConnection lifetime**: the stale `StoreConnection` registered with the database is not explicitly unregistered. Relies on the cleared coordinator state to make outer-tx `commit()` a no-op. The connection object lingers until the database is closed — acceptable for now.
- **Crash mid-rename**: the catalog `saveTableDDL` runs before `removeTableDDL`, so a crash there leaves the table discoverable under at least one name. There is still a window between provider rename and catalog rewrite where storage is at the new location but the catalog points at the old name; this matches the DDL-committing stance documented for DROP TABLE and would require WAL-style 2PC to close.
- **Follow-up filed separately**: store-mode `41-alter-table.sqllogic` now hits a pre-existing, unrelated failure in section 5 (ADD COLUMN `required text` should error with NOT NULL but succeeds). That is a discrepancy between `StoreModule.alterTable` (hard-codes `defaultNotNull=false`) and `MemoryTableLayerManager.addColumn` (reads `db.options.default_column_nullability`) — already filed as a fix ticket.
- **module-authoring.md** does not yet describe the new `renameTable` hook (or current `alterTable` model — the doc still references the older `VirtualTable.alterSchema` API). The TypeScript JSDoc on `VirtualTableModule.renameTable` is the source of truth for module authors. A doc revision pass is out of scope for this fix.
