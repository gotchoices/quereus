description: ALTER TABLE ADD COLUMN rejects non-foldable DEFAULT expressions at DDL time, symmetric with CREATE TABLE's determinism rule and independent of `default_column_nullability`.
files:
  packages/quereus/src/runtime/emit/alter-table.ts
  packages/quereus/src/parser/utils.ts
  packages/quereus/test/logic/90.2.1-alter-extra-errors.sqllogic
----

## What landed

`runAddColumn` in `packages/quereus/src/runtime/emit/alter-table.ts` (lines 197-208) now validates the DEFAULT expression on the incoming `ColumnDef` against `tryFoldLiteral` (from `packages/quereus/src/parser/utils.ts`). If the DEFAULT cannot fold to a literal, the ALTER throws synchronously at DDL time:

> ALTER TABLE ADD COLUMN DEFAULT for '<col>' must fold to a literal — column references, bind parameters, and non-deterministic expressions are not allowed

The check runs immediately after the existing PK rejection, before `module.alterTable` is invoked.

## Why

Symmetric with CREATE TABLE's `validateDefaultDeterminism`, but stricter: ADD COLUMN must backfill existing rows with a concrete literal, so the DEFAULT must fold. Previously, rejection only happened as a side-effect of the NOT-NULL backfill guard; under `default_column_nullability = 'nullable'` (SQL-standard), non-foldable DEFAULTs silently slipped through with a warning-only NULL backfill.

## Behavior

**Accepted DEFAULTs (unchanged):**
- `default 5`, `default 'text'`, `default null`, `default true`, `default false`
- `default -123`, `default -123.0`, `default (123.0)`, `default (-(-123))`

**Rejected DEFAULTs (new at DDL time):**
- Column references: `default (a)`, `default (a + 1)`, `default (concat(a, 'x'))`
- Bind parameters: `default (:foo)`, `default (?)`
- Function calls / non-deterministic: `default (random())`, `default (current_timestamp)`, `default (1 + 2)`

## Validation results

- `yarn workspace @quereus/quereus test --grep "90.2.1-alter-extra-errors"` — passing
- `yarn workspace @quereus/quereus test --grep "alter"` — 19 passing, no regressions
- `yarn workspace @quereus/quereus test` — 2705 passing, 2 pending (full suite, no regressions)
- `yarn workspace @quereus/quereus run lint` — clean

## Key tests

- `packages/quereus/test/logic/90.2.1-alter-extra-errors.sqllogic:23-32` — bind-param and column-ref DEFAULT cases both hit the new DDL-time error
- `packages/quereus/test/logic/41.4-alter-add-column-constraints.sqllogic` — positive literal-DEFAULT cases (`default 7`, `default -123.0`, `default 123.0`) confirmed still passing
- `packages/quereus/test/logic/41-alter-table.sqllogic`, `41.5-alter-misc.sqllogic`, `105-vtab-memory-mutation-kills.sqllogic` — string-literal DEFAULTs continue to work

## Notes for future work

- The `MemoryTableManager.addColumn` warning path at `packages/quereus/src/vtab/memory/layer/manager.ts:947` (`Default for new col is expr; existing rows get NULL`) is now unreachable from the ALTER TABLE entry point. Still reachable from internal callers / direct module use, so leaving it in place is safe — a follow-up could prune if no other entry point exercises it.
- `ALTER COLUMN SET DEFAULT <non-foldable-expr>` is not covered by this rejection. No test coverage in the corpus today; symmetry argues for the same DDL-time check. File separately if desired.
- Downstream: `lamina/packages/lamina-quereus-test/src/sqllogic/known-failures.ts` can retire the `ALTER_ADD_COLUMN_DEFAULT_NON_CONSTANT` entry pointing at this ticket's slug once this lands.
