description: Add an engine function that writes out a database schema's current tables, views, indexes and assertions as a single `declare schema` statement, so tools can save a schema and later recreate it with `apply schema`.
architecture: docs/schema-declarative.md
files: packages/quereus/src/schema/schema-export.ts (new), packages/quereus/src/schema/catalog.ts, packages/quereus/src/schema/dependency-order.ts, packages/quereus/src/schema/reserved-tags.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/src/index.ts, packages/quereus/test/schema/schema-export.spec.ts (new), docs/schema-declarative.md
----
## Why

The bundle package (`bundle-package-format-and-export`, `bundle-import`) embeds a schema in its file as a declaration that import applies with `apply schema`. The engine already holds every piece needed, but none of it is public. `collectSchemaCatalog` (`schema/catalog.ts`) produces canonical per-object DDL. `astToString` renders a `DeclareSchemaStmt` (`declareSchemaToString` in `emit/ast-stringify.ts`). Doc comments in `catalog.ts` and `reserved-tags.ts` refer to an `export_schema` that does not exist. This ticket adds that function to the engine, because the conversion from catalog to declaration is the inverse of the declarative path and belongs beside it rather than in a downstream package.

## Interface

```ts
// packages/quereus/src/schema/schema-export.ts
export function exportSchemaDeclaration(db: Database, schemaName?: string /* default 'main' */): AST.DeclareSchemaStmt;
```

Callers render the text with `astToString` (already exported from `@quereus/quereus/emit`). Export `exportSchemaDeclaration` from `src/index.ts`. Also export `orderDependenciesFirst` (`schema/dependency-order.ts`, a generic stable topological sort) from `src/index.ts`. The bundle exporter uses it to order tables parents-first, and a hand-rolled copy is exactly the drift the project avoids.

## Behaviour

- Source of truth is `collectSchemaCatalog(db, schemaName)`: tables (plain and maintained), views, indexes and assertions. It already excludes engine-managed tables and hidden implicit covering indexes. Do not re-derive any of that.
- Parse each entry's `ddl` with `Parser.parseAll`, then wrap each statement by type: `createTable` → `declaredTable`, `createIndex` → `declaredIndex`, `createView` → `declaredView`, `createMaterializedView` → `declaredMaterializedView`, `createAssertion` → `declaredAssertion`. Any other statement type is an internal error (`StatusCode.INTERNAL`) naming the object, never a silent skip.
- Item order: tables, views, indexes, assertions, each in catalog order. The declaration is order-independent, but a stable order keeps exports diffable.
- Object names qualified with the exported schema itself are written unqualified (the table name of a `create table`, the target table of a `create index`, the view name). References inside bodies (view selects, CHECK expressions, foreign keys to other schemas) are left exactly as rendered.
- The declaration carries no `version` and no `using (default_vtab_module …)` clause. Each table keeps the `using` clause its catalog DDL already renders.
- No `seed` items. Data is not part of a schema export.

## Edge cases & interactions

- **Nonexistent schema** → throw (`no such schema: x`). `collectSchemaCatalog` returns an empty catalog for a missing schema, and an empty declaration that someone later applies would drop everything. Verified by inspection.
- **Logical schema** (`Schema.kind === 'logical'`): refuse with a clear error ("logical schemas cannot be exported"). Lens declarations are out of scope. Verified by inspection.
- **Assertion with no `check` AST** (the catalog falls back to `violationSql`; see the NOTE in `assertionSchemaToCatalog`): refuse, naming the assertion. Rendering the fallback would produce a declaration that never matches. Verified by inspection.
- **Exposed implicit covering index** (a UNIQUE constraint tagged `quereus.expose_implicit_index`): if the catalog lists it among `indexes`, exporting it as `unique index` would duplicate the constraint on re-apply. Skip `implicit` index entries. Verified by the round-trip test.
- **Engine auto-named constraints** (`_check_*`, `_fk_*`, `_uc_*`): whatever the catalog DDL renders must re-apply with an empty diff. The differ matches `_`-prefixed names by body. Verified by the round-trip test.
- **Quoted or mixed-case identifiers, table names containing a dot, tags (including `quereus.id`), collations, partial indexes, generated columns, maintained tables / materialized views on a non-default module, cross-schema foreign keys.** Verified by the round-trip test.
- **Comment cleanup:** the `export_schema` mentions in `catalog.ts` (around lines 242, 286, 447) and `reserved-tags.ts` (around lines 114, 215, 228, 233, 247) should name `exportSchemaDeclaration`.

## Test (one spec, the property that matters)

`test/schema/schema-export.spec.ts`. For each of a handful of representative schemas built with direct DDL (covering the items above), assert:

1. **Same-database fixpoint:** `declare schema` with the exported text on the same database, then `diff schema <name>`, yields zero rows.
2. **Fresh-database round trip:** on a new `Database`, declare + `apply schema` the exported text, then export again. The text is byte-identical to the first export.

## Docs

Add a short "Exporting a declaration" section to `docs/schema-declarative.md`: the function, what it includes and excludes, and the refusals. Add `exportSchemaDeclaration` to the DeclaredSchemaManager-adjacent API notes there.

## TODO

- Add `schema/schema-export.ts` with `exportSchemaDeclaration`. Export it and `orderDependenciesFirst` from `src/index.ts`.
- Implement the refusals (missing schema, logical schema, assertion without a check AST) and skip implicit indexes.
- Replace the stale `export_schema` comment references.
- Write the round-trip spec.
- Update `docs/schema-declarative.md`.
- `yarn workspace @quereus/quereus run lint`, `yarn build`, `yarn test`.
