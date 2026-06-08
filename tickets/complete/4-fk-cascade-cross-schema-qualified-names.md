description: FK CASCADE/SET NULL/SET DEFAULT actions use schema-qualified table names
files:
  packages/quereus/src/runtime/foreign-key-actions.ts
  packages/quereus/test/logic/41-fk-cross-schema.sqllogic
----
## What was built

Bug fix in `executeSingleFKAction` (`packages/quereus/src/runtime/foreign-key-actions.ts`). Previously the four runtime-generated SQL strings for FK propagation referenced the child table by bare name (`"tablename"`), which silently targeted the wrong table — or failed to find one — when the child table lived in a non-default schema.

A single `qualifiedChildTable = "${childTable.schemaName}"."${childTable.name}"` is now interpolated into all four templates:

- CASCADE DELETE → `DELETE FROM "schema"."child" WHERE …`
- CASCADE UPDATE → `UPDATE "schema"."child" SET … WHERE …`
- SET NULL       → `UPDATE "schema"."child" SET col = NULL WHERE …`
- SET DEFAULT    → `UPDATE "schema"."child" SET col = (<default-expr>) WHERE …`

No interfaces, signatures, or surrounding code paths were touched.

## Test coverage

`packages/quereus/test/logic/41-fk-cross-schema.sqllogic` extended with a new section under `declare schema sa { … }` containing:

- `parents` — keyed parent rows, including `id = 99` reserved as the SET DEFAULT target.
- `cascade_children` — FK with `ON DELETE CASCADE ON UPDATE CASCADE`.
- `setnull_children` — FK with `ON DELETE SET NULL`.
- `setdefault_children` — FK with `ON DELETE SET DEFAULT`, `parent_id INTEGER NULL DEFAULT 99`.

Each child references a different parent row so actions don't cross-pollinate. Test verifies:

- `DELETE FROM sa.parents WHERE id = 1` removes matching `cascade_children` rows.
- `UPDATE sa.parents SET id = 222 WHERE id = 2` propagates to `cascade_children.parent_id`.
- `DELETE FROM sa.parents WHERE id = 3` nulls out `setnull_children.parent_id`.
- `DELETE FROM sa.parents WHERE id = 4` rewrites `setdefault_children.parent_id` to 99.

Note: declarative schemas default columns to `NOT NULL`, so the FK columns are explicitly declared `NULL` (required by SET NULL).

## Validation

- `yarn workspace @quereus/quereus run build` — clean.
- `node test-runner.mjs --grep "fk-cross-schema"` — 1 passing.
- `node test-runner.mjs --grep "fk-|foreign-key|constraint-edge"` — 6 passing.
- Full test suite ran 2694 passing, 2 pre-existing pending (per implement notes).

## Adjacent paths reviewed (no fix needed)

- `schema/manager.ts` referencing-row check on DROP TABLE — already builds `schemaPrefix` for non-`main` schemas.
- `planner/building/foreign-key-builder.ts` parent-side checks — synthesize AST against the bound `childTable`, schema-aware by construction.
- `util/mutation-statement.ts` — builds unqualified identifiers for mutation-log replay against an explicit table, not FK propagation; out of scope.

## Usage

The fix is transparent: any FK constraint on a table in a non-default schema (`declare schema X { table parent { … } table child { …, FOREIGN KEY (…) REFERENCES parent(…) ON … } }`) will now propagate CASCADE/SET NULL/SET DEFAULT actions correctly. Pre-existing same-schema FK behaviour is unchanged.
