description: ALTER TABLE ADD COLUMN ... NOT NULL is now rejected at DDL time when the new column has no usable DEFAULT and the target table is non-empty. Empty-table and DEFAULT-with-non-NULL paths are unchanged.
files:
  packages/quereus/src/runtime/emit/alter-table.ts
  packages/quereus/test/logic/41-alter-table.sqllogic
----

## What landed

`packages/quereus/src/runtime/emit/alter-table.ts`:

- `runAddColumn` now classifies the new column before any state mutation:
  - `hasNotNull` from `columnDef.constraints` containing `{ type: 'notNull' }`.
  - `defaultIsNullish` covers all three nullish cases: no `defaultConstraint`, `defaultConstraint` with no `.expr`, or folded value is `null`. Non-foldable DEFAULTs are already rejected earlier, so `tryFoldLiteral` returning `undefined` at this point can only mean "no expression."
  - When both flags hold, the new `validateNotNullBackfill` runs `select 1 from <qualifiedTable> limit 1` and throws a `CONSTRAINT` `QuereusError` if any row exists. The error message embeds `NOT NULL`, the column name in single quotes, and `<schema>.<table>` to satisfy the three case-insensitive substring asserts in the corpus.
- The check is done *before* `module.alterTable` (the first state-mutating call), so when the alter aborts no schema or module state has been touched — no compensating drop needed (contrast with the CHECK backfill path which runs post-mutation because its predicate references the new column).
- Drive-by: extracted `qualifyTableName(schemaName, tableName)` (top of file) and replaced four copies of the `schemaPrefix … quoteIdentifier(name)` block in `validateBackfillAgainstChecks`, `validateNotNullBackfill`, `buildShadowTableDdl`, and `rebuildViaShadowTable`.

## Corpus

`packages/quereus/test/logic/41-alter-table.sqllogic` exercises:

- Non-empty table + NOT NULL without DEFAULT → error containing `NOT NULL` (line 131-132).
- Non-empty table + NOT NULL without DEFAULT → error containing `'rank'` and `main.t_notnull` (lines 135-139).
- Non-empty table + NOT NULL with DEFAULT → succeeds and backfills (lines 141-145).
- Non-empty table + NULL column without DEFAULT → still succeeds (lines 148-150).
- Empty table + NOT NULL without DEFAULT → succeeds; subsequent `insert` works (lines 154-160).

## Verification

- `yarn workspace @quereus/quereus test --grep "41-alter-table"` — passing.
- `yarn workspace @quereus/quereus test` — 2705 passing, 2 pending, no regressions.
- `yarn workspace @quereus/quereus run lint` — clean.

## Downstream

`lamina/packages/lamina-quereus-test/src/sqllogic/known-failures.ts` still lists `41-alter-table.sqllogic` under `ALTER_ADD_COLUMN_NOT_NULL_BACKFILL` with `ticket: 'quereus/fix-alter-add-column-not-null-backfill-enforcement'`. That entry can be retired in the lamina repo once it consumes the quereus version containing this fix.
