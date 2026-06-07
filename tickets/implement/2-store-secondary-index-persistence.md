description: Persist store-backed secondary indexes across close → reopen by bundling each table's CREATE INDEX DDL into its catalog entry. StoreModule.createIndex/dropIndex must (re)write the bundle, rehydrateCatalog must refresh connected StoreTables so DML maintains the rehydrated indexes, and ALTER INDEX … SET TAGS must round-trip via the existing table_modified persist path.
prereq: index-ddl-roundtrip
files:
  - packages/quereus-store/src/common/store-module.ts     # createIndex/dropIndex/saveTableDDL/persistCatalogIfChanged/rehydrateCatalog/loadAllDDL
  - packages/quereus-store/src/common/store-table.ts       # cached tableSchema, releaseIndexStore, ddlSaved, getIndexStore
  - packages/quereus-store/test/rehydrate-catalog.spec.ts  # reopen harness (teardown provider)
  - packages/quereus-store/test/tag-persistence.spec.ts    # persistent provider + reopen() helper, putCount spy pattern
  - packages/quereus-store/test/column-default-conflict.spec.ts # existing live-index store tests
  - docs/schema.md                                         # store persistence / catalog section
----

# Persist store-backed secondary indexes across reconnect (store)

## Why

`StoreModule.saveTableDDL` persists only `generateTableDDL` (no indexes), and
`createIndex`/`dropIndex` never write to the `__catalog__` store at all. So a
`CREATE INDEX` on a `using store` table is lost on close → reopen →
`rehydrateCatalog`: the in-memory index disappears, its backing KV store is
orphaned, and `ALTER INDEX … SET TAGS` cannot round-trip. The engine round-trip
fidelity this needs lands in `index-ddl-roundtrip` (prereq); this ticket wires
the store catalog to use it.

## Design: bundle index DDL into the table's catalog entry

Persist each table's indexes as additional statements **inside the same catalog
entry** keyed `{schema}.{table}` (no new key namespace). The entry becomes:

```
CREATE TABLE "main"."t" (...) USING store
CREATE INDEX "t_b" ON "main"."t" ("b")
CREATE UNIQUE INDEX "t_email" ON "main"."t" ("email") WHERE "email" IS NOT NULL
```

(table statement first, one index statement per line). The prereq's
`importCatalog` change consumes such a multi-statement entry via `parser.parseAll`
and imports each in document order, so the table is registered before its indexes
and each `CREATE INDEX` resolves its (co-located) table.

**Why bundling over a separate per-index catalog key:** every place that already
re-persists a table — `saveTableDDL` (called by every `alterTable` arm and
`renameTable`) and the `table_modified` listener (`persistCatalogIfChanged`) —
then persists its indexes *for free*, with no per-index reconciliation logic:

- `DROP TABLE` → `removeTableDDL` deletes the single key → indexes vanish with it
  (no orphan catalog entries to sweep).
- `RENAME TABLE` → `saveTableDDL(renamedSchema)` regenerates the bundle;
  `generateIndexDDL` uses `renamedSchema.name`, so index statements reference the
  new table name automatically.
- `ALTER INDEX … SET TAGS` → `setIndexTags` fires `table_modified` on the OWNING
  table with the updated table schema (index tags live in `tableSchema.indexes`).
  `persistCatalogIfChanged`, regenerating the bundle, re-persists the changed
  index DDL with no new code. (A separate-key design would have to map a
  table_modified event onto individual index entries — strictly more, and more
  error-prone, plumbing.)
- structural ALTERs that reindex columns (drop/rename column, alter PK) already
  call `saveTableDDL(updatedSchema)` → the bundle's index statements track the
  reindexed columns automatically.

### Bundle helper

Add a private `buildCatalogEntry(tableSchema): string`:

- `generateTableDDL(tableSchema)` (no `db` arg — keep the existing
  persistence-safe fully-qualified form), then for each persistable index append
  `'\n' + generateIndexDDL(idx, tableSchema)` (also no `db` arg).
