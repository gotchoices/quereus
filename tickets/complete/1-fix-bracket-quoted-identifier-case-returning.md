description: RETURNING projection preserves the case of the user's spelling for output column names; bracket-quoted [Name] / double-quoted "Name" / aliases / NEW.x / OLD.x all round-trip case as written
prereq:
files:
  packages/quereus/src/planner/building/insert.ts
  packages/quereus/src/planner/building/update.ts
  packages/quereus/src/planner/building/delete.ts
  packages/quereus/src/planner/nodes/returning-node.ts
  packages/quereus/test/logic/42-returning.sqllogic
  packages/quereus/test/logic/42.1-returning-extras.sqllogic
----
## Summary

RETURNING used to lowercase every output column name in two places (the synthesised alias in each DML builder, and again in `ReturningNode.buildOutputType`). Both layers were doing the same case-folding; both have been removed. Output column names now match the user's spelling, consistent with `ProjectNode` for SELECT. Resolution / matching remains case-insensitive — only the *display* name (the JSON key in result rows) changed.

## Behaviour

- `returning [Name]` → `Name`
- `returning "Name"` → `Name`
- `returning NEW.value AS NewValue` → `NewValue`
- `returning NEW.value, OLD.value` → `NEW.value`, `OLD.value`
- `returning name` → `name` (unchanged — case-preserving, user wrote lowercase)
- `returning name as item_name` → `item_name` (unchanged)

Matches SQLite/PostgreSQL conventions.

## Key files

- `packages/quereus/src/planner/building/insert.ts:619-641` — synthesised alias preserves user's spelling
- `packages/quereus/src/planner/building/update.ts:264-286` — same
- `packages/quereus/src/planner/building/delete.ts:222-244` — same
- `packages/quereus/src/planner/nodes/returning-node.ts:49-108` — `buildOutputType()` parallels `ProjectNode.buildOutputType()`: alias > column-ref name (qualified as `table.name` when `table` is set, else `name`) > `expressionToString(expression)`. Duplicate handling uses the same `nameCount` Map / `:N` suffix scheme as `ProjectNode`.

## Tests

- `packages/quereus/test/logic/42.1-returning-extras.sqllogic:47-49` — TODO bug block enabled; asserts `[Name]` round-trips as `Name`.
- `packages/quereus/test/logic/42-returning.sqllogic:135-157` — six pre-existing assertions updated from lowercased keys to case-preserving keys (`OLD.value`, `NEW.value`, `NewValue`, `OldValue`).

## Validation

- `yarn workspace @quereus/quereus build` — clean (exit 0)
- `yarn eslint` on the four modified source files — clean (exit 0)
- `yarn workspace @quereus/quereus test` — 2522 passing, 3 pending, 0 failing

## Review notes (verified during review)

- `ReturningNode.buildOutputType` mirrors `ProjectNode.buildOutputType`: alias > column-ref name > `expressionToString`. Duplicate-name handling uses the same case-sensitive bucket counter (`:1`, `:2`, …). The only intentional divergence from ProjectNode is qualified-name preservation when `expr.table` is set (e.g. `NEW.value`); SELECT uses unqualified names because qualifiers there are scope-resolution noise, whereas RETURNING's NEW/OLD qualifier is meaningful to the user and should appear in the output.
- The only consumer of `ReturningNode.getAttributes()` outside the node itself is `runtime/emit/returning.ts:12`, which reads the *executor's* attributes (not RETURNING's) and wires them positionally into a row descriptor — no name-keyed lookup. No driver/CLI code keys on lowercased RETURNING column names.
- Case-insensitive matching of output columns continues to work: NEW/OLD/unqualified/table-qualified symbols are still registered lowercase in the `returningScope` (`insert.ts:602,607,612`; `update.ts:248`; `delete.ts:204,210,216`), so resolution is unaffected — only the display name changed.

## Usage

Drivers reading RETURNING result rows by JSON key now see the user's spelling. Code that previously relied on lowercased keys (`row['old.value']`, `row['newvalue']`) needs to use the spelling as written in the SQL. There were no such consumers in the codebase outside the two updated test files.
