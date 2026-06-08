description: LevelDB provider now physically removes table/index directories on DROP so re-creating a table with the same name starts empty; fixes `apply schema … with seed` UNIQUE-PK violation in store mode.
prereq: none
files:
  packages/quereus-plugin-leveldb/src/provider.ts
  packages/quereus/test/logic/50-declarative-schema.sqllogic
----

## What was built

`LevelDBProvider.deleteTableStores` / `deleteIndexStore` previously only closed in-memory `LevelDBStore` handles. The on-disk `basePath/<schema>/<table>/` directory (and `<table>_idx_<name>` index dirs) survived, so a subsequent `CREATE TABLE <same name>` reopened the directory and returned previously-committed rows. The IndexedDB provider already called `manager.deleteObjectStore`, so the defect was LevelDB-only.

### Changes in `packages/quereus-plugin-leveldb/src/provider.ts`

- Added `storePaths: Map<string, string>` parallel to `stores`, populated in `getOrCreateStore`, so `options.path` overrides are honoured on delete.
- `deleteIndexStore` closes the store handle then `fs.promises.rm(dir, { recursive: true, force: true })` the resolved path.
- `deleteTableStores` closes & removes the data directory, closes & removes any opened index directories, and sweeps `basePath/<schema>/` for `<table>_idx_<name>` directories that were never opened in this session (handles post-restart DROP).
- `closeStoreByName` also drops the path entry so the map stays in sync.

## Use cases / validation

- Primary reproducer: `node packages/quereus/test-runner.mjs --store --grep "50-declarative"` — previously failed at line 332 (`UNIQUE constraint failed: primary key`) when re-seeding `users`. Now progresses past the seed block. Next failure is at line 671 (`select count(*) from assert_accounts` — assertion-rollback scenario) which is an unrelated transaction-isolation issue out of scope here.
- `yarn --cwd packages/quereus-plugin-leveldb test`: 12 passing, no regressions.
- `yarn --cwd packages/quereus test` (memory mode): 2443 passing, 2 pending — unchanged.

## Notes

- The LevelDB provider is Node-only (`classic-level`), so direct use of `fs.promises.rm` is appropriate; no cross-platform abstraction needed.
- Stats entries in the unified `__stats__` store are not cleaned up on DROP. Out of scope; follow-up only if stale stats keys become user-visible.
- `StoreModule.destroy` already invokes `provider.deleteTableStores` first; the fix makes the provider honour the "delete all on-disk stores for the table" contract the interface implies.