- **Persistable** = exclude hidden/derived implicit covering indexes. For store
  tables `buildTableSchemaFromAST` adds none (a store table's `.indexes` are all
  real `CREATE INDEX`), so in practice every entry is included — but guard with
  `!isHiddenImplicitIndex(tableSchema, idx.name)` (exported from `@quereus/quereus`)
  for robustness, and document the assumption. A `CREATE UNIQUE INDEX`'s derived
  UNIQUE constraint is already excluded from the table DDL by `emitTableConstraints`,
  so it round-trips solely via its `CREATE UNIQUE INDEX` line — no double.

`saveTableDDL` writes `buildCatalogEntry(tableSchema)` instead of bare table DDL.
`persistCatalogIfChanged` (tag listener) compares/regenerates via
`buildCatalogEntry(newObject)` (keep absent→skip and identical→skip).

### createIndex / dropIndex

- `createIndex`: after `table.updateSchema(updatedSchema)`, add
  `await this.saveTableDDL(updatedSchema)` — the core missing write. This is the
  authoritative persist (it works even when the table has no rows yet and was
  never lazily persisted). SchemaManager.createIndex also fires `table_modified`
  afterward; `persistCatalogIfChanged` then regenerates the *same* bundle and
  skips (identical) — verify exactly one effective write (reuse the `putCount`
  spy pattern from `tag-persistence.spec.ts` "no second differing write").
- `dropIndex`: after `table.updateSchema(updatedSchema)` (index removed), add
  `await this.saveTableDDL(updatedSchema)` to rewrite the bundle without the
  dropped index, then proceed with the existing physical teardown
  (`releaseIndexStore` + `deleteIndexStore`/`closeIndexStore`).

### rehydrateCatalog refresh

`importIndex` updates the SchemaManager schema but NOT the live `StoreTable`
instance connected during `importTable` (which captured the table-only schema).
After the import loop in `rehydrateCatalog`, refresh each connected table from the
now-current registry:

```
for each connected StoreTable (this.tables):
  const fresh = db.schemaManager.getTable(schemaName, tableName)
  if (fresh) table.updateSchema(fresh)
```

