description: Review the new engine function that writes a database schema's tables, views, indexes and assertions out as one `declare schema` statement, so tools can save a schema and recreate it later with `apply schema`.
architecture: docs/schema-declarative.md#exporting-a-declaration
files: packages/quereus/src/schema/schema-export.ts (new), packages/quereus/test/schema/schema-export.spec.ts (new), packages/quereus/src/schema/catalog.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/src/index.ts, packages/quereus/src/schema/catalog-rendering.ts, packages/quereus/src/schema/reserved-tags.ts, docs/schema-declarative.md, docs/schema-undo-plan.md, docs/vu-inverses.md, packages/quereus/test/schema/catalog.spec.ts
----
## What landed

`exportSchemaDeclaration(db, schemaName = 'main'): AST.DeclareSchemaStmt` in `src/schema/schema-export.ts`, exported from `src/index.ts` together with `orderDependenciesFirst` (for the bundle exporter's parents-first table order). Callers render with `astToString` from `@quereus/quereus/emit`.

How it works: `collectSchemaCatalog` decides the object set. Each entry's `ddl` is parsed (`Parser.parseAll`, exactly one statement expected) and wrapped by statement type (`createTable` → `declaredTable`, `createIndex` → `declaredIndex`, `createView` → `declaredView`, `createMaterializedView` → `declaredMaterializedView`, `createAssertion` → `declaredAssertion`). Any other statement type, a parse failure, or a qualifier naming a different schema is `StatusCode.INTERNAL`, naming the object. The exported schema's own qualifier is stripped from object names (table name, index name and target table, view name, assertion name). Bodies are left as rendered.

Refusals (`StatusCode.ERROR`): missing schema (`no such schema: x`), logical schema, and an assertion whose catalog entry has no `check` AST. Exposed implicit indexes (`implicit: true`) are skipped.

## Deviations from the implement ticket (please check these)

- **Order is by name within each group, not catalog order.** The ticket asked for catalog order and also for a byte-identical re-export after applying on a fresh database. Those conflict: catalog order is creation order, and `apply schema` creates plain tables before maintained ones and parents before children. With catalog order the maintained-table scenario fails the round trip (verified by temporarily removing the sort). The sort is lowercase name, then exact name, using code-unit comparison, not `localeCompare`.
- **`CatalogView.ddl` now comes from `generateViewDDL(viewSchema)` instead of `viewSchema.sql`** (`catalog.ts` `viewSchemaToCatalog`). The stored text was unusable for export. After a table rename, propagation overwrites it with the bare `select` body (`runtime/emit/alter-table.ts`), so the export threw "a 'select' statement". After `alter view … set tags` it still held the old tags, so the same-database diff showed a tag change. Both were reproduced by the new view scenario before the fix. Other effects: the applied-state comparison rendering now includes this rendered text, which is deterministic within a process. The restore check still leaves view DDL out, since rename artifacts can still respell it. I updated that comment in `catalog-rendering.ts` and the matching sentence in `docs/schema-undo-plan.md`. No other code reads `CatalogView.ddl`.
- **`declaredIndexToString` (ast-stringify.ts) now writes a partial index's `where` clause.** Before this, a declared partial index lost its predicate when rendered. The partial index in scenario 1 caught it: the same-database diff showed DROP + CREATE of `ix_child_qty`.

## Known gap — needs a decision (not fixed)

**The export depends on the exporting session's settings.** Table DDL is the catalog's with-`db` form, which omits:

- a column's `null` / `not null` annotation when it matches `default_column_nullability`;
- a `BINARY` collation, always;
- the `using` clause when the module matches `default_vtab_module` / `default_vtab_args`.

Applying the text fills these in from the importing session. A table landing on the importer's default module is what the ticket intended. For nullability and collation it is wrong: an importer with `default_column_nullability = 'nullable'` turns every unannotated NOT NULL column nullable, and one with `default_collation = 'nocase'` turns BINARY text columns NOCASE. This was found by reading the code, not by running it. `docs/schema.md` already says persisted DDL should use the no-`db` form for this reason. The bundle tickets (`bundle-package-format-and-export`, `bundle-import`) do not mention it.

Possible fixes: after parsing, add an explicit `null` / `not null` (and an explicit `collate binary` on text columns that would otherwise take the default) from `CatalogTable.columns`; or give `generateTableDDL` a mode that annotates everything but still leaves out the default module's `using` clause. `docs/schema-declarative.md` § Exporting a declaration currently states the limitation: export and apply under the same settings. The reviewer should decide whether this becomes a ticket (probably a prereq of `bundle-import`) or stays documented.

## Other things worth a look

- Returned AST nodes keep `loc` positions taken from each object's own DDL string, not from any text the caller has. `astToString` ignores them. A caller that passes the AST straight to `declaredSchemaManager.setDeclaredSchema` would get apply errors pointing into those strings.
- The `createMaterializedView` arm cannot be reached today, because the catalog renders maintained tables as `create table … maintained as`. It exists because the ticket's mapping asked for it and the switch would otherwise need a default for it.
- An exported FK into another schema (`references aux.parent(id)`) requires that schema to exist before `apply schema`. The test applies `aux` first. Nothing in the export records the dependency between schemas.

## Test (one spec, four scenarios)

`test/schema/schema-export.spec.ts`. Each scenario builds a source database with direct DDL and checks two properties: (1) declaring the exported text on the source database leaves `diff schema` empty; (2) declare + `apply schema` on a fresh database, then re-export, gives byte-identical text.

- *Tables, constraints, indexes, a view and an assertion, with quoted and dotted names*: mixed-case quoted names, a table named `child.items`, `quereus.id` and quoted tag values, `collate nocase`, generated stored column, DEFAULT, auto-named CHECK / FK / UNIQUE, named FK with `on delete cascade`, named CHECK, an exposed implicit index (`quereus.expose_implicit_index`), a partial DESC index, a unique collated index with tags, a view with a column list and tags, an assertion. This scenario catches the `where` fix and the implicit-index skip.
- *Maintained tables and materialized views on the default module and on `mem2`* (a second `MemoryTableModule`), a plain table on `mem2`, `create table … maintained as`, and a view over a materialized view. This scenario catches the name sort.
- *Views changed after creation by a table rename and by new tags*. Catches the `CatalogView.ddl` fix.
- *A non-main schema (`aux`), and a foreign key into it from `main`*: covers qualifier stripping (table, index, view, assertion names) and leaving a cross-schema FK reference as written.

Each check above was confirmed by temporarily reverting the fix and watching the spec fail. Not covered by tests: the three refusals, which the ticket marked as verified by inspection. `with context (…)` tables and `with defaults (…)` view clauses are not exercised either; both go through the shared renderers.

## Validation run

- `yarn workspace @quereus/quereus run lint`: clean.
- `yarn build`: clean.
- `yarn test`: all workspaces pass (quereus 11189 passing, 26 pending; 0 failing anywhere).
