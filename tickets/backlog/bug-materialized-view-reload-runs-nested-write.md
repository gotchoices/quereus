description: Reopening a database whose saved catalog holds a materialized view (or maintained table) with a delete/insert/update tucked inside its query performs that write against the live source tables during the reload; new ones can no longer be created, but old or hand-edited catalogs still trigger it.
architecture: docs/sql-views.md#28-create-view-statement
files: packages/quereus/src/schema/manager.ts (`importMaterializedView`), packages/quereus/src/runtime/emit/materialized-view-helpers.ts (`deriveBackingShape`, `deriveBackingShapeUnguarded`, `materializeView`), packages/quereus/src/planner/building/reject-stored-body-writes.ts, packages/quereus/test/view-mv-ddl-persistence.spec.ts
repro: verified
severity: corruption
likelihood: unusual
tradeoffs: Only a catalog saved before the create-time check landed, or edited by hand, can carry such a body, and backwards compatibility is not yet a project goal — so a maintainer may judge the reload path not worth guarding.
----

# Materialized-view reload executes a nested write in its body

## Background

`create view` / `create materialized view` / `create table … maintained as` / `create assertion` now refuse a body that contains an `insert` / `update` / `delete … returning` at any depth (`rejectStoredBodyWrites`, landed by `ticket(implement): stored-bodies-refuse-nested-writes`). That check runs only on the create path.

When a persisted catalog is reloaded (`SchemaManager.importCatalog` → `importDDL`):

- Plain views go through `importView`, which does not plan the body. The body is planned on first read in `planner/building/select.ts`, and that read path now runs the same check — so a reloaded plain view with a nested write fails to read and writes nothing. (Fixed in review; covered by `view-mv-ddl-persistence.spec.ts` "a reloaded view with a nested write is refused on read".)
- Materialized views and maintained tables go through `importMaterializedView`. Its gate refuses only a body that is *wholly* DML (`spec.select.type === 'delete'` etc.), with the stated reason that "a corrupt or hand-edited catalog entry would otherwise EXECUTE the mutation against live source tables during rehydrate". A body with the write nested inside (`select id from (delete from e where id = 2 returning id) d`) passes that gate, and `materializeView` then runs it to fill the backing.

## Reproduction (verified)

```js
const db = new Database();
await db.exec('create table e (id integer primary key)');
await db.exec('insert into e values (1),(2),(3),(4)');
await db.schemaManager.importCatalog(['create materialized view m as select id from (delete from e where id = 2 returning id) d']);
// → imports as main.m; `select id from e` now returns 1, 3, 4 — row 2 was deleted by the reload.
```

## Expected

The import of that entry fails (recorded as a per-entry error, like the whole-body DML case), the backing is not built, and the source tables are untouched — matching the existing `a DML body is rejected before materializing — the mutation never executes` test in `view-mv-ddl-persistence.spec.ts`, extended to the nested shape.

## Notes for whoever picks it up

- The body is planned during import by `deriveBackingShapeUnguarded` (`db._getPlanWithDependencies`, which builds and optimizes and has no cache). Running `rejectStoredBodyWrites` on that plan closes the hole without a second planning pass; it walks the optimized plan, where writes may appear as `UpdateExecutor` — already in `DML_NODE_TYPES`.
- `deriveBackingShape` has about ten callers (create, refresh, alter, import) and no view name, which the error message needs. Either thread the owner's name through, or check at the import site only. Checking in `deriveBackingShape` also re-checks on create and refresh, which is redundant but cheap (linear in plan size).
- Once the plan-level check covers import, the whole-body AST gate in `importMaterializedView` becomes redundant (the walk sees a root `Delete` node too); keep or remove it deliberately.
- Assertions loaded from a catalog are a third reload path. They are evaluated at commit from their stored violation SQL; whether that path should also run the check belongs in the same fix.
