description: Review the IndexedDB provider's new `renameTableStores` hook (+ `IndexedDBManager.renameObjectStores`) that relocates a table's data + secondary-index object stores during `ALTER TABLE … RENAME TO` via an atomic copy-then-delete inside a single versionchange transaction. Closes a silent-data-loss gap where a renamed indexeddb-backed table rehydrated empty under the new name while its rows/index entries stayed orphaned under the old name.
files:
  - packages/quereus-plugin-indexeddb/src/manager.ts                    # NEW renameObjectStores + doRenameObjectStores (versionchange copy/delete)
  - packages/quereus-plugin-indexeddb/src/provider.ts                   # NEW renameTableStores (collision guard, rename-list build, evict handles)
  - packages/quereus-plugin-indexeddb/test/rename-persistence.spec.ts   # NEW integration tests (fake-indexeddb + Database + StoreModule)
  - packages/quereus-plugin-leveldb/src/provider.ts                     # reference semantics (close handles, move data + index dirs, collision guard)
  - packages/quereus-store/src/common/store-module.ts                   # renameTable: calls renameTableStores BEFORE rewriting catalog
  - packages/quereus-store/src/common/kv-store.ts                       # renameTableStores? contract JSDoc (line ~209)
  - packages/quereus-store/src/common/key-builder.ts                    # buildDataStoreName / buildIndexStoreName / STORE_SUFFIX.INDEX
----

# Review: IndexedDB `renameTableStores`

## What changed

IndexedDB object stores cannot be renamed in place — they can only be created or
deleted inside an `onupgradeneeded` (versionchange) transaction. The fix relocates
a table's backing stores via an **atomic copy-then-delete inside one versionchange
transaction**, so a rename is all-or-nothing.

