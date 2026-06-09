description: RENAME TABLE can produce a colliding *index* store name — renaming `t`→`newName` relocates each `t_idx_x` to `newName_idx_x`, which may already name another object's store (a sibling table `newName_idx_x` or another table's index). The CREATE-time collision guard only checks the new *data* store name, not the relocated index store names.
files:
  - packages/quereus-store/src/common/store-module.ts        # renameTable — extend the collision guard to relocated index names
  - packages/quereus-plugin-leveldb/src/provider.ts          # renameTableStores — already throws on destination-exists, but only per moved dir
  - packages/quereus-plugin-indexeddb/src/provider.ts        # renameTableStores — same
----

# RENAME producing a colliding index store name

The `store-index-vs-sibling-table-name-collision-at-create` fix rejects a CREATE whose
physical store name aliases an existing store, and extends that check to `renameTable`'s new
**data** store name (`{schema}.{newName}`). It does **not** cover the case where the *index*
stores relocated by the rename collide:

- Renaming `t` → `newName` moves each `t_idx_x` to `newName_idx_x`. If a sibling table is
  literally named `newName_idx_x` (its data store is `{schema}.newName_idx_x`), or another
  table already has an index whose store is `{schema}.newName_idx_x`, the relocation aliases
  that store.

The providers' `renameTableStores` each throw a low-level "destination already exists" error
per moved directory/object store, so this is *not* silent corruption today — but it surfaces
as a raw provider `Error` mid-rename (after some directories may already have moved),
leaving the rename partially applied rather than a clean, atomic, sited pre-check reject.

## Expected behavior

`renameTable` should pre-compute **all** new physical store names it is about to introduce
(the new data store name *and* every relocated index store name), check them against the
occupied-name set (reusing the helper from the CREATE-collision fix), and reject atomically
with a clear `StatusCode.ERROR` **before** any physical relocation — so a colliding rename
is a no-op, not a half-moved table.

## Notes / scope

- Reuse `collectOccupiedStoreNames` from the CREATE fix; exclude the table being renamed
  (its own current data/index stores are the *sources*, not collisions).
- Add regression coverage for: (a) rename into a sibling whose name equals a would-be index
  store name; (b) the partial-move atomicity (no directory/object store moved on reject).
- Lower priority than the CREATE collision (rename into a colliding index name is rarer and
  currently fails loud-but-messy rather than silently corrupting).
