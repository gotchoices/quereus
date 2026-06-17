description: Restructure the LevelDB storage backend so all of a database's tables and indexes live inside one physical LevelDB instead of a separate folder per table, enabling crash-safe single-commit writes on the durable (Node.js) backend.
prereq: store-atomic-batch-capability
files:
  - packages/quereus-plugin-leveldb/src/store.ts             # LevelDBStore → sublevel-backed KVStore
  - packages/quereus-plugin-leveldb/src/provider.ts          # one ClassicLevel root; sublevel lifecycle
  - packages/quereus-plugin-leveldb/package.json             # classic-level ^3.0.0 (sublevels)
  - packages/quereus-store/src/common/kv-store.ts            # AtomicBatch (from prereq)
difficulty: hard
----

# LevelDB shared-root layout + atomic batch

The LevelDB provider opens a **separate `ClassicLevel` database per
table/index** (`provider.ts` — `getOrCreateStore` opens `basePath/{schema}/{table}`
and `…/{table}_idx_{name}`). Separate physical databases cannot share a write
batch, so the atomic-commit capability from `store-atomic-batch-capability` is
impossible to implement on this backend as-is. This ticket restructures the
provider to a **single shared root** with one **sublevel per store**, then
implements `beginAtomicBatch` over the root's chained, cross-sublevel batch —
delivering the crash-safe single commit on the one backend where durability
actually matters.

`classic-level` is `^3.0.0` (abstract-level), which provides `db.sublevel(name)`
and a chained batch where each op targets a sublevel
(`root.batch().put(key, value, { sublevel }).del(key, { sublevel }).write()`,
or the array form `root.batch(ops)` with `sublevel` per op). All sublevels share
one physical store, so a single `write()` is atomic and durable across every
referenced sublevel.

## Layout

One `ClassicLevel` at `basePath` (the root). Each logical store becomes a
sublevel keyed by the **existing store name** so naming/sanitization rules are
unchanged from the caller's view:

| Logical store | Sublevel name |
|---|---|
| Table data | `{schema}.{table}` (via `buildDataStoreName`) |
| Secondary index | `{schema}.{table}_idx_{name}` (via `buildIndexStoreName`) |
| Unified stats | `STATS_STORE_NAME` (`__stats__`) |
| Catalog | `CATALOG_STORE_NAME` (`__catalog__`) |

`LevelDBStore` becomes a thin `KVStore` over `{ root, sublevel }`:
`get/put/delete/has/iterate/approximateCount/batch` all operate on the
sublevel; `close()` no longer closes a physical DB (it just drops the handle —
the root stays open until `closeAll`), mirroring how `IndexedDBStore.close()`
is a per-store no-op over the shared DB.

## Migration story

Per repo policy (AGENTS.md: "Don't worry about backwards compatibility yet"),
this is a **hard cutover** with **no on-disk migration**: the new layout is the
only LevelDB layout. Existing per-directory databases written by the old layout
are not read by the new code. Document this clearly in the LevelDB plugin README
and the plugin's changelog/notes; pre-1.0 dev data is expected to be
re-created. (If a migration importer is ever wanted, it is a separate backlog
item — do not build it here.)

## Lifecycle rewrite

Every provider method that currently maps a store to a **filesystem
directory** must map to a **sublevel** instead:

- `getStore`/`getIndexStore`/`getStatsStore`/`getCatalogStore` → open/cache a
  sublevel handle off the single root (the `storeOpening`/in-flight-open
  dedupe logic largely survives, but there is no per-store LevelDB `LOCK` to
  race anymore — the root holds the only lock).
- `closeStore`/`closeIndexStore`/`closeAll` → drop cached handles; `closeAll`
  closes the **root** (and flushes the clean-shutdown marker path as today).
- `deleteIndexStore`/`deleteTableStores` → **`sublevel.clear()`** over the
  store's keyspace instead of `fs.rm` of a directory. Preserve the
  exact-by-name contract (`indexNames` from the schema, never a `_idx_` prefix
  scan — see the `KVStoreProvider` doc comments and the LevelDB `deleteTableStores`
  guard, which exist precisely because `_idx_` is a legal identifier substring).
