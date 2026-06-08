description: Fix for ALTER PRIMARY KEY shadow-table rebuild losing nullability and DEFAULT on non-MemoryTable modules. Release-blocker that caused "Database Initialization Error" in SiteCAD for every existing user when a declarative-schema change triggered a rekey on IndexedDB/LevelDB-backed tables.
prereq: none
files:
  - packages/quereus/src/runtime/emit/alter-table.ts          (buildShadowTableDdl extracted + fixed)
  - packages/quereus/test/runtime/shadow-ddl.spec.ts          (new — direct DDL unit coverage)
  - packages/quereus/test/logic/41.1-alter-pk.sqllogic        (regression case 10a)
----

## What shipped

`rebuildViaShadowTable` (the non-memory fallback path in `runtime/emit/alter-table.ts`) emitted CREATE TABLE DDL for the shadow table with no explicit nullability on nullable columns. Because the session default is NOT NULL, re-parsing that DDL promoted every nullable column to NOT NULL and the row-copy step failed with `NOT NULL constraint failed` for any row containing an actual NULL, aborting the upgrade transaction.

Fix: the DDL-string construction is now a pure exported helper `buildShadowTableDdl(tableSchema, shadowName, survivingColumns, newPkDef): string` that:

- emits explicit `null` or `not null` on every column (matches the no-db branch of `generateTableDDL` in `schema/ddl-generator.ts`, safe under any `default_column_nullability` setting)
- preserves `default <expr>` via `expressionToString` (same path used by `formatDefaultExpression`)
- preserves `collate <name>` for non-BINARY collations
- preserves the composite / empty-PK distinction and `using <module>` args

MemoryTable path is unchanged — it copies `ColumnSchema` objects programmatically via `module.create()` and never stringifies DDL, which is why no existing sqllogic test caught the bug.

## Testing

- `packages/quereus/test/runtime/shadow-ddl.spec.ts` — 8 cases covering `null`/`not null` emission, DEFAULT preservation, COLLATE passthrough/omit, composite PK, empty PK, and a full round-trip that executes the emitted DDL in a fresh DB and re-asserts nullability/default/collation via the parser.
- `packages/quereus/test/logic/41.1-alter-pk.sqllogic` case 10a — populated-table rekey with NULL in a nullable column and a defaulted column; asserts row survival, NULL preservation, and `notnull=0` via `table_info`.

## Commands run

- `yarn build` — clean
- `yarn test` — 2428 passing / 2 pending (pre-existing)
- `yarn lint` — 0 errors, 274 pre-existing warnings

## Usage note

No user-facing SQL change. The DDL grammar in `docs/sql.md` and module-author docs describe the rebuild fallback at a behavioral level that remains accurate. Downstream plugins (`quereus-plugin-indexeddb`, `quereus-plugin-leveldb`) need a rebuild to pick up the fix.

## Known follow-up gaps (not filed as tickets)

The reviewer may open these if they want them chased:

- No quereus-owned non-memory module fixture exists, so alter-table sqllogic tests only exercise the MemoryTable programmatic path. A test-only module that forces the DDL-stringify branch would let the sqllogic suite run both modes and catch future regressions in shadow-DDL emitters here.
- `quereus-plugin-indexeddb` / `quereus-isolation` have no alter-PK-with-NULL-data scenario in their own suites.
- Other shadow-DDL emitters (column drop/add fallbacks, future `ALTER COLUMN`) deserve the same pure-helper + unit-test treatment.
- Secondary: `extractDeclaredPK` in `schema/schema-differ.ts:283` defaults to *all columns* when no explicit `primary key` clause is present, so a table declared without any PK clause compared against an actual PK of `[]` will emit a spurious `ALTER PRIMARY KEY ()`. Only fires when declared DDL omits the `primary key ()` clause; explicit-empty declarations match correctly. Real PK changes still hit `rebuildViaShadowTable` and would have failed identically without this fix.
