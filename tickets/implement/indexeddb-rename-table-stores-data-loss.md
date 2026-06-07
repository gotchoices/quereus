description: Implement `renameTableStores` on the IndexedDB provider so `ALTER TABLE … RENAME TO` relocates the table's data object store and every secondary-index object store. Object stores can't be renamed in place, so add an atomic copy-then-delete inside a single IndexedDB version-upgrade (`versionchange`) transaction. Without this, a renamed table rehydrates from the catalog under the new name but its backing stores stay under the old name — silent data loss.
files:
  - packages/quereus-plugin-indexeddb/src/manager.ts            # add renameObjectStores(renames) — atomic versionchange copy+delete
  - packages/quereus-plugin-indexeddb/src/provider.ts           # add renameTableStores; build rename list, collision-guard, evict cached handles
  - packages/quereus-plugin-indexeddb/src/store.ts              # reference: how data/cursor copy works within a transaction
  - packages/quereus-plugin-indexeddb/test/rename-persistence.spec.ts   # NEW integration test (fake-indexeddb + StoreModule + Database)
  - packages/quereus-plugin-leveldb/src/provider.ts             # reference semantics (close handles, move data + each index dir, collision guard)
  - packages/quereus-store/src/common/store-module.ts           # renameTable: guards `if (provider.renameTableStores)` then rewrites catalog
  - packages/quereus-store/src/common/key-builder.ts            # buildDataStoreName / buildIndexStoreName / STORE_SUFFIX.INDEX ('_idx_')
  - packages/quereus-store/test/index-persistence.spec.ts       # in-memory `RENAME TABLE then reopen` test to mirror
----

# Implement IndexedDB `renameTableStores`

## Problem recap

`StoreModule.renameTable` (`packages/quereus-store/src/common/store-module.ts:~1199`)
relocates physical storage only when the provider implements the optional
`renameTableStores` hook, then unconditionally rewrites the catalog under the new
name. The IndexedDB provider does **not** implement the hook, so a `RENAME TABLE`
on the indexeddb backend rewrites the catalog (table + bundled index DDL) under
`{schema}.{newName}` but leaves the physical object stores under the old name.
On reopen, `getStore`/`getIndexStore(newName, …)` create *fresh empty* object
stores; the original rows and index entries are orphaned and unreachable —
silent data loss.

LevelDB's `renameTableStores` (`packages/quereus-plugin-leveldb/src/provider.ts:162`)
is the behavioral reference: close all open handles for the old data + index
stores, then move the data directory and each `…_idx_*` directory under the new
name, failing loudly on a destination collision.

## Why IndexedDB needs a different mechanism

IndexedDB object-store names are fixed at creation — they can only be created or
deleted inside an `onupgradeneeded` (versionchange) transaction, never renamed.
The unified-database architecture (`manager.ts`) gives us exactly one
versionchange transaction that **spans all object stores at once**, which is the
tool for an atomic relocation:

```
within onupgradeneeded (versionchange tx covers every store):
  for each {from → to}:
    createObjectStore(to)
    copy every entry from `from` to `to` via a cursor   // reads + writes on the same tx
    deleteObjectStore(from)                              // only after its cursor is exhausted
  // tx auto-commits when no requests remain → atomic at the version bump
```

Because schema ops (`createObjectStore`/`deleteObjectStore`) and the cursor
copy all ride one versionchange transaction, the rename is all-or-nothing: any
error aborts the transaction and the database is left exactly as before (old
stores intact, new stores never created). This matters because
`StoreModule.renameTable` calls `renameTableStores` **before** it rewrites the
catalog — so a thrown/aborted rename leaves the table fully addressable under
its old name, never half-migrated.

Decision: implement the **single-versionchange copy-then-delete** approach
above. (A 2-bump variant — create+copy in one bump, delete-old in a second — is
simpler to drive but is not atomic across the bumps and can orphan the new
stores on a crash between them. Only fall back to it if fake-indexeddb proves
unable to drive a cursor copy inside `onupgradeneeded`; the canonical IDB spec
and fake-indexeddb both support it, so this should not be needed.)

## Design

### `IndexedDBManager.renameObjectStores(renames)`

New method on `packages/quereus-plugin-indexeddb/src/manager.ts`, modeled on the
existing `doUpgrade` / `doDeleteObjectStore` pattern (close current db → bump
`dbVersion` → reopen → mutate in `onupgradeneeded` → rebuild `this.objectStores`
in `onsuccess`).

```ts
async renameObjectStores(renames: Array<{ from: string; to: string }>): Promise<void>
```

- Await any in-flight `upgradePromise`; `await ensureOpen()`.
- Filter `renames` to entries whose `from` is in `this.objectStores`; if none
  remain, return (nothing physical to move — mirrors LevelDB's `pathExists`
  guard for a never-materialized store).
- **Pre-bump collision guard**: if any surviving `to` is already in
  `this.objectStores`, throw before bumping the version (no partial mutation):
  `Cannot rename …: object store '<to>' already exists`.
