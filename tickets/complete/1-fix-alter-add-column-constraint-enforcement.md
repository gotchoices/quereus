description: ALTER TABLE ADD COLUMN — enforce column-level CHECK / REFERENCES, validate backfill, accept signed-numeric DEFAULT
files:
  packages/quereus/src/parser/utils.ts
  packages/quereus/src/vtab/memory/layer/manager.ts
  packages/quereus/src/runtime/emit/alter-table.ts
  packages/quereus/test/logic/41.4-alter-add-column-constraints.sqllogic
  packages/quereus/test/logic/90.2.1-alter-extra-errors.sqllogic
  packages/quereus/test/logic/06.3.2-schema-foreign-keys.sqllogic
----

## What was built

`alter table … add column` now:

- Accepts signed/parenthesised numeric literals as DEFAULT (e.g. `default -123.0`) and backfills them.
- Attaches column-level CHECK / REFERENCES from the `ColumnDef` AST onto the resulting table schema so subsequent INSERT/UPDATE enforces them.
- Validates existing rows against any new CHECK constraints by running `select 1 from <table> where not (<check>) limit 1`. A violation aborts the ALTER atomically — column is dropped and the original schema is restored in the catalog.

## Key files

- **`packages/quereus/src/parser/utils.ts`** — `tryFoldLiteral(expr)` recognises a `LiteralExpr` or a `UnaryExpr('+'|'-', literal)` whose inner is `number | bigint` and returns the SqlValue. Recursion accepts nested unaries when each inner level resolves to a number/bigint (mathematically consistent); returns `undefined` for strings/booleans/null behind a unary, or anything non-literal at the leaf.
- **`packages/quereus/src/vtab/memory/layer/manager.ts`** — `MemoryTableManager.addColumn` and the `alterColumn → SET NOT NULL` backfill path call `tryFoldLiteral` instead of testing `expr.type === 'literal'`, so signed-numeric defaults backfill correctly.
- **`packages/quereus/src/runtime/emit/alter-table.ts::runAddColumn`** —
  - Extracts column-level CHECK constraints (`extractColumnLevelCheckConstraints`) and FOREIGN KEY constraints (`extractColumnLevelForeignKeys`) from the `ColumnDef` AST.
  - Calls `module.alterTable({ type: 'addColumn' })`, then resolves the new column index from the freshly returned `columnIndexMap` and rebinds each FK's `columns` from `[]` to `[newColIdx]`.
  - Merges the new constraints into `tableSchema.checkConstraints` / `tableSchema.foreignKeys` and registers the **enhanced** schema in the catalog so SQL bound during backfill validation can resolve the new column.
  - When at least one new CHECK was added, runs `validateBackfillAgainstChecks` via `db.prepare(...)._iterateRowsRaw()` (mirrors `database-assertions.ts:executeViolationOnce`). On violation it issues a compensating `module.alterTable({ type: 'dropColumn' })`, restores the original `tableSchema` in the catalog, and rethrows a `CONSTRAINT` error.
  - Bare `references parent(col)` on ADD COLUMN defaults `onDelete`/`onUpdate` to `restrict`, so `buildChildSideFKChecks` (which skips FKs whose actions are both `ignore`) actually runs.

## Testing notes

- `packages/quereus/test/logic/41.4-alter-add-column-constraints.sqllogic` — covers ADD COLUMN with CHECK (NULL backfill allowed; later CHECK violation rejected), with bare REFERENCES (child-side FK violation rejected), with `default -123.0` and `default 123.0` (negative + positive reals), and with `default 7` participating in `sum(...)` over backfilled rows.
- `packages/quereus/test/logic/90.2.1-alter-extra-errors.sqllogic` — `alter table t_bf add column d integer not null default 0 check (d <> 0)` against rows where backfill = 0 fails, and `select * from t_bf` afterwards returns the original two rows unchanged.
- `packages/quereus/test/logic/06.3.2-schema-foreign-keys.sqllogic` — bare CREATE TABLE FKs report `on_delete: restrict, on_update: restrict` (matches SQLite-style introspection; this is the post-implementation default for both CREATE TABLE and ADD COLUMN paths in `extractForeignKeys`/`extractColumnLevelForeignKeys`).

## Review checks (all passed)

- `yarn workspace @quereus/quereus test --grep "41.4"` — 1 passing.
- `yarn workspace @quereus/quereus test --grep "90.2.1"` — 1 passing.
- `yarn workspace @quereus/quereus test --grep "06.3.2"` — 1 passing.
- `runAddColumn` revert logic verified: on CHECK-violating backfill, `module.alterTable({type:'dropColumn'})` invokes `MemoryTableManager.dropColumn`, which rebuilds the BTree via `recreatePrimaryTreeWithoutColumn` (each row's last value removed) and rebuilds secondary indexes. The manager instance is the same throughout so `module.tables` maps to the same manager whose `tableSchema` is now back to original. The catalog is then re-set to the original `tableSchema` (no enhanced CHECK/FK leak). No orphan column, no stray index.
- `extractColumnLevelForeignKeys` returns FKs with `columns: []`; caller resolves `newColIdx` from the post-alterTable `columnIndexMap` and rebinds via `{...fk, columns: [newColIdx]}`. Mismatched parent column count (anything other than 1) throws at extraction time.
- `tryFoldLiteral` only folds `±literal` where the inner resolves to `number | bigint`. Strings/booleans/null behind a unary correctly return `undefined`. Nested unaries (`-(-123)` etc.) fold via recursion when each inner level remains numeric, which is mathematically consistent.

## Out of scope / follow-ups

- FK backfill validation is not performed. The ticket-scope test backfills NULL (always satisfies MATCH SIMPLE). A future "non-NULL default + FK on new column" case would not re-check existing rows; INSERT/UPDATE enforcement still kicks in for new rows.

## Notes

- The full quereus test suite shows one unrelated pre-existing failure in `Extended constraint pushdown / OR predicates / handles OR with range predicate as residual correctly` (constraint-pushdown work, not ALTER TABLE). Not introduced by this ticket — the test file has not been touched since well before the implementation commit (`ce75af99`).
