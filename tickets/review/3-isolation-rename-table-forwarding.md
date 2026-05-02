description: Review IsolationModule.renameTable forwarding to underlying module
prereq: none
files:
  packages/quereus-isolation/src/isolation-module.ts
  packages/quereus-isolation/test/isolation-layer.spec.ts
  packages/quereus/test/logic.spec.ts
  packages/quereus/test/logic/41-alter-table.sqllogic
----

## Summary

Bug fix: `IsolationModule` did not implement `renameTable`, so `ALTER TABLE ... RENAME TO` against an isolated store-backed table did not propagate to the underlying `StoreModule`. The runtime was patching the schema catalog while the physical store remained keyed under the old name, so subsequent reads against the new name returned zero rows.

## What changed

`packages/quereus-isolation/src/isolation-module.ts`:

- Added `renameTable(db, schemaName, oldName, newName)` that forwards to `this.underlying.renameTable` (if present), then re-keys our internal tracking maps.
- Drops `underlyingTables[oldKey]` rather than re-keying it. The cached `VirtualTable` may have been disconnected by the underlying module during rename (StoreModule closes its `StoreTable` and re-opens fresh stores after `provider.renameTableStores`), so reusing it would surface "store is closed" errors. The next `connect()` under the new name lazily fetches a fresh underlying table.
- Added private helper `rekeyConnectionScopedMap` that re-keys connection-scoped maps (`<dbId>:<schema>.<table>`) from oldName to newName, preserving the connection-id prefix. Used to migrate `connectionOverlays` and `preOverlaySavepoints` so any in-flight overlay state from a still-open transaction remains addressable under the new name.
- Order: underlying call first, then internal rekey. If underlying throws, our state is untouched; the engine will not patch the schema catalog because `runRenameTable` propagates the throw before `schema.removeTable`.

`packages/quereus/test/logic.spec.ts`:

- Removed `41-alter-table.sqllogic` from `MEMORY_ONLY_FILES`. It now passes in store mode.

`packages/quereus-isolation/test/isolation-layer.spec.ts`:

- Added `describe('rename table', ...)` block with two cases:
  - `preserves row data through ALTER TABLE RENAME TO` — regression for the original bug.
  - `allows writes against the renamed table` — verifies the new name is fully writable post-rename.

## Validation

- `yarn test:store --grep "41-alter-table"` — passes (was failing).
- `yarn workspace @quereus/isolation test` — 64 passing (was 62; +2 new RENAME TABLE cases).
- `yarn test:store` — 2437 passing, 8 pending (memory-only files), 0 failing.
- `yarn test` — all logic / unit tests pass. One unrelated flake in `Performance sentinels > bulk insert 1000 rows under 500 ms` (sometimes ~900 ms on this machine); passes on retry.
- `yarn workspace @quereus/quereus lint` — 0 errors, only pre-existing warnings.

## Use cases covered

- `CREATE TABLE` + `INSERT` + `ALTER TABLE RENAME TO` + `SELECT` against store-backed isolated tables (autocommit).
- Subsequent `INSERT` against the renamed table reuses the same physical storage (re-opened lazily under the new name).
- `RENAME TABLE` issued mid-transaction with a populated overlay: the per-connection overlay is re-keyed under the new name (covered by the connection-scoped map rekey, though not exercised by an explicit test — RENAME TABLE inside an explicit BEGIN is uncommon and may interact with module-specific commit behavior, e.g. `StoreModule.renameTable` flushes the coordinator).

## Reviewer notes

- `IsolationModule` historically tracked underlying state per (schema, table) and overlays per (connection, schema, table). The fix preserves both layers' addressability after rename.
- We discard the cached underlying table reference rather than re-keying it because the contract for the underlying `renameTable` is not consistent across modules: `MemoryTableModule` re-keys its manager in place, `StoreModule` disconnects and re-creates. Discarding and re-fetching on next `connect()` is correct for both.
- The `runRenameTable` runtime emitter (`packages/quereus/src/runtime/emit/alter-table.ts:84`) calls `module.renameTable` before mutating the schema catalog; a failure leaves both the underlying state and the catalog in their pre-rename state. No two-phase coordination is needed.
