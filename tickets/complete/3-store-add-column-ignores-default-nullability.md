description: StoreModule.alterTable now honors session-level default_column_nullability for ADD COLUMN and RENAME COLUMN, matching the memory layer manager
files:
  packages/quereus-store/src/common/store-module.ts
  packages/quereus-store/test/alter-table.spec.ts
  packages/quereus-store/test/rehydrate-catalog.spec.ts
----

## What was built

`StoreModule.alterTable` previously hard-coded `defaultNotNull=false` when
reconstructing a `ColumnSchema` for ADD COLUMN and RENAME COLUMN, ignoring the
session option `default_column_nullability` (default `'not_null'`). Memory
mode resolves that option through the layer manager, so an unannotated
`alter table t add column x text` was nullable under store mode but NOT NULL
under memory mode — diverging at `41-alter-table.sqllogic:131` under
`yarn test:store`.

**Fix** in `packages/quereus-store/src/common/store-module.ts`:

- Line 403: `const defaultNotNull = db.options.getStringOption('default_column_nullability') === 'not_null'` computed once at top of `alterTable`.
- Line 407 (`addColumn`): `columnDefToSchema(change.columnDef, defaultNotNull)` — flag threaded in.
- Line 522 (`renameColumn`): `columnDefToSchema(change.newColumnDefAst, defaultNotNull)` — flag threaded in.
- Previously-unused `_db` parameter renamed to `db` since it is now read.

The `dropColumn`, `alterPrimaryKey`, and `alterColumn` branches are unaffected — they do not reconstruct a column from a `ColumnDef` AST.

## Key files

- `packages/quereus-store/src/common/store-module.ts` — fix (lines 403, 407, 522)
- `packages/quereus-store/test/alter-table.spec.ts` — explicit `NULL` annotations on populated-table cases; new dedicated guard test (lines 179–200)
- `packages/quereus-store/test/rehydrate-catalog.spec.ts` — explicit `NULL` on APPLY-SCHEMA migration case
- `packages/quereus/test/logic/41-alter-table.sqllogic` — line 131 now passes under store mode

## Validation

- `yarn test` — 121 passing (memory mode)
- `yarn workspace @quereus/store test` — 223 passing
- `yarn test:store` — 566 passing, 19 pending, 1 pre-existing unrelated failure (`50-declarative-schema.sqllogic:274` — "Deferred constraint execution found multiple candidate connections for table test2.a")