so DML maintains the rehydrated indexes and store UNIQUE enforcement (the derived
`uniqueConstraints` added by the prereq's `importIndex`) fires. Do this in the
store module — `importCatalog` deliberately skips module hooks, so the engine
must stay generic.

`loadAllDDL` is unchanged (it returns each catalog entry verbatim; entries are
now multi-statement bundles that the prereq's `importCatalog` splits).

## Edge cases & interactions

- **Lazy DDL save vs eager createIndex persist** — `createIndex` persisting the
  bundle also writes the table DDL before any insert. Confirm this does not
  collide with `StoreTable.ddlSaved` lazy-save (set `ddlSaved` if that flag would
  otherwise trigger a later redundant table-only write). Net effect must be:
  exactly one catalog write per createIndex, bundle includes the index.
- **No double-write on createIndex** — explicit `saveTableDDL` + the follow-up
  `table_modified` listener compare. The listener regenerates an identical bundle
  → skip. Pin with a put-count assertion.
- **Statement splitting is parser-based** — the bundle is consumed by
  `parser.parseAll` (prereq), NOT a naive `\n` split, so a DEFAULT/CHECK/partial
  predicate string literal containing a newline is safe. If the implementer ever
  splits in store code instead, it MUST slice by AST `loc.start.offset`/
  `loc.end.offset` (offsets are present), never on `\n`.
- **DROP TABLE** — `removeTableDDL` deletes the single bundle key; confirm
  `deleteTableStores` tears down index KV stores (it does — see indexeddb
  provider). After reopen the table and its indexes must NOT resurrect.
- **RENAME TABLE** — bundle regenerates under the new name via the existing
  `saveTableDDL(renamedSchema)`; physical index dirs relocated by
  `renameTableStores`. After reopen the index is present under the new name and
  absent under the old.
- **Reattach, not rebuild** — the physical index store already holds entries on
  disk; rehydrate must NOT rebuild it. Reattachment is automatic via
  `StoreTable.getIndexStore` (lazy `provider.getIndexStore`) once the index is in
  the refreshed cached schema. Assert backing-store entry counts survive reopen
  (no rebuild, no loss).
- **Partial index on reopen** — only in-scope rows are indexed; an INSERT of an
  out-of-scope row after reopen adds no index entry (the predicate must survive,
  which depends on the prereq).
- **DESC + COLLATE columns** — must round-trip (`index_info` desc/collation after
  reopen).
- **Inline UNIQUE constraint + separate CREATE INDEX on one table** — the inline
  UNIQUE round-trips via the table DDL (table constraint), the CREATE INDEX via
  its own bundle line; both survive, neither doubles the other.
- **Partial-failure** — if `saveTableDDL` fails after `createIndex` built the
  physical store, the in-memory schema has the index but the catalog does not →
  on reopen the index is missing and the store is orphaned. This matches the
  existing best-effort persistence contract; document it (do not add a 2-phase
  protocol here).
- **Isolation wrapper** — tests exercise a bare `StoreModule` (as the existing
  tag/rehydrate specs do); `IsolationModule`-wrapped persistence is out of scope,
  mirroring `tag-persistence.spec.ts`.

## Tests

Use the persistent (no-op close) provider + `open()`/`reopen()` helpers from
`tag-persistence.spec.ts` (the only way to express close → reopen against the
same storage). Put new cases in `rehydrate-catalog.spec.ts` or a new
`index-persistence.spec.ts`.

- **plain CREATE INDEX survives reopen**: `index_info` lists it; backing index
  store entry count == row count; an INSERT after reopen grows the index store
  (DML maintains it); an index-backed `WHERE col = ?` returns the right rows.
- **CREATE UNIQUE INDEX survives reopen**: duplicate rejected (`/constraint/i`),
  distinct succeeds; `index_info` unique=1.
- **partial CREATE INDEX (WHERE) survives reopen**: `index_info` partial=1;
  an out-of-scope INSERT adds no index entry; an in-scope one does.
- **DESC + COLLATE columns round-trip** across reopen (`index_info` desc/collation).
- **multi-index table**: two indexes both survive; `result.errors` empty (bundle
  imports table-before-indexes cleanly).
- **DROP INDEX is durable**: create → drop → reopen → index absent in
  `index_info`; the bundle entry no longer carries it; backing store gone.
- **DROP TABLE then reopen**: no table/index resurrection; no orphan catalog entry.
- **RENAME TABLE then reopen**: index present under new name, absent under old.
- **ALTER INDEX … SET TAGS / ADD TAGS / DROP TAGS** round-trip via `index_info`
  after reopen.
- **inline UNIQUE + separate index on same table**: both enforce/exist after reopen.
- **no double-write**: put-count spy shows exactly one effective catalog write
  for a `CREATE INDEX` (createIndex write + identical listener skip).

## TODO

- Add private `buildCatalogEntry(tableSchema)` (table DDL + persistable index DDL,
  newline-joined; exclude hidden implicit covering indexes).
- `saveTableDDL`: write `buildCatalogEntry(tableSchema)`.
- `persistCatalogIfChanged`: compare/regenerate via `buildCatalogEntry(newObject)`.
- `createIndex`: `await this.saveTableDDL(updatedSchema)` after `updateSchema`;
  reconcile with `StoreTable.ddlSaved` so it's exactly one write.
- `dropIndex`: `await this.saveTableDDL(updatedSchema)` after `updateSchema`,
  before physical teardown.
- `rehydrateCatalog`: after the import loop, refresh each connected `StoreTable`
  from `db.schemaManager.getTable(...)`.
- Confirm `deleteTableStores`/`renameTableStores` cover index stores (no orphans
  on DROP/RENAME).
- Add the reopen tests above (persistent-provider harness).
- Run `yarn workspace @quereus/quereus-store test` and (for the store code path)
  spot-check via the store harness; `yarn build` + lint clean.
- Docs: update `docs/schema.md` store-persistence/catalog notes to describe the
  bundled catalog entry and index reattach-on-reopen.
