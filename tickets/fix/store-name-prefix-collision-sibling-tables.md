description: Store-name prefix matching in the KV providers can misfire on sibling tables whose name begins with `<table>_idx_…`, causing RENAME/DROP to silently relocate or delete an unrelated table's data + index stores. The flat `{schema}.{table}_idx_{index}` naming scheme is ambiguous: `name.startsWith('{schema}.{table}_idx_')` matches both real index stores of `{table}` AND the data store of a sibling table literally named `{table}_idx_x`. Pre-existing and present in every provider's `deleteTableStores`/`renameTableStores` index sweep (IndexedDB + LevelDB), surfaced while reviewing the IndexedDB `renameTableStores` work.
files:
  - packages/quereus-plugin-indexeddb/src/provider.ts   # renameTableStores + deleteTableStores index-prefix sweeps
  - packages/quereus-plugin-leveldb/src/provider.ts      # renameTableStores + deleteTableStores index-dir sweeps
  - packages/quereus-store/src/common/key-builder.ts     # buildIndexStoreName / STORE_SUFFIX.INDEX (naming scheme)
  - packages/quereus-store/src/common/store-module.ts    # renameTable / dropTable callers (have the real index list)
----

# Store-name prefix collision between a table and `<table>_idx_*` siblings

## Problem

Index stores are named `{schema}.{table}_idx_{indexName}` and discovered by
prefix match against the live object-store / directory list:

```ts
const oldIndexPrefix = `${oldDataStoreName}${STORE_SUFFIX.INDEX}`; // "main.t_idx_"
for (const name of this.manager.getObjectStoreNames()) {
  if (!name.startsWith(oldIndexPrefix)) continue;   // <-- too loose
  ...
}
```

`_idx_` is a legal substring of an ordinary identifier, so a **sibling table**
named e.g. `t_idx_archive` has a data store `main.t_idx_archive` that *also*
satisfies `startsWith("main.t_idx_")`. Consequences when operating on table `t`:

- **RENAME `t` → `t2`**: the sweep treats `main.t_idx_archive` as an index named
  `archive` of `t` and relocates it to `main.t2_idx_archive` — corrupting/orphaning
  the unrelated `t_idx_archive` table's data store (and the engine still points at
  the old name). Silent data loss for the sibling.
- **DROP `t`**: the same sweep in `deleteTableStores` deletes `main.t_idx_archive`
  — destroying the sibling table's rows.

This affects **both** the IndexedDB provider (object-store name sweep) and the
LevelDB provider (index-directory sweep), in **both** the rename and delete paths.
It is pre-existing (predates the `renameTableStores` feature) but the rename path
widens the blast radius from "delete sibling" to "silently move sibling".

## Reproduction sketch

```sql
create table t (id integer primary key, b integer) using store;
create table "t_idx_archive" (id integer primary key) using store;
insert into "t_idx_archive" values (1);
alter table t rename to t2;          -- t_idx_archive's data store gets moved under t2
select * from "t_idx_archive";       -- rows now unreachable / store orphaned
```

(Likewise `drop table t` destroys `t_idx_archive`'s store.)

## Why prefix matching can't be made safe

The flat naming scheme provides no unambiguous delimiter between the table
segment and the index segment — any `_idx_` inside a table name is
indistinguishable from the index separator. Tightening the regex (anchoring,
escaping) does not help because the ambiguity is structural.

## Suggested direction (for the fix/plan stage to confirm)

Prefer an **authoritative index list over prefix scanning**: the caller
(`StoreModule.renameTable` / `dropTable`) knows the table's real index names from
the catalog/schema. Pass that list down to the provider (e.g.
`renameTableStores(schema, oldName, newName, indexNames)` /
`deleteTableStores(schema, tableName, indexNames)`) and have the provider build
exact store names via `buildIndexStoreName` rather than prefix-matching the live
store list. This removes the ambiguity entirely and keeps the providers dumb.

Alternative (more invasive): change the physical naming scheme to an
unambiguous encoding (length-prefixed or reserved-char-escaped segments) — larger
migration surface, not preferred.

## Scope / acceptance

- Rename and drop of a table named `t` must not touch any store belonging to a
  sibling table whose name starts with `t_idx_`.
- Fix applied to both IndexedDB and LevelDB providers (and the shared interface in
  `kv-store.ts` if the signature changes).
- Regression tests in both plugins: a `<table>` + `<table>_idx_<x>` sibling pair,
  asserting RENAME and DROP of `<table>` leave the sibling's stores and rows intact.
