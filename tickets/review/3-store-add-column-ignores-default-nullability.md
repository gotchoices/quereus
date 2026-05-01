description: StoreModule.alterTable now honors session-level default_column_nullability for ADD COLUMN and RENAME COLUMN, matching the memory layer manager
files:
  packages/quereus-store/src/common/store-module.ts
  packages/quereus-store/test/alter-table.spec.ts
  packages/quereus-store/test/rehydrate-catalog.spec.ts
----

## What landed

`StoreModule.alterTable` previously hard-coded `defaultNotNull=false` when
reconstructing a `ColumnSchema` for ADD COLUMN and RENAME COLUMN, ignoring the
session option `default_column_nullability` (default `'not_null'`). Memory
mode resolves that option through the layer manager, so an unannotated
`alter table t add column x text` was nullable under store mode but NOT NULL
under memory mode — surfacing as a divergence at
`41-alter-table.sqllogic:131` under `yarn test:store`.

The fix in `packages/quereus-store/src/common/store-module.ts:403`:

- Resolve `defaultNotNull = db.options.getStringOption('default_column_nullability') === 'not_null'`
  once at the top of `alterTable`.
- Thread that flag into the `columnDefToSchema(change.columnDef, defaultNotNull)`
  call inside the `addColumn` branch (line 407).
- Thread the same flag into `columnDefToSchema(change.newColumnDefAst, defaultNotNull)`
  inside the `renameColumn` branch (line 522), so a reconstructed renamed
  column inherits the same default nullability rule rather than silently
  flipping to nullable.
- The previously-unused `_db` parameter is now read as `db`.

The downstream NOT-NULL guard in `addColumn` (lines 417–425) — which refuses
NOT NULL without a literal DEFAULT against a non-empty table — already
correctly uses the column's resolved `notNull` flag, so no further change is
needed there: it now fires for unannotated ADD COLUMN under the default
session option, matching memory mode.

## How it's verified

- `packages/quereus-store/test/alter-table.spec.ts` — adds explicit `NULL`
  annotations to ADD COLUMN cases that operate on populated tables and were
  intentionally testing nullable behavior; under the new (correct) default
  those cases would otherwise hit the NOT-NULL-without-DEFAULT guard. A
  dedicated case (`refuses NOT NULL without DEFAULT on a non-empty table`,
  lines 179–200) directly asserts the guard fires for an explicit NOT NULL
  ADD COLUMN.
- `packages/quereus-store/test/rehydrate-catalog.spec.ts` — adds explicit
  `NULL` to the APPLY-SCHEMA-after-rehydrate case so the migration's intent
  (nullable `email`) is unambiguous.
- `packages/quereus/test/logic/41-alter-table.sqllogic` — the prior failure
  at line 131 is now passing under store mode.

## Validation

- `yarn test` — exit 0; all memory-mode workspace tests pass.
- `yarn workspace @quereus/store test` — 223 passing.
- `yarn test:store` — 566 passing, 19 pending. The single remaining failure
  at `50-declarative-schema.sqllogic:274` ("Deferred constraint execution
  found multiple candidate connections for table test2.a") is unrelated to
  this ticket and tracked separately.

## Use cases for review

- `alter table t add column required text` on a populated table (no NULL,
  no NOT NULL annotation) under store mode raises the NOT-NULL guard error
  with the column name and `schema.table` qualifier, matching memory mode.
- `alter table t add column x text null` (explicit nullable) still succeeds
  on a populated table.
- After `pragma default_column_nullability='nullable'`, an unannotated
  `alter table t add column x text` becomes nullable again under store mode.
- RENAME COLUMN preserves the same default-nullability semantics for any
  reconstructed column schema (see `renameColumn` branch at line 511).

## Review surface

Primary review surface is a single function:
`StoreModule.alterTable` in `packages/quereus-store/src/common/store-module.ts`,
specifically the option lookup at line 403 and the two `columnDefToSchema`
call sites (lines 407 and 522). The remainder of the function (`dropColumn`,
`alterPrimaryKey`, `alterColumn`) is unaffected — those branches do not
reconstruct a column from a `ColumnDef` AST and therefore have no
default-nullability surface.
