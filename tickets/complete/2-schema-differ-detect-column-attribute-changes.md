description: Declarative schema differ + `ALTER TABLE ALTER COLUMN` support. Differ detects NOT NULL / DEFAULT / data-type drift; parser, planner, runtime, MemoryTableModule and StoreModule all handle single-attribute ALTER COLUMN statements with ordered migration DDL emission.
prereq: declarative schema, ALTER TABLE runtime, StoreModule.alterTable, MemoryTableModule.alterTable
files:
  - packages/quereus/src/schema/schema-differ.ts
  - packages/quereus/src/schema/catalog.ts
  - packages/quereus/src/parser/ast.ts
  - packages/quereus/src/parser/parser.ts
  - packages/quereus/src/emit/ast-stringify.ts
  - packages/quereus/src/planner/nodes/alter-table-node.ts
  - packages/quereus/src/planner/building/alter-table.ts
  - packages/quereus/src/vtab/module.ts
  - packages/quereus/src/runtime/emit/alter-table.ts
  - packages/quereus/src/vtab/memory/module.ts, table.ts, layer/manager.ts
  - packages/quereus-store/src/common/store-module.ts
  - packages/quereus-store/src/common/store-table.ts
  - packages/quereus/test/schema/differ-alter-column.spec.ts
  - packages/quereus/test/logic/41.2-alter-column.sqllogic
  - packages/quereus/test/parser.spec.ts
  - packages/quereus/test/schema-differ.spec.ts
  - docs/sql.md (ALTER COLUMN documentation + grammar)

----

## What shipped

Declarative schema differ now detects per-column drift and emits matching `ALTER TABLE ALTER COLUMN` DDL. `TableAlterDiff.columnsToAlter: ColumnAttributeChange[]` carries optional `notNull`, `dataType`, and `defaultValue` fields (`undefined` = no change; `null` on `defaultValue` = drop).

Detection rules:
- **Nullability** — only compared when the declared column explicitly states NULL / NOT NULL / PRIMARY KEY; unspecified columns inherit the session default and are never flagged.
- **DEFAULT** — AST structural comparison via stable JSON with `loc` stripped. Missing-in-declared + present-in-actual → `{ defaultValue: null }`.
- **Data type** — case-insensitive declared-name comparison against `CatalogTable.columns[i].type`.

`generateMigrationDDL` emits ADD COLUMN → ALTER COLUMN (type → default → nullability) → ALTER PRIMARY KEY → DROP COLUMN, so a newly-declared DEFAULT is in place before any SET NOT NULL tightening needs it for backfill.

## Runtime & modules

- `runAlterColumn` (`runtime/emit/alter-table.ts`) enforces exactly-one-attribute-per-statement, rejects nullability/type changes on PK columns, then dispatches to `module.alterTable({ type: 'alterColumn', ... })`.
- `MemoryTableManager.alterColumn`:
  - `SET NOT NULL` scans base-layer rows for NULL; if a literal DEFAULT exists, backfills; else throws `CONSTRAINT`.
  - `DROP NOT NULL` schema-only; PK rejected.
  - `SET DATA TYPE` is schema-only when physical type matches; otherwise walks rows via `validateAndParse`, throwing `MISMATCH` on conversion failure.
  - `SET/DROP DEFAULT` schema-only.
  - Rollback path mirrors `addColumn`/`dropColumn` (`baseLayer.updateSchema` + `tableSchema` restoration + PK-fns re-init).
- `StoreModule.alterTable` delegates NULL-scan + row-rewrite to two new `StoreTable` helpers — `rowsWithNullAtIndex` (count) and `mapRowsAtIndex(mapper)` — the latter uses a single batched write (matches existing `migrateRows` blast radius).
- IsolationModule passes through unchanged.

## Parser

`ALTER TABLE <t> ALTER COLUMN <c> …` dispatches to one of:
- `SET NOT NULL` → `{ setNotNull: true }`
- `DROP NOT NULL` → `{ setNotNull: false }`
- `SET DATA TYPE <type>` → `{ setDataType }`
- `SET DEFAULT <expr>` → `{ setDefault: expr }`
- `DROP DEFAULT` → `{ setDefault: null }`

Multi-attribute syntax in one statement is not supported by design. A shared `parseDataTypeName` helper handles parameterised types (e.g. `VARCHAR(40)`).

## Validation

**Unit** — `test/schema/differ-alter-column.spec.ts`: 9 cases covering nullability drift (both directions), added/changed/dropped DEFAULT, data-type drift, multi-attribute single-column change, no-op case, and DDL ordering (`SET DATA TYPE` → `SET DEFAULT` → `SET NOT NULL`).

**Parser** — `test/parser.spec.ts`: 5 forms round-trip to correct `alterColumn` action shapes.

**Integration** — `test/logic/41.2-alter-column.sqllogic`:
- `DROP NOT NULL` then insert NULL succeeds.
- `SET NOT NULL` on a table containing NULL rows → `CONSTRAINT` error.
- `SET NOT NULL` when no NULLs present → schema tightens; subsequent NULL inserts rejected.
- `SET DEFAULT` new inserts pick it up; `DROP DEFAULT` → omitted column → NULL.
- `SET DATA TYPE integer → real` preserves numeric row values.
- `DROP NOT NULL` on PK column → `CONSTRAINT` error.

## Build & test status

- `yarn workspace @quereus/quereus build` — clean.
- `yarn workspace @quereus/store build` — clean.
- `yarn workspace @quereus/quereus test` — 2443 passing, 2 pending.
- `yarn workspace @quereus/store test` — 167 passing.
- `yarn workspace @quereus/quereus lint` — 0 errors (275 pre-existing warnings unrelated).

## Usage

```sql
-- schema-only changes
alter table t alter column c drop not null;
alter table t alter column c set default 99;
alter table t alter column c drop default;

-- data-touching changes
alter table t alter column c set not null;       -- backfills NULLs if DEFAULT present
alter table t alter column c set data type real; -- converts each value
```

## Docs

`docs/sql.md` gained an **ALTER COLUMN** subsection under §2.7 and an `alter_column_stmt` production in the grammar appendix. `docs/schema.md` unchanged — the existing differ coverage description remains accurate.

## Known gaps (follow-up)

- `allow_destructive` gating from `plan/declarative-schema-enhancements.md` is not yet wired to attribute changes. When that work lands, destructive cases (SET NOT NULL requiring backfill, narrowing data-type changes) should plug into the same gate. Current behaviour: error on unsafe transitions rather than silent truncation.
- SiteCAD `DynamicsSession.playback_time` regression test lives in a separate repo; cannot be added from this monorepo.
