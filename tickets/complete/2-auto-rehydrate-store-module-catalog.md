description: Auto-rehydrate persisted schema in StoreModule via rehydrateCatalog()
files:
  packages/quereus-store/src/common/store-module.ts
  packages/quereus-store/src/common/index.ts
  packages/quereus-store/test/rehydrate-catalog.spec.ts
  packages/quoomb-web/src/worker/quereus.worker.ts
  docs/store.md
----

## What Was Built

`StoreModule.rehydrateCatalog(db)` — a single-call method that loads all persisted DDL from the catalog store and imports each entry into the in-memory schema manager with error tolerance. A corrupt or unparseable DDL entry is logged, collected, and skipped rather than preventing other tables from loading.

### API

```typescript
const result = await storeModule.rehydrateCatalog(db);
// result.tables:  string[]           — imported table names
// result.indexes: string[]           — imported index names
// result.errors:  RehydrationError[] — collected failures
```

Exported types: `RehydrationResult`, `RehydrationError` from `@quereus/store`.

### Usage

Call after `db.registerModule()` (and `db.setDefaultVtabName()` if DDL may lack a USING clause):

```typescript
const result = await storeModule.rehydrateCatalog(db);
```

Replaces the manual `loadAllDDL()` + `importCatalog()` pattern. Works for both IndexedDB and LevelDB plugins.

## Testing

Test file: `packages/quereus-store/test/rehydrate-catalog.spec.ts` (6 tests)

- Rehydrate single table, multiple tables, empty catalog
- Corrupt DDL tolerance (skipped with error, other tables load)
- APPLY SCHEMA after rehydrate (ALTER TABLE ADD COLUMN works, data preserved)
- APPLY SCHEMA no-op (identical schema produces no diff)

All 161 store tests pass. Build clean.

## Review Notes

- Docs updated: `docs/store.md` Schema Discovery section now documents `rehydrateCatalog()`.
- `loadAllDDL()` remains as a lower-level escape hatch.
- quoomb-web worker migrated to use `rehydrateCatalog()` with error surfacing.
