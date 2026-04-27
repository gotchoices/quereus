description: StoreModule.alterTable now honors session-level default_column_nullability for ADD COLUMN and RENAME COLUMN, matching the memory layer manager
prereq: none
files:
  packages/quereus-store/src/common/store-module.ts
  packages/quereus-store/test/alter-table.spec.ts
  packages/quereus-store/test/rehydrate-catalog.spec.ts
----

### What changed

`StoreModule.alterTable` previously hardcoded `defaultNotNull=false` for both the addColumn and renameColumn branches, ignoring the session option `default_column_nullability` (default `'not_null'`). This caused `alter table t add column x text` to behave as nullable under store mode but as NOT NULL under memory mode, surfacing as a failure at `41-alter-table.sqllogic:131` under `yarn test:store`.

The fix: read `db.options.getStringOption('default_column_nullability')` once at the top of `alterTable`, compute `defaultNotNull = value === 'not_null'`, and pass that flag to both `columnDefToSchema` calls. The `_db` parameter was renamed to `db` to access the option.

### Use cases to validate

- `alter table t add column required text` on a populated table (no NULL, no NOT NULL annotation) under store mode now correctly raises the NOT NULL guard error, matching memory mode.
- `alter table t add column x text null` (explicit nullable) still works on a populated table.
- `alter table t add column x text` works after `pragma default_column_nullability='nullable'` (now nullable).
- RENAME COLUMN preserves the same default-nullability semantics for any reconstructed column schema.

### Test status

- `yarn test` — all memory-mode tests pass (2443 + workspaces).
- `yarn workspace @quereus/store test` — 216 unit tests pass. Tests in `alter-table.spec.ts` and `rehydrate-catalog.spec.ts` were updated to add explicit `NULL` annotations on ADD COLUMN against populated tables (their intent was always nullable; the prior pass relied on the buggy default).
- `yarn test:store` — `41-alter-table.sqllogic` now passes in full; the remaining single failure (`50-declarative-schema.sqllogic:274`) is unrelated (deferred constraint execution).

### TODO

- Confirm `yarn test`, `yarn workspace @quereus/store test`, and `yarn test:store` against the current branch.