**`IndexedDBManager.renameObjectStores(renames: Array<{from,to}>)`** (`manager.ts`,
added between `doDeleteObjectStore` and `hasObjectStore`):
- Awaits any in-flight `upgradePromise`, then `ensureOpen()`.
- Filters out renames whose `from` store never materialized (a declared-but-never-
  connected table has no backing store — mirrors LevelDB's `pathExists` guard).
  Returns early if nothing is left to move.
- **Pre-bump collision guard**: throws if any surviving `to` already exists, *before*
  bumping the version (no partial mutation possible).
- Serializes `doRenameObjectStores` via the same `upgradePromise` try/finally wrapper
  used by `ensureObjectStore` / `deleteObjectStore`.
- `doRenameObjectStores`: closes the connection, `dbVersion++`, reopens. In
  `onupgradeneeded` a **cursor-chained sequential driver** keeps a request pending so
  the tx stays alive: for each `{from,to}` it `createObjectStore(to)`, cursor-copies
  every entry (`put(cursor.value, cursor.key)` — verbatim ArrayBuffer key+value), then
  `deleteObjectStore(from)` and advances. On any cursor error it captures the error and
  `tx.abort()`s; `tx.onabort` also captures `tx.error`. `onsuccess` rebuilds
  `this.objectStores` from the live DB and reinstalls `onversionchange`. `onerror`
  rejects with the captured copy/abort error (not a bare AbortError). Reuses the 10s
  timeout + `onblocked` warn-and-wait boilerplate.

**`IndexedDBProvider.renameTableStores(schema, oldName, newName)`** (`provider.ts`,
added before `deleteTableStores`):
- Up-front data-store collision guard (`hasObjectStore(newData)` → throw), mirroring
  LevelDB's "destination already exists".
- Builds the rename list from **actual** object stores: the data store (if it exists)
  plus every `…_idx_*` store under the old name, extracting the index name via
  `substring` and re-targeting with `buildIndexStoreName(schema, newName, indexName)`;
  throws on a per-index target collision.
- **Evicts cached handles** (`closeStoreByName`) for every `from` store *before* the
  relocation so no stale `IndexedDBStore`/`CachedKVStore` points at a deleted store.
- Delegates to `manager.renameObjectStores`. Leaves `__stats__` untouched —
  `StoreModule.renameTable` relocates the stats key itself.

## Why it's safe (ordering)

`StoreModule.renameTable` calls `renameTableStores` **before** rewriting the catalog
(`store-module.ts:~1200`). So a thrown/aborted rename leaves the table fully
addressable under its old name (catalog never touched) — no half-migrated state.

## Validation done

- `yarn workspace @quereus/plugin-indexeddb test` → **56 passing** (5 new).
- `yarn build` → clean (exit 0). Plugin `typecheck` → clean (exit 0).
- `yarn test` (full monorepo) → all workspaces passing, **0 failures** (5197 quereus +
  56 indexeddb + others). The `[Sync] Error handling …` stack traces in the
  quereus-sync suite are intentionally-injected fixture failures (163 passing) and are
  unrelated to this change.

New tests in `test/rename-persistence.spec.ts` (real `IndexedDBProvider` over
`fake-indexeddb/auto` + real `Database` + non-isolated `StoreModule`, with `open()` /
`reopen()` helpers; reopen builds a fresh provider over the same `databaseName` — the
manager singleton was removed by `closeAll()`, so it rebuilds from persisted IDB):

1. **rename preserves data + index across reopen; old name fully gone** — create
   table + `ix_b`, insert 2 rows, `rename to t2`. Asserts the *same-session* read
   `select id from t2 where b=20` works (live relocation), then after reopen: index
   present in `index_info(t2)`, index-backed + full-scan reads return original rows,
   old name absent from schema, old data/index object stores gone, new ones present.
2. **multiple secondary indexes (incl. UNIQUE)** — `unique index uq_email` + plain
   `index ix_n`; after rename+reopen both index stores moved (asserted by name),
   queries through each return original rows, the UNIQUE index still rejects a
   duplicate and still indexes a fresh insert.
3. **empty table relocates** — materialize then empty the table; rename+reopen yields
   the data store under the new name (old gone), zero rows, and still accepts/indexes
   new inserts.
4. **destination collision is non-destructive** — drives `provider.renameTableStores`
   **directly** (the SQL path is short-circuited by StoreModule's own `tables.has(newKey)`
   guard, so a direct call is the only way to reach the provider's guard) with a manually
   pre-created colliding `main.t2` store; asserts rejection, source data+index stores
   intact, no partial `main.t2_idx_ix_b`, and original rows still readable under `t`.
5. **DROP TABLE tears down data + every index store** — pins the pre-existing
   `deleteTableStores` sweep (data store + both `…_idx_*` stores gone after `drop`).

## Known gaps / where to look hard (reviewer: treat tests as a floor)

- **Mid-copy abort path is NOT directly tested.** The `tx.abort()`-on-copy-error branch
  and the "surface a real error, not a bare AbortError" handling are verified by
  inspection only — fake-indexeddb gives no easy hook to fail a cursor/`put` mid-
  versionchange. The *tested* non-destructive guarantee is the pre-bump collision
  guard (throws before any mutation). Consider whether a fault-injection seam is worth
  adding, or whether inspection is sufficient.
- **`dbVersion` staleness after an aborted upgrade.** If `doRenameObjectStores` aborts
  mid-copy, `this.dbVersion` was incremented in memory but the on-disk version reverts,
  leaving them out of sync by 1. This self-heals: the abort leaves `this.db === null`,
  so the next `ensureOpen()` → `doOpen()` re-reads the real version via
  `getExistingDatabaseInfo()`. Worth confirming this reasoning holds and that no path
  reuses the stale `dbVersion` before a `doOpen()`. (The collision-guard path never
  bumps the version, so it's unaffected.)
- **Multi-tab / concurrent connections untested.** `onblocked` warn-and-wait +
  `onversionchange` self-close handlers are present (copied from the existing upgrade
  helpers) but multi-tab is out of scope for fake-indexeddb; only the single-connection
  path is exercised. Confirm the rename can't deadlock a second live connection.
- **fake-indexeddb vs real browsers.** Cursor-copy inside `onupgradeneeded` works under
  fake-indexeddb and is per-spec, but is not validated against Chrome/Firefox/Safari IDB
  engines in CI.
- **`__stats__` relocation** is owned by `StoreModule.renameTable` (deletes the old key);
  the provider deliberately ignores it. Not separately asserted beyond the rename
  succeeding — confirm the stats key handoff is correct if you want it pinned.
- **Docs**: no existing README/docs section describes indexeddb DROP/RENAME store
  teardown (the analogous `deleteTableStores` is also undocumented), so none was added —
  the contract lives in the `renameTableStores?` JSDoc in `kv-store.ts`. Flag if a
  lifecycle doc section is wanted.

## Suggested reviewer focus

- The cursor-chained driver in `doRenameObjectStores`: is a request *always* pending
  between renames so the versionchange tx can't auto-commit early? (Empty-source store
  → single `onsuccess(cursor=null)`; does the chain still advance correctly?)
- Eviction-before-relocation ordering in `provider.renameTableStores` vs. the post-
  rename `getStore(newName)` reopening a fresh handle against the relocated store.
- Collision-guard completeness: data store, each index target, and the StoreModule-level
  pre-check — any path that reaches a destructive op before a guard?