- Serialize via `this.upgradePromise = this.doRenameObjectStores(filtered)` with
  the same `try { await } finally { this.upgradePromise = null }` wrapper used by
  `ensureObjectStore` / `deleteObjectStore`.

`doRenameObjectStores(renames)` (the versionchange body):

- `this.db?.close(); this.db = null; this.dbVersion++;` then `indexedDB.open(name, version)`.
- 10s timeout + `onerror` + `onblocked` (warn-and-wait) consistent with the other
  upgrade helpers.
- `onupgradeneeded`: grab `const tx = (event.target as IDBOpenDBRequest).transaction!`
  (the versionchange tx). Drive the renames **sequentially** with a
  cursor-chained driver so a request is always pending (keeps the tx alive until
  the copy completes):
  - For each `{from, to}`: `db.createObjectStore(to)`, then `tx.objectStore(from).openCursor()`;
    in `cursor.onsuccess`, if `cursor` → `tx.objectStore(to).put(cursor.value, cursor.key)`
    then `cursor.continue()`; when `cursor` is null → `db.deleteObjectStore(from)`
    and advance to the next rename. After the last rename, stop (no more pending
    requests → tx commits).
  - On any request error, capture it and `tx.abort()`.
- `onsuccess`: install `db.onversionchange = () => { db.close(); this.db = null; }`,
  rebuild `this.objectStores` from `db.objectStoreNames`, `clearTimeout`, resolve.
  Reject on `onerror` (carrying any captured copy error so the caller sees a real
  message, not a bare AbortError).

Note: `put(value, key)` (out-of-line keys) matches how `IndexedDBStore`/`store.ts`
writes — keys are `ArrayBuffer`, values are `ArrayBuffer`; copying `cursor.value`
with `cursor.key` round-trips them verbatim.

### `IndexedDBProvider.renameTableStores(schemaName, oldName, newName)`

New method on `packages/quereus-plugin-indexeddb/src/provider.ts`, mirroring the
LevelDB shape and reusing `buildDataStoreName` / `buildIndexStoreName` /
`STORE_SUFFIX.INDEX`:

