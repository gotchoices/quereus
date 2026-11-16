description: An engine function that writes a database schema's tables, views, indexes and assertions out as one `declare schema` statement, so tools can save a schema and recreate it later with `apply schema`.
architecture: docs/schema-declarative.md#exporting-a-declaration
files: packages/quereus/src/schema/schema-export.ts, packages/quereus/test/schema/schema-export.spec.ts, packages/quereus/src/schema/catalog.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/src/index.ts, packages/quereus/src/schema/catalog-rendering.ts, packages/quereus/src/schema/reserved-tags.ts, docs/schema-declarative.md, docs/schema-undo-plan.md, docs/vu-inverses.md, packages/quereus/test/schema/catalog.spec.ts
----
## What landed

`exportSchemaDeclaration(db, schemaName = 'main'): AST.DeclareSchemaStmt` in `src/schema/schema-export.ts`, exported from `src/index.ts` along with `orderDependenciesFirst` (for the bundle exporter's parents-first table order). Callers render with `astToString` from `@quereus/quereus/emit`.

Each `collectSchemaCatalog` entry's DDL is parsed and wrapped as a declaration item. The exported schema's own qualifier is stripped from object names. Items are grouped tables, views, indexes, assertions and sorted by name within each group, so a schema rebuilt from an export exports the same text (catalog order is creation order, which `apply schema` does not preserve). Exposed implicit indexes are skipped because the tagged UNIQUE constraint recreates them. Refusals: missing schema, logical schema, an assertion without a CHECK expression.

Supporting fixes from the implement pass: `CatalogView.ddl` is rendered with `generateViewDDL` instead of the stored `ViewSchema.sql` (stale after a table rename or `alter view … set tags`), and `declaredIndexToString` now writes a partial index's `where` clause.

Review pass (see below) made every column's nullability and every text column's collation explicit in the export, so the importing session's defaults cannot change them.

## Review findings

Read the implement diff (`ticket(implement): schema-export-declaration`) before the handoff, then the touched code and docs.

**Fixed in this pass (major, inline):** the export depended on the session settings. The handoff flagged this from reading code; I reproduced it: a table exported under defaults and applied in a database with `default_column_nullability = 'nullable'` and `default_collation = 'nocase'` came out with every NOT NULL column nullable (the primary key included) and every BINARY text column NOCASE. The bundle export and import tickets would have shipped that across databases. Fix in `schema-export.ts`: `withSessionDefaultsPinned` adds a `not null` / `null` clause to every table column that lacks one, taken from the catalog column. It also adds `collate <collation>` to every column whose type can take a non-BINARY default (text; the same rule as `resolveDefaultCollation`). Clauses go where the DDL generator puts them (nullability first, collation after it), so the text is the same whichever clauses the exporter's defaults let the generator leave out. That ordering came from a failure: the first version of the fix put the clauses in a different order and the re-export test caught it. The `using` clause still follows the importer's default module, which is intended.

**Test change:** the existing round-trip spec now applies on a fresh database running under `nullable` and `nocase` defaults, and the maintained-table scenario gained text columns, so it covers this case. The byte-identical re-export pins the property in both directions. With the fix disabled, all four scenarios fail. No new test was added.

**Consequence documented:** an exported BINARY text primary key now carries an explicit `collate binary`, so the store module's implicit key-collation override (NOCASE) does not apply on import. The export reproduces the source column; noted in `docs/schema-declarative.md` § Exporting a declaration, whose "Session settings" paragraph was rewritten (it previously told users to export and apply under the same settings).

**Implementer's deviations, checked and kept:**
- Name sort instead of catalog order: correct; catalog order breaks the byte-identical round trip (the implementer verified this).
- `CatalogView.ddl` from `generateViewDDL`: no other reader of view `ddl` exists in `packages/*/src`. The restore check still excludes view DDL, and the comments and `docs/schema-undo-plan.md` match.
- `where` in `declaredIndexToString`: a real fix to the declared-index renderer.

**Tripwire parked:** the returned AST keeps `loc` positions into each object's own catalog DDL. It is harmless through `astToString`, but would give misleading error positions if passed straight to `setDeclaredSchema`. `NOTE:` at `parseCatalogDdl` in `schema-export.ts`.

**Considered, no action:**
- The unreachable `createMaterializedView` arm. The ticket asked for it, it is harmless, and the alternative is a default branch.
- Cross-schema FK dependency order: documented ("a schema they name must exist before the apply"); the bundle import ticket applies schemas itself.
- Refusal branches untested: each is a one-line guard. A test would restate the code (see *Tests must pay for themselves*).
- Comment hygiene and file size: `schema-export.ts` is about 210 lines of small single-purpose functions, and its comments explain why, not what.
- Resource cleanup: the spec closes both databases in `finally`.

**Docs:** `docs/schema-declarative.md` updated as above. The `export_schema` → `exportSchemaDeclaration` comment renames in `catalog.ts`, `reserved-tags.ts` and `docs/vu-inverses.md` are correct. The bundle export ticket consumes this as `astToString(exportSchemaDeclaration(db, name))` and needs no change.

**Validation:** `yarn workspace @quereus/quereus run lint` clean; `yarn build` clean; `yarn test` all workspaces pass (quereus 11189 passing, 26 pending, 0 failing).
