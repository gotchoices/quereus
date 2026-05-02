description: IsolationModule does not forward renameTable to the underlying StoreModule, causing RENAME TABLE to silently lose all data through the isolation layer
prereq: none
files:
  packages/quereus-isolation/src/isolation-module.ts
  packages/quereus/src/vtab/module.ts
  packages/quereus/test/logic/41-alter-table.sqllogic
  packages/quereus-store/src/common/store-module.ts
----

## Bug

`IsolationModule` (`packages/quereus-isolation/src/isolation-module.ts`) wraps an underlying `VirtualTableModule` (typically `StoreModule`) and exposes its own `VirtualTableModule` implementation for snapshot-isolated reads/writes.  When `ALTER TABLE ... RENAME TO` is executed, the runtime calls `module.renameTable(schemaName, oldName, newName)` on the registered module.  `IsolationModule` does not implement `renameTable`, so the call is silently dropped.  The underlying `StoreModule.renameTable` (which relocates physical storage and rewrites the catalog) is never called.  The in-memory schema catalog is updated by the runtime after the module hook returns (whether or not the hook was present), so subsequent queries against the new name resolve schema-wise but return empty results because the physical store is still keyed under the old name.

## Repro

Run `yarn test:store --grep "41-alter-table"` — fails at line 104: `select * from t_renamed order by id` returns 0 rows instead of 2.

## Root cause

`IsolationModule` has `alterTable` (line 329) but no `renameTable`.  The base `VirtualTableModule` interface makes `renameTable` optional, so no TypeScript error is raised.

## Fix

Add `renameTable` to `IsolationModule`:

```ts
async renameTable(db: Database, schemaName: string, oldName: string, newName: string): Promise<void> {
    if (this.underlying.renameTable) {
        await this.underlying.renameTable(db, schemaName, oldName, newName);
    }
}
```

This must be called before the runtime patches the in-memory catalog (matching the contract already documented on `StoreModule.renameTable`).  The isolation layer maintains overlay tables keyed by table name, so we also need to transfer any in-flight overlay entry from `oldName` to `newName` — or, since RENAME TABLE is a DDL operation that implicitly commits (consistent with DROP/CREATE), simply assert no overlay exists for the table at rename time and drop any stale overlay state.

## Validation

- `yarn test:store --grep "41-alter-table"` passes.
- Remove `41-alter-table.sqllogic` from `MEMORY_ONLY_FILES` in `packages/quereus/test/logic.spec.ts` after the fix lands.
- `yarn test:store` and `yarn test` remain green.

## TODO

- Implement `IsolationModule.renameTable` that delegates to `this.underlying.renameTable` and clears any overlay state for the old table name.
- Remove `41-alter-table.sqllogic` from `MEMORY_ONLY_FILES`.
- Add a test case in `packages/quereus-isolation/test/isolation-layer.spec.ts` covering RENAME TABLE through the isolation layer.
