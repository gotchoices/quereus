description: Give the store a per-column PRIMARY KEY key collation plus an ALTER-time physical re-encode + duplicate scan, so it honors ANY divergent PK `SET COLLATE` the way the memory module does (original "Option B").
files: packages/quereus-store/src/common/store-module.ts, packages/quereus-store/src/common/store-table.ts, packages/quereus-store/src/common/key-builder.ts
----

## Background

`store-pk-collate-module-capability` resolved the store's PK-column `SET COLLATE` to
**accept-when-consistent / reject-when-divergent**, because the store enforces PK uniqueness
*physically* under a single fixed table-level key collation K (`config.collation`,
`StoreTable.encodeOptions`). A divergent PK collation is rejected with `UNSUPPORTED` rather than
silently applied. This ticket is the original "Option B" that was parked: make the store honor
*any* PK collation change by physically re-keying, reaching full parity with the memory module.

## Goal

Replace the single fixed table-level key collation with a **per-PK-column key collation**, and
on a PK-column `SET COLLATE`:

1. Re-encode every data-store key (and every secondary-index key, whose bytes embed the PK
   suffix) under the new per-column collation — mirroring the existing `alterPrimaryKey`
   re-key path (`table.rekeyRows` + index clear/rebuild).
2. Reject with `CONSTRAINT` (before mutating) if two rows that were distinct under the old key
   collation collide under the new one — all-or-nothing, like `rekeyRows` today.
3. Persist the per-column key collation in the catalog DDL so it survives close → reopen.

After this, the engine-side `module.ts` `setCollation` "re-key / re-validate the PK" mandate is
satisfied natively and the `UNSUPPORTED` reject (and the `store-pk-collate-logical-enforce`
write-time scan) are no longer needed.

## Cost / why deferred

This is an **on-disk key-format change**: the PK key encoding stops being a single fixed
table collation and becomes per-column. Existing LevelDB/IndexedDB stores written under the old
format need a migration (or a versioned key encoder that can read old keys and re-encode on
first write). That migration burden — across every store-backed plugin (leveldb, indexeddb,
react-native-leveldb, nativescript) — is why this is parked behind the cheap reject.

## Test expectations

- A default `NOCASE`-keyed store PK column honors `SET COLLATE binary` (the case the
  module-capability ticket rejects with `UNSUPPORTED`): existing rows re-key under BINARY, a
  case-distinct pair now coexists, and PK ordering/uniqueness follow BINARY.
- A re-key that would collide under the new collation rejects with `CONSTRAINT`, store
  unchanged (mirrors `alterPrimaryKey` dup handling).
- Secondary indexes survive the re-key (keys rebuilt against the re-encoded data store).
- The per-column PK key collation round-trips through catalog close → reopen.
- The 41.7.1 memory-only `'a'`/`'A'` PK re-key collision fixture becomes runnable cross-module
  (the store can now hold/re-key it), so it migrates out of `MEMORY_ONLY_FILES`.
