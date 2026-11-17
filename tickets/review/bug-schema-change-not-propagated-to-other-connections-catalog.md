description: When two open connections share one table and one of them changes the table's columns, the other connection used to keep its old column list and silently read or write values in the wrong columns. It now fails with a clear "table altered outside this connection — re-open" error instead.
architecture: docs/schema.md
files:
  - packages/quereus/src/runtime/stale-catalog-guard.ts            # new: assertCatalogMatchesModule + layout comparison
  - packages/quereus/src/runtime/emit/scan.ts                      # scan leaf connect (uses effectiveName)
  - packages/quereus/src/runtime/utils.ts                          # getVTable (DML connect)
  - packages/quereus/src/runtime/emit/remote-query.ts              # pushdown connect
  - packages/quereus/src/runtime/emit/analyze.ts                   # ANALYZE connect (error lands in the existing per-table catch)
  - packages/quereus/test/vtab/shared-module-stale-catalog.spec.ts # new reproduction test
  - packages/quereus-isolation/test/alter-table-conformance.spec.ts
  - packages/quereus-isolation/test/isolation-layer.spec.ts
  - docs/schema.md
  - docs/design-isolation-layer.md
  - tickets/backlog/feat-connection-adopts-another-connections-schema-change.md
repro: verified
---

# What was built

Each `Database` keeps its own catalog, but two `Database`s that register one module instance share that module's tables. An ALTER on one left the other planning against its old entry while the module stored rows in the new layout. After DROP COLUMN this corrupted inserts (values landed one column over).

`assertCatalogMatchesModule(db, module, schemaName, tableName, vtab)` in `packages/quereus/src/runtime/stale-catalog-guard.ts` runs right after `module.connect(...)` at all four runtime connect sites (scan leaf, `getVTable`, remote-query pushdown, ANALYZE). It compares the connecting `Database`'s **current** catalog entry (not the plan's schema) with the instance's `tableSchema`. When they differ, it disconnects the instance and throws `QuereusError(..., StatusCode.SCHEMA)`: `Table main.t was altered outside this connection (<first difference>); this connection's definition of it is stale — re-open the connection`.

Short-circuits, in order:
- the instance reports no `tableSchema`;
- the **registered** module (the one passed in, not `vtab.module`) has no `alterTable`;
- there is no catalog entry under that name;
- the catalog entry and the instance's schema are the same object;
- the `columns` / `primaryKeyDefinition` arrays are the same objects, or individual column objects are.

# Deviations from the fix-stage design (reviewer: please weigh these)

The ticket asked for a comparison of column count, plus name, type, collation, not-null and generated-ness per column, plus the primary key (and leaned toward including DEFAULT). The full suite showed that a single `Database` legitimately lets its catalog differ from the module's instance on several of those. So the comparison is narrower: **column count, column names in order (case-insensitive), generated-ness, and the primary-key definition (index + direction)**. These are what decide which column slot and which row a value belongs to. Each exclusion matches a real single-connection false positive found in the suite:

- **NOT NULL**: `packages/quereus/test/alter-add-column-delegate.spec.ts`'s `TotalMemoryModule` reports NOT NULL on the column to the engine, while its instance's `tableSchema` (the memory manager's) keeps the column nullable. Every read after the ALTER failed.
- **Type and collation**: during a materialized-view reshape, `validateDeclaredConstraintsOverContents` (`runtime/emit/materialized-view-helpers.ts`) registers a catalog preview of the types and collations it is about to apply (`previewReshapedColumns`) while the module still holds the old ones. The validation scan connects inside that window. This broke 10 tests in `maintained-table-refresh-revalidation.spec.ts`. The ticket's suggested fix for windows ("skip when the plan's schema is identical to the module's") does not apply: the plan is built against the preview. Recognising this window would need the engine to mark it explicitly.
- **DEFAULT**: no false positive was found, but it is the same "which value gets written" category as type, not "which column it lands in". I dropped it to keep one consistent rule. Easy to add back (stringify via `expressionToString` and compare) if the reviewer disagrees.
- **Modules without `alterTable`**: the engine applies RENAME COLUMN to its own catalog only (`runtime/emit/alter-table.ts`, the schema-only `renameColumn` fallback), so such a module's instance keeps the create-time names by design. No other ALTER reaches its layout, so skipping it is not a hole. It must be the *registered* module: `test/no-alter-module.ts` wraps a `MemoryTableModule`, so `vtab.module` does have `alterTable`.

The changes the guard therefore does not catch (constraint, type, collation and default drift) are added as an arm of `tickets/backlog/feat-connection-adopts-another-connections-schema-change.md`, and listed in `docs/schema.md`.

# Tests

- **Added** `packages/quereus/test/vtab/shared-module-stale-catalog.spec.ts` (plain shared `MemoryTableModule`, no isolation):
  - A drops column `x`. B's `select *` and B's `insert` both throw `SCHEMA`, and the table's rows are unchanged. Confirmed failing with the guard disabled (`stale read: expected undefined to equal 17`).
  - A runs `alter table t set tags (...)`. B keeps reading and inserting (pins "tags excluded").
- **Changed** `packages/quereus-isolation/test/alter-table-conformance.spec.ts`, two-connection ADD COLUMN test (×2 spellings). B's read now expects `SCHEMA` (was `CONSTRAINT`). B's commit still expects `CONSTRAINT` (overlay poison; the commit flush does not connect through the engine). Added an assertion that B's `rollback` succeeds afterwards. Rewrote the comment that pointed at this ticket.
- **Changed** `packages/quereus-isolation/test/isolation-layer.spec.ts`, "a MEMORY underlying with a clean issuer overlay honors the ALTER natively end-to-end". The test calls `IsolationModule.alterTable` directly, bypassing the engine, then reads. The guard correctly flagged the catalog as still keyed by `id`. The test now registers the module's returned schema (`addTable(updated)`), as the engine's ALTER does.

Validation run after the final source change: `yarn test` (all workspaces) green; `yarn test:store` green (11180 passing); `yarn workspace @quereus/quereus lint` exit 0; `tsc -b tsconfig.build.json` clean.

# Known gaps / things to look at

- **Not covered by design** (documented in `docs/schema.md` § "Catalogs are per connection"):
  - statements already running when the other connection alters the table (there is a `NOTE:` tripwire at the helper);
  - modules whose instances do not report `tableSchema`;
  - separate processes or separate module instances over one store.
- **ANALYZE** on a stale table: the `SCHEMA` error is swallowed by ANALYZE's existing per-table catch (debug log, table omitted from the report). This matches the accepted `NOTE:` there. The guard still stops stats from being recorded against the wrong columns.
- **Isolation lazy schema**: `IsolatedTable.tableSchema` is copied from the underlying at construction, so the guard depends on the underlying having a schema at connect time. The memory and store underlyings always do; a lazily-populating underlying gets no protection until its schema appears.
- **Store module**: `StoreModule.connect` returns a cached `StoreTable` per module instance. Two `Database`s sharing one `StoreModule` are covered the same way as memory. `yarn test:store` produced no false positives, so a rebuilt-but-equivalent schema passes the comparison; names-only comparison avoids the type and collation spelling risk the ticket raised.
- **Performance**: after any ALTER or ANALYZE the catalog object differs from the module's object, so most connects take the structural path. It is an identity check per column object (the spread `{...schema}` keeps the column array shared) and, at worst, O(columns) string comparisons. Not measured; expected to be small next to the cost of `connect` itself.
