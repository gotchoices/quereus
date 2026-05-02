description: IsolationModule.renameTable forwards to underlying module so ALTER TABLE RENAME TO works on store-backed isolated tables
files:
  packages/quereus-isolation/src/isolation-module.ts
  packages/quereus-isolation/test/isolation-layer.spec.ts
  packages/quereus/test/logic.spec.ts
  packages/quereus/test/logic/41-alter-table.sqllogic
----

## What was built

Bug fix in the isolation layer. `IsolationModule` previously did not implement `renameTable`, so the runtime's `runRenameTable` emitter (`packages/quereus/src/runtime/emit/alter-table.ts:84`) had no module-level rename to call when an isolated, store-backed table was renamed. The schema catalog was patched while the physical store remained keyed under the old name, so reads against the new name returned zero rows.

### `packages/quereus-isolation/src/isolation-module.ts`

- New `renameTable(db, schemaName, oldName, newName)`:
  - Forwards to `this.underlying.renameTable(...)` if the wrapped module implements it.
  - Drops the cached `UnderlyingTableState` for the old name. The cached `VirtualTable` may have been disconnected by the underlying module (e.g. `StoreModule` flushes the coordinator, closes the `StoreTable`, and re-creates fresh stores after `provider.renameTableStores`), so reusing it would surface "store is closed" errors. The next `connect()` under the new name lazily fetches a fresh underlying table.
  - Re-keys per-connection state (`connectionOverlays`, `preOverlaySavepoints`) so any in-flight overlay belonging to a still-open transaction remains addressable under the new name.
- New private helper `rekeyConnectionScopedMap` re-keys connection-scoped maps keyed `<dbId>:<schema>.<table>` from oldName to newName, preserving the connection-id prefix and leaving entries for other tables untouched.
- Order: underlying call first, then internal rekey. If the underlying throws, `IsolationModule`'s state is untouched, and `runRenameTable` propagates the throw before mutating the schema catalog — both layers stay in their pre-rename state.

### `packages/quereus/test/logic.spec.ts`

- Removed `41-alter-table.sqllogic` from `MEMORY_ONLY_FILES` — it now passes in store mode.

### `packages/quereus-isolation/test/isolation-layer.spec.ts`

- New `describe('rename table', ...)` block:
  - `preserves row data through ALTER TABLE RENAME TO` — regression for the original bug.
  - `allows writes against the renamed table` — verifies the new name is fully writable post-rename.

## Validation

- `yarn workspace @quereus/isolation test` → 64 passing (was 62 before; +2 new RENAME TABLE cases).
- `yarn test:store --grep "41-alter-table"` → 1 passing (was failing).
- `yarn test` (full memory-mode suite) → all packages pass.
- `yarn workspace @quereus/quereus lint` → 0 errors (only pre-existing warnings).

## Use cases covered

- `CREATE TABLE` + `INSERT` + `ALTER TABLE RENAME TO` + `SELECT` against store-backed isolated tables (autocommit). Rows are visible under the new name.
- Subsequent `INSERT` against the renamed table reuses the same physical storage (re-opened lazily under the new name on next `connect()`).
- `RENAME TABLE` issued mid-transaction with a populated overlay: the per-connection overlay and pre-overlay savepoint set are re-keyed under the new name. Not exercised by an explicit test (RENAME TABLE inside an explicit BEGIN is uncommon, and `StoreModule.renameTable` flushes the coordinator regardless), but the rekey helper is shape-correct for the connection-scoped key format.

## Reviewer notes

- The contract for `VirtualTableModule.renameTable` is not consistent across underlying modules: `MemoryTableModule` re-keys its manager in place, while `StoreModule` disconnects and re-creates. Discarding the cached underlying table reference and re-fetching on next `connect()` is correct for both.
- `IsolationModule` continues to track underlying state per `(schema, table)` and overlays per `(connection, schema, table)`. The fix preserves both layers' addressability after rename.
- `runRenameTable` (`packages/quereus/src/runtime/emit/alter-table.ts:84`) calls `module.renameTable` before mutating the schema catalog, so a failure in the underlying or isolation layer leaves both physical state and the catalog in their pre-rename state. No two-phase coordination is needed.
