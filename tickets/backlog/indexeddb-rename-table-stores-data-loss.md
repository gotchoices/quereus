description: The IndexedDB store provider does not implement `renameTableStores`, so `ALTER TABLE … RENAME TO` rewrites the catalog under the new name but leaves the physical data + index object stores under the old name — on reopen the table and its indexes exist in the catalog but their backing stores are empty/orphaned (data loss). LevelDB implements this correctly; the in-memory test provider does too.
files:
  - packages/quereus-plugin-indexeddb/src/provider.ts          # add renameTableStores (and verify deleteTableStores covers index prefix)
  - packages/quereus-plugin-leveldb/src/provider.ts            # reference implementation (closes handles, moves data dir + each index dir)
  - packages/quereus-store/src/common/store-module.ts          # renameTable: guards `if (this.provider.renameTableStores)` then rewrites catalog under new name
  - packages/quereus-store/src/common/kv-store.ts              # KVStoreProvider.renameTableStores? optional member
----

# IndexedDB RENAME TABLE loses physical data + index stores

## Problem

`StoreModule.renameTable` (packages/quereus-store/src/common/store-module.ts)
moves the physical storage only when the provider implements the optional
`renameTableStores` hook:

```ts
if (this.provider.renameTableStores) {
  await this.provider.renameTableStores(schemaName, oldName, newName);
}
// ... then unconditionally rewrites the persistent catalog under the new name
```

The **IndexedDB** provider (`packages/quereus-plugin-indexeddb/src/provider.ts`)
does **not** implement `renameTableStores` (it implements `getStore`,
`getIndexStore`, `deleteTableStores`, `deleteIndexStore`, `closeIndexStore`, but
not rename). So on the indexeddb backend a `RENAME TABLE`:

1. Rewrites the catalog entry (table DDL + bundled index DDL) under
   `{schema}.{newName}`, removing the `{schema}.{oldName}` entry.
2. **Does not** relocate the underlying object stores — data lives under the old
   store name, indexes under `{schema}.{oldName}_idx_*`.

Result on reopen: the table and its indexes rehydrate from the catalog under the
new name, but `getStore` / `getIndexStore(newName, …)` open *fresh, empty* object
stores. The rows and index entries under the old name are orphaned and
unreachable — silent data loss.

## Scope / history

This is **pre-existing** for table data (the data directory was already not moved
on indexeddb before secondary-index persistence landed). The
`store-secondary-index-persistence` work widened the observable surface: the
catalog now also carries index DDL, so a renamed table additionally rehydrates
indexes whose backing stores are orphaned. The bug is in the provider, not in the
bundle logic.

LevelDB's `renameTableStores`
(`packages/quereus-plugin-leveldb/src/provider.ts:162`) is the reference: it
closes the data handle and every open `…_idx_*` handle (releasing file locks),
then moves the data directory and each index directory, guarding against a
collision under the new name.

## Expected behavior

`ALTER TABLE t RENAME TO t2` on the IndexedDB backend must relocate the table's
data **and** every secondary-index object store so that, after reopen, `t2` and
its indexes are backed by the original rows/entries (no orphaned stores, no data
loss). Mirror the LevelDB semantics:

- Close any open handles for the old data store and each `…_idx_*` store first.
- Move/rename the data object store and every index object store from the old
  name to the new name.
- Fail loudly if a store already exists under the new name (don't silently
  clobber).

If IndexedDB object stores cannot be renamed in place (they generally can't —
`IDBDatabase` object-store names are fixed at `upgradeneeded`), the
implementation will need a copy-then-delete within a version upgrade
transaction, or whatever relocation strategy the provider's keying scheme
allows. Brainstorm the right approach with the maintainer rather than forcing a
half-baked rename.

## Notes

- While here, confirm `deleteTableStores` on the indexeddb provider also tears
  down index object stores by prefix (LevelDB and the in-memory test provider
  delete `{schema}.{table}_idx_*`); a parallel gap there would leak index stores
  on DROP TABLE.
- Add an indexeddb-backed (or fake-indexeddb) test asserting data + index rows
  survive a RENAME across reopen, analogous to the in-memory
  `RENAME TABLE then reopen` case in
  `packages/quereus-store/test/index-persistence.spec.ts`.
