description: Rename FK enforcement action "noAction" to "ignore" for clarity
prereq: none
files:
  - packages/quereus/src/parser/ast.ts (ForeignKeyAction type)
  - packages/quereus/src/parser/parser.ts (parseForeignKeyAction return)
  - packages/quereus/src/emit/ast-stringify.ts (foreignKeyActionToString case)
  - packages/quereus/src/schema/manager.ts (four default fallbacks)
  - packages/quereus/src/schema/table.ts (doc comments)
  - packages/quereus/src/runtime/foreign-key-actions.ts (skip logic)
  - packages/quereus/src/planner/building/foreign-key-builder.ts (parent-side check)
----

Renamed the internal `ForeignKeyAction` union member `'noAction'` → `'ignore'` across all 7 files. This is a purely internal rename — SQL `NO ACTION` is still parsed and emitted as `no action`.

## What changed

- **ast.ts**: `ForeignKeyAction` type union member renamed
- **parser.ts**: `parseForeignKeyAction()` returns `'ignore'` for `NO ACTION`
- **ast-stringify.ts**: Case label `'ignore'` still emits `'no action'`
- **manager.ts**: Four `?? 'noAction'` default fallbacks → `?? 'ignore'`
- **table.ts**: Two doc comments updated
- **foreign-key-actions.ts**: Runtime skip condition updated
- **foreign-key-builder.ts**: Planner parent-side check updated

## Testing

- No behavioral change — all existing FK tests pass unchanged
- Key test file: `test/logic/41-foreign-keys.sqllogic`
- Build and full test suite pass (`yarn build && yarn test`)

## Use cases for validation

- FK with explicit `NO ACTION` on delete/update — should parse and round-trip correctly
- FK with no action specified (defaults) — should default to `'ignore'`
- FK with `CASCADE`, `SET NULL`, `SET DEFAULT`, `RESTRICT` — unaffected
- Parent row delete/update with `NO ACTION` FK — constraint check fires, no cascade
