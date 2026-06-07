description: Fix store-name prefix collision where RENAME/DROP of table `t` corrupts a sibling table literally named `t_idx_<x>`. Replace prefix-scan index discovery in the KV providers with an authoritative index-name list passed down from the StoreModule caller (which knows the table's real indexes from the schema), and build exact index store names via `buildIndexStoreName`.
prereq:
files:
  - packages/quereus-store/src/common/kv-store.ts            # KVStoreProvider interface — add indexNames param to renameTableStores/deleteTableStores
  - packages/quereus-store/src/common/store-module.ts        # renameTable (~1152) + destroy (~293) callers — source the index list, pass it down
  - packages/quereus-plugin-indexeddb/src/provider.ts        # renameTableStores + deleteTableStores object-store sweeps
  - packages/quereus-plugin-leveldb/src/provider.ts          # renameTableStores + deleteTableStores index-dir sweeps
  - packages/quereus-plugin-nativescript-sqlite/src/provider.ts  # deleteTableStores prefix sweep (same bug; interface signature change reaches it)
  - packages/quereus-plugin-react-native-leveldb/src/provider.ts # deleteTableStores prefix sweep (same bug)
  - packages/quereus-store/src/common/key-builder.ts         # buildIndexStoreName / STORE_SUFFIX.INDEX (naming scheme; no change expected)
  - packages/quereus-plugin-indexeddb/test/rename-persistence.spec.ts  # model harness for an IDB sibling-collision regression test
  - packages/quereus-store/test/index-persistence.spec.ts    # in-memory test double replicates the buggy prefix scan — must adopt indexNames
  - packages/quereus-store/test/alter-table.spec.ts          # in-memory test double for renameTableStores — must adopt indexNames
----

# Store-name prefix collision between a table and `<table>_idx_*` siblings

## Problem (confirmed by inspection)

Index stores are named `{schema}.{table}_idx_{indexName}` (see `buildIndexStoreName`,
`STORE_SUFFIX.INDEX = '_idx_'`) and the providers discover a table's index stores by
**prefix-matching** the live store list:

```ts
const oldIndexPrefix = `${oldDataStoreName}${STORE_SUFFIX.INDEX}`; // "main.t_idx_"
for (const name of this.manager.getObjectStoreNames()) {
  if (!name.startsWith(oldIndexPrefix)) continue;   // <-- too loose
  ...
}
```

`_idx_` is a legal substring of an ordinary identifier, so a sibling table named
`t_idx_archive` has data store `main.t_idx_archive`, which **also** satisfies
`startsWith("main.t_idx_")`. Operating on table `t`:

- **RENAME `t` → `t2`** relocates `main.t_idx_archive` to `main.t2_idx_archive`,
  treating the sibling's data store as an index named `archive` of `t` — silently
  moving (orphaning) the unrelated table's rows.
- **DROP `t`** deletes `main.t_idx_archive` — destroying the sibling's rows.

This is present in **both** rename and delete paths of the IndexedDB
(`provider.ts:149-191`) and LevelDB (`provider.ts:174-250`) providers, and in the
`deleteTableStores` prefix sweep of the nativescript-sqlite and react-native-leveldb
providers. It predates the `renameTableStores` feature; the rename path widened the
blast radius from "delete sibling" to "silently move sibling".

The ambiguity is **structural** — the flat naming scheme has no unambiguous delimiter
between the `{table}` and `{index}` segments, so tightening the regex cannot help.

## Reproduction sketch

```sql
create table t (id integer primary key, b integer) using store;
create table "t_idx_archive" (id integer primary key) using store;
insert into "t_idx_archive" values (1);
alter table t rename to t2;          -- t_idx_archive's data store is moved under t2
select * from "t_idx_archive";       -- rows now unreachable / store orphaned
-- (likewise `drop table t` destroys t_idx_archive's store)
```

## Fix: authoritative index list, not prefix scanning

The caller already holds the table's real index names. Pass them down and have each
provider build **exact** index store names — eliminating the prefix scan.

### Why the schema's index list is complete and exact (store mode)

For `using store` tables, `tableSchema.indexes` corresponds **1:1** to the physical
index stores: every entry is a real `CREATE INDEX` whose backing store was created via
`provider.getIndexStore(schema, table, indexSchema.name)` in `StoreModule.createIndex`.
Store-mode UNIQUE constraints (inline or `ADD CONSTRAINT`) are enforced by a full scan
over `uniqueConstraints` and create **no** physical index store — so there is no hidden
or exposed *implicit* covering index store to discover. This is corroborated by the
`buildCatalogEntry` comment in store-module.ts ("For store tables
`buildTableSchemaFromAST` synthesizes none of those …"). Therefore
`tableSchema.indexes.map(i => i.name)` is the exact, complete set of index stores —
no `isHiddenImplicitIndex` filtering is needed for the *physical* sweep (that filter is
about catalog DDL visibility, not store existence).

Use the index names **verbatim** as stored in `tableSchema.indexes[].name` — that is
the same string `createIndex` passed to `getIndexStore`, so it reproduces the exact
store name (IndexedDB) and directory path (LevelDB, which uses original-case
`${tableName}_idx_${indexName}` for the path while lowercasing the store-map key).

### Interface change (kv-store.ts)

Add a trailing `indexNames: readonly string[]` to both optional hooks:

```ts
renameTableStores?(schemaName: string, oldName: string, newName: string, indexNames: readonly string[]): Promise<void>;
deleteTableStores?(schemaName: string, tableName: string, indexNames: readonly string[]): Promise<void>;
```

(No backwards-compat shim — AGENTS says don't worry about it yet. TypeScript still
accepts existing 2-/3-arg implementations as assignable, but update them all anyway so
they actually use the list.)

### Caller sourcing of the index list (store-module.ts)

- `renameTable` (~1152): `currentSchema` is already captured before in-memory eviction
  (`existing?.getSchema() ?? db.schemaManager.getTable(schemaName, oldName)`). Derive
  `const indexNames = (currentSchema?.indexes ?? []).map(i => i.name);` and pass it to
  `renameTableStores`. (Capture it before the `this.tables.delete(oldKey)` block.)
- `destroy` (~293): `table` is captured before the maps are cleared. Source the schema
  as `table?.getSchema() ?? db.schemaManager.getTable(schemaName, tableName)` — this
  requires renaming the unused `_db` param to `db`. Derive `indexNames` the same way and
  pass to `deleteTableStores`. If neither source yields a schema (already deregistered),
  fall back to `[]` and accept that index stores cannot be swept by name in that edge
  case (document it; it is no worse than today for the no-sibling case, and far safer for
  the sibling case). Verify the engine's DROP ordering still has the schema available
  here — `renameTable` already relies on the same `schemaManager.getTable` fallback, so
  the pattern is proven.

### Provider changes

IndexedDB (`provider.ts`):
- `renameTableStores`: drop the `oldIndexPrefix` scan over `getObjectStoreNames()`.
  Iterate `indexNames`, compute `from = buildIndexStoreName(schema, oldName, name)` /
  `to = buildIndexStoreName(schema, newName, name)`, and only include `from` in the
  rename list when `this.manager.hasObjectStore(from)` (an index store may not have
  materialized). Keep the destination-collision guard per target.
- `deleteTableStores`: drop the `indexPrefix` scan; for each `name` in `indexNames`,
  `closeStoreByName` + `deleteObjectStore` on `buildIndexStoreName(schema, table, name)`
  guarded by `hasObjectStore`.

LevelDB (`provider.ts`):
- `renameTableStores`: replace both the open-handle prefix scan (`this.stores.keys()`
  startsWith) **and** the `readdir(schemaDir)` + `oldIndexDirPrefix` loop. For each
  `name` in `indexNames`: close the handle for store-key
  `${schema}.${oldName}_idx_${name}` (lowercased, as the map is keyed), then
  `fs.promises.rename` the directory `path.join(schemaDir, `${oldName}_idx_${name}`)` →
  `path.join(schemaDir, `${newName}_idx_${name}`)` when the source path exists. Mirror
  the existing path construction in `getIndexStore`/`deleteIndexStore` (original-case
  table+index in the path).
- `deleteTableStores`: replace the `this.stores.keys()` prefix scan and the post-restart
  `readdir` + `indexDirPrefix` sweep with an `indexNames` loop: close the handle and
  `removeDir(path.join(this.basePath, schema, `${tableName}_idx_${name}`))`. This keeps
  the post-restart cleanup correct (index names come from the rehydrated schema) while
  removing the ambiguity. Note the tradeoff: a truly orphaned index dir not present in
  the schema (e.g. left by a crash mid-DROP INDEX) is no longer incidentally swept —
  acceptable, and the safe choice; mention it in the review handoff.

nativescript-sqlite + react-native-leveldb (`provider.ts` each):
- `deleteTableStores`: same change — iterate `indexNames`, build the exact store key
  (`${getStoreKey(schema,table)}_idx_${name}`), and close/remove that handle instead of
  the `indexPrefix` startsWith scan. (Neither implements `renameTableStores`, so only the
  delete path needs touching.)

### Test doubles (store package)

`index-persistence.spec.ts` and `alter-table.spec.ts` define in-memory `KVStoreProvider`
doubles whose `renameTableStores`/`deleteTableStores` replicate the **same buggy prefix
scan**. Update them to accept the new `indexNames` param and key off it (build
`${s}.${newName}_idx_${name}`) so the doubles match real provider semantics and don't
mask the regression.

## Scope / acceptance

- RENAME and DROP of a table `t` must not touch any store of a sibling table whose name
  starts with `t_idx_`.
- Fix applied to IndexedDB and LevelDB (rename + delete) and to nativescript-sqlite and
  react-native-leveldb (delete) providers, plus the shared `KVStoreProvider` interface.
- Regression tests in both primary plugins: a `<table>` + `<table>_idx_<x>` sibling pair,
  asserting RENAME and DROP of `<table>` leave the sibling's stores and rows intact, and
  that the real index of `<table>` is still moved/removed correctly.

## TODO

### Phase 1 — interface + caller
- [ ] kv-store.ts: add `indexNames: readonly string[]` to `renameTableStores?` and
      `deleteTableStores?`; update the doc comments and the README interface snippet
      (`packages/quereus-store/README.md`).
- [ ] store-module.ts `renameTable`: compute `indexNames` from `currentSchema.indexes`
      and pass to `renameTableStores`.
- [ ] store-module.ts `destroy`: rename `_db`→`db`, source schema via
      `table?.getSchema() ?? db.schemaManager.getTable(...)`, compute `indexNames`, pass
      to `deleteTableStores`; fall back to `[]` if no schema and document it.

### Phase 2 — providers
- [ ] indexeddb/provider.ts: rewrite `renameTableStores` + `deleteTableStores` index
      handling to iterate `indexNames` with `buildIndexStoreName` + `hasObjectStore`.
- [ ] leveldb/provider.ts: rewrite `renameTableStores` + `deleteTableStores` index
      handling to iterate `indexNames`; remove the `readdir`+prefix sweeps; build exact
      dir paths mirroring `getIndexStore`/`deleteIndexStore`.
- [ ] nativescript-sqlite/provider.ts + react-native-leveldb/provider.ts:
      `deleteTableStores` iterates `indexNames` instead of the prefix scan.

### Phase 3 — tests
- [ ] Update in-memory test doubles in `index-persistence.spec.ts` and
      `alter-table.spec.ts` to the new signature (key off `indexNames`).
- [ ] IndexedDB regression test (new spec or extend `rename-persistence.spec.ts`,
      modeled on its `fake-indexeddb` + real `Database`/`StoreModule` harness): create
      `t (… ) using store` + `"t_idx_archive" (…) using store` with rows; assert
      `alter table t rename to t2` and (separately) `drop table t` leave
      `t_idx_archive`'s data store + rows intact, while `t`'s real index still relocates
      / is removed.
- [ ] LevelDB regression test (new spec under `packages/quereus-plugin-leveldb/test/`,
      using a temp dir like `store.spec.ts`, wiring a real `Database` + `StoreModule`
      over `LevelDBProvider`): same sibling-pair assertions, checking on-disk index
      directories.

### Phase 4 — validate
- [ ] `yarn workspace @quereus/store run build` (or `yarn build`) + `yarn test` (store
      package doubles + engine).
- [ ] `yarn workspace @quereus/plugin-indexeddb test` and
      `yarn workspace @quereus/plugin-leveldb test` (stream output with `Tee-Object`).
- [ ] `tsc --noEmit` for the two RN/NS providers (no test suites; ensure they compile
      against the new interface) — `yarn workspace @quereus/plugin-nativescript-sqlite run typecheck` / react-native-leveldb equivalent.
- [ ] Lint `packages/quereus` only if its files changed (store-module is in
      `@quereus/store`, not linted) — n/a here unless engine files touched.