- `oldData = buildDataStoreName(schema, oldName)`, `newData = buildDataStoreName(schema, newName)`.
- Collision guard up front: if `this.manager.hasObjectStore(newData)` → throw
  (matches LevelDB's "destination already exists").
- Build the rename list from **actual** object stores
  (`this.manager.getObjectStoreNames()`):
  - data: `{ from: oldData, to: newData }` (only if `hasObjectStore(oldData)`).
  - indexes: for every store name starting with `${oldData}${STORE_SUFFIX.INDEX}`,
    extract the index name = `name.substring((oldData + STORE_SUFFIX.INDEX).length)`
    and target `buildIndexStoreName(schema, newName, indexName)`. Guard each
    target against an existing store (throw on collision).
- **Evict cached handles** for every `from` name via `closeStoreByName` (drops the
  `stores` map entry + any `CachedKVStore`) so a later `getStore(newName)` /
  `getStore(oldName)` opens fresh against the relocated store. Do this *before*
  `renameObjectStores` so no stale `IndexedDBStore` points at a deleted store.
- Call `this.manager.renameObjectStores(renameList)`.
- Do **not** touch `__stats__`: it's the unified stats store, and
  `StoreModule.renameTable` already deletes the old `{schema}.{oldName}` stats key
  itself (see `buildStatsKey` usage in store-module). LevelDB's
  `renameTableStores` likewise ignores stats.

### `deleteTableStores` (verify only — already correct)

`provider.ts:133-154` already closes the data store and sweeps every
`${dataStoreName}${STORE_SUFFIX.INDEX}*` object store on DROP TABLE. No change
needed; the new test should still assert it (DROP TABLE tears down index stores)
so the guarantee is pinned.

## Edge cases & interactions

- **No physical store yet**: table created/declared but never connected → its
  data object store may not exist. Skip absent `from` entries; never error. If
  nothing is left to move, `renameObjectStores` is a no-op and the catalog
  rewrite still proceeds (parity with LevelDB's `pathExists` guard).
- **Empty table**: data store exists but holds zero rows → new store created
  empty, old deleted; cursor copy yields nothing. Must succeed.
- **Multiple secondary indexes**: every `…_idx_*` store must move; assert ≥2
  indexes in the test, including one `UNIQUE`-derived index.
- **Destination collision**: `newName`'s data store (or any target index store)
  already exists → throw *before* the version bump; the DB must be left
  byte-for-byte unchanged (no created/copied/deleted stores). Add a test that a
  failed rename leaves the original table fully readable.
- **Partial-failure atomicity**: a copy error mid-relocation must `tx.abort()` so
  neither the new stores nor the deletions persist. Because `renameTableStores`
  runs before the catalog rewrite in `store-module.ts`, a rejected rename leaves
  the table addressable under the old name (no data loss). Surface a meaningful
  error message, not a bare AbortError.
- **Stale `objectStores` set**: after a successful rename, `this.objectStores`
  must reflect the new names (rebuilt in `onsuccess`) so subsequent
  `hasObjectStore` / `deleteTableStores` see the renamed stores, not ghosts of
  the old names.
- **Cached `CachedKVStore` handles**: an open cached handle under the old name
  must be evicted, else it serves rows from a deleted object store or throws
  "Store is closed". Covered by `closeStoreByName` before the upgrade.
- **Concurrent transactions / blocked upgrade**: the version bump closes the
  current connection and reopens. `StoreModule.renameTable` already flushes the
  coordinator (`commit()`) and `disconnect()`s the cached handle *before* calling
  `renameTableStores`, so no live table transaction should straddle the rename.
  Keep the `onblocked` warn-and-wait + `onversionchange` self-close handlers so a
  second tab/connection releases the lock (multi-tab is out of scope to test but
  must not deadlock the single-connection path).
- **`__stats__` untouched by the provider**: confirm the provider does not move or
  delete the unified stats store; store-module owns the stats-key relocation.
- **Round-trip / reopen**: after rename + `closeAll()` + fresh provider over the
  same `databaseName` (fake-indexeddb persists for the process), `getStore(newName)`
  must read the original rows and `getIndexStore(newName, ix)` the original index
  entries.

## Test plan

New `packages/quereus-plugin-indexeddb/test/rename-persistence.spec.ts`,
mirroring `packages/quereus-store/test/index-persistence.spec.ts`'s
`RENAME TABLE then reopen` case but wiring the **real** `IndexedDBProvider` over
`fake-indexeddb/auto` with a real `Database` + `StoreModule`. The package already
depends on `@quereus/quereus`, `@quereus/store`, and `fake-indexeddb` (see
`package.json`), and its `test` script globs `test/**/*.spec.ts`.

Harness (follow `manager.spec.ts` for fake-indexeddb setup + `afterEach`
`IndexedDBManager.resetInstance` + `indexedDB.deleteDatabase`):
- `open()`: `new Database()`, `new StoreModule(createIndexedDBProvider({ databaseName }))`,
  `db.registerModule('store', mod)`.
- `reopen()`: fresh `Database` + `StoreModule` over a provider with the **same**
  `databaseName`, then `await mod.rehydrateCatalog(db)` (assert zero errors).
- Between phases: `await mod.closeAll()` (and reset the manager singleton if the
  provider holds one per databaseName — check whether a new provider re-fetches
  the singleton via `IndexedDBManager.getInstance`; if so, `resetInstance` in the
  helper so reopen rebuilds from persisted IDB rather than stale in-memory state).

Key cases (expected outputs):
- **rename preserves data + index across reopen**: `create table t(id integer primary key, b integer) using store`,
  `create index ix_b on t(b)`, insert `(1,10),(2,20)`, `alter table t rename to t2`,
  `closeAll()`, reopen. Assert: `index_info(t2)` includes `ix_b`; `select id from t2 where b=20` → `[{id:2}]`
  (proves the index store moved and is used); old catalog entry for `t` is gone;
  `t` not in schema. Mirrors the in-memory assertion.
- **multiple indexes incl. UNIQUE**: a table with a `UNIQUE` constraint + a second
  `CREATE INDEX`; after rename+reopen both index stores carry their original
  entries (query through each).
- **destination collision throws and is non-destructive**: pre-create `t2`,
  attempt `alter table t rename to t2`, expect rejection, then assert `t` still
  returns all original rows (no partial migration).
- **DROP TABLE tears down index stores** (pin existing `deleteTableStores`): after
  `drop table t`, `manager.getObjectStoreNames()` contains neither the data store
  nor any `…_idx_*` store for `t`.

Run: `yarn workspace @quereus/plugin-indexeddb test` (and a full `yarn test` /
`yarn build` to confirm no regressions; `yarn lint` only exists in
`packages/quereus`).

## TODO

- Add `renameObjectStores(renames)` to `IndexedDBManager` (`manager.ts`):
  pre-open collision guard, `doRenameObjectStores` versionchange body with
  sequential cursor-chained copy + `deleteObjectStore`, `tx.abort()` on copy
  error, rebuild `this.objectStores` in `onsuccess`, reuse the 10s-timeout /
  `onblocked` / `onversionchange` boilerplate.
- Add `renameTableStores(schema, oldName, newName)` to `IndexedDBProvider`
  (`provider.ts`): up-front data-store collision guard, build the data+index
  rename list from `getObjectStoreNames()` with per-index collision guards,
  evict cached handles via `closeStoreByName`, delegate to
  `manager.renameObjectStores`. Leave `__stats__` alone.
- Confirm `deleteTableStores` already sweeps `…_idx_*` (it does) — no change, but
  cover it in the new test.
- Write `test/rename-persistence.spec.ts` per the test plan above.
- `yarn workspace @quereus/plugin-indexeddb test`, then `yarn build` + `yarn test`
  to confirm no regressions. Stream long output with `Tee-Object`/`tee` + a
  follow-up `tail` per AGENTS.md.
- Update the storage-naming/lifecycle docs if any describe rename teardown
  (search `docs/` and the indexeddb README for `renameTableStores` / RENAME).