- `renameTableStores` → relocate keys between sublevels (read-and-rewrite under
  one batch, or sublevel copy+clear), keeping the up-front
  destination-collision check and the exact-by-name index handling that the
  current fs-rename path documents. A cross-sublevel rename within one root can
  and should be **atomic** via the chained batch.

## `beginAtomicBatch`

Implement on `LevelDBProvider`: return an `AtomicBatch` over `this.root`'s
chained batch. `put(store, …)`/`delete(store, …)` resolve `store` to its
sublevel (the handle carries it) and append a `{ sublevel }` op; `write()`
issues one `root.batch(...).write()`. Reuse `store-marker-sync-durability`'s
`sync` posture for the commit if a durable barrier is wanted on commit (commit
durability is otherwise LevelDB's default — confirm whether commit should pass
`{ sync: true }`; default classic-level batched writes are not synced, so for a
true crash-safe commit the batch `write()` SHOULD pass `{ sync: true }` —
decide and document the latency tradeoff).

With this in place, `TransactionCoordinator.commit()` (already wired in the
prereq) routes a LevelDB table's data + index ops through one atomic, durable
commit — closing the data/index divergence window on the durable backend.

## Edge cases & interactions

- **Root open/close races.** Concurrent `getOrCreateStore` for different
  sublevels must share the one root open (memoize the root open like the
  current `catalogStoreOpening`). `closeAll` must await in-flight opens before
  closing the root (as today) so a freshly opened sublevel/root isn't stranded.
- **`sublevel.clear()` scope.** `clear()` must affect only that sublevel's
  keyspace, never the root's other sublevels — verify abstract-level prefixes
  isolate it. A drop of table `t` must not touch a sibling sublevel literally
  named `t_idx_x` (the existing exact-by-name guard already prevents this; keep
  it).
- **Rename atomicity + handle invalidation.** After a rename, cached handles
  for the old sublevel names must be dropped so subsequent `getStore` opens the
  new sublevel (the current code drops handles before fs-rename; preserve the
  ordering). The key-relocation must be all-or-nothing.
- **Catalog/stats co-location.** Catalog and stats become sublevels of the same
  root. This means the clean-shutdown marker now lives in the **same atomic
  domain** as data — note this for the backlog `store-module-wide-atomic-commit`
  (it lets the marker delete be folded into a session's first commit, though the
  synced consume-delete from `store-marker-sync-durability` already suffices).
- **Iteration key encoding.** Sublevel iteration must still yield the raw stored
  keys/values the rest of the store package expects (`keyEncoding: 'view'`,
  `valueEncoding: 'view'`). Confirm sublevels inherit or are given the same
  encodings, and that `iterate` bounds (gte/gt/lte/lt) still work within a
  sublevel.
- **`approximateCount`.** Still O(n) scan within the sublevel (unchanged
  behavior); confirm it counts only the sublevel.
- **Empty / never-materialized store.** Opening a sublevel that has no keys yet
  must succeed (no directory-existence assumptions remain).
- **Store-mode test suite.** `yarn test:store` re-runs the engine logic tests
  against this backend — it is the primary regression gate for this restructure.

## TODO

- Rewrite `LevelDBStore` (`store.ts`) as a `KVStore` over `{ root, sublevel }`;
  per-store `close()` becomes a handle drop.
- Rewrite `LevelDBProvider` (`provider.ts`) to open one root and manage
  sublevel handles; convert `delete*`/`rename*` from fs ops to sublevel
  clear/relocate, preserving the exact-by-name index contracts and
  destination-collision guards.
- Implement `LevelDBProvider.beginAtomicBatch` over the root's chained batch;
  decide + document commit `{ sync }`.
- Update the LevelDB plugin README/notes: shared-root layout, hard cutover, no
  on-disk migration.
- `yarn test:store` (primary), `yarn test` (sanity), `yarn lint` in
  `packages/quereus`. Stream long runs with `tee` per AGENTS.md.
- If a store-mode failure is plainly pre-existing (broken before this diff),
  follow the pre-existing-error flag procedure rather than chasing it here.
