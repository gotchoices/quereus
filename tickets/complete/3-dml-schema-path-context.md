description: Fixed DML builders to propagate contextWithSchemaPath consistently
prereq: none
files:
  packages/quereus/src/planner/building/update.ts
  packages/quereus/src/planner/building/delete.ts
  packages/quereus/src/planner/building/insert.ts
  packages/quereus/test/logic/06.4-schema-search-path.sqllogic
----

### What was built

Fixed 4 sites across UPDATE, DELETE, and INSERT builders where `ctx` was passed
instead of `contextWithSchemaPath`, causing `WITH SCHEMA` on DML statements to fail
when targeting tables in non-default schemas. Each fix is a single-token change.

### Key files

- **update.ts:68** — Source scan `buildTableReference` now receives `contextWithSchemaPath`
- **update.ts:80** — `updateCtx` now derives from `contextWithSchemaPath`
- **delete.ts:79** — `deleteCtx` now derives from `contextWithSchemaPath`
- **insert.ts:528** — `createRowExpansionProjection` now receives `contextWithSchemaPath`

### Testing

Tests 14–17 in `06.4-schema-search-path.sqllogic`:
- Test 14: UPDATE with WITH SCHEMA on non-default schema
- Test 15: INSERT with WITH SCHEMA + default value computation on non-default schema
- Test 16: DELETE with WITH SCHEMA on non-default schema
- Test 17: INSERT with WITH SCHEMA + RETURNING on non-default schema

Full suite: 1013 passing, 2 pending (pre-existing).

### Usage

```sql
-- UPDATE unqualified table via schema path
UPDATE products SET name = 'Gadget' WHERE id = 1 WITH SCHEMA myapp;

-- INSERT with defaults resolved in correct schema
INSERT INTO products (id, name) VALUES (2, 'Widget') WITH SCHEMA myapp;

-- DELETE via schema path
DELETE FROM products WHERE id = 2 WITH SCHEMA myapp;

-- INSERT + RETURNING via schema path
INSERT INTO products (id, name) VALUES (3, 'Gizmo') WITH SCHEMA myapp RETURNING id, name, status;
```
