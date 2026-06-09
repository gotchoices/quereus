description: `IndexedDBProvider.invalidateCache` still prefix-scans `{table}_idx_`, so a cross-tab data-change for table `t` also clears the read cache of a sibling table literally named `t_idx_<x>`. Non-destructive (over-invalidation only), but it is the last residual instance of the store-name prefix-collision anti-pattern.
files:
  - packages/quereus-plugin-indexeddb/src/provider.ts   # invalidateCache (~207); CachedKVStore.invalidateAll
  - packages/quereus-plugin-indexeddb/src/broadcast.ts   # sole caller (~118), only has {schemaName, tableName}
----

> **Triage (2026-06-08): subsumed by `store-index-vs-sibling-table-name-collision-at-create`
> if that ticket adopts the unambiguous store-name *encoding* direction** — encoding removes
> the `_idx_` substring ambiguity everywhere, this site included. Do not work this independently
> until that ticket's direction is chosen: if it instead picks CREATE-time collision *detection*,
> this benign over-invalidation survives and becomes a standalone fix at that point.

# IndexedDB cross-tab cache invalidation collides on `{table}_idx_` prefix

## Context

The store-name prefix-collision fix (`store-name-prefix-collision-sibling-tables`)
replaced prefix-scan index discovery with an authoritative index-name list for the
**destructive** paths (`renameTableStores` / `deleteTableStores`). One non-destructive
site was left untouched:

```ts
// packages/quereus-plugin-indexeddb/src/provider.ts
invalidateCache(schemaName: string, tableName: string): void {
  const dataStoreName = buildDataStoreName(schemaName, tableName);
  const indexPrefix = `${dataStoreName}${STORE_SUFFIX.INDEX}`;
  for (const [name, store] of this.stores) {
    if ((name === dataStoreName || name.startsWith(indexPrefix)) && store instanceof CachedKVStore) {
      store.invalidateAll();
    }
  }
}
```

Because `_idx_` is a legal substring of an ordinary identifier, a cross-tab data-change
broadcast for table `t` also matches a sibling table literally named `t_idx_archive`
(store `main.t_idx_archive`) and clears its `CachedKVStore`.

## Severity

Low. Unlike the rename/drop bug, this is **non-destructive** — it only clears a read
cache that didn't need clearing, costing the sibling one extra re-read from IndexedDB.
No data is moved, deleted, or returned incorrectly. Filed as backlog rather than fixed
inline because the consequence is benign and a correct fix is not a one-liner (see below).

## Why it wasn't fixed inline

`invalidateCache` is called only from `broadcast.ts:handleMessage`, which receives a
cross-tab `data-change` message carrying just `{ schemaName, tableName }` — no index
list. The provider itself holds only store *names*, not the schema, so it cannot tell a
real index store apart from a sibling without additional information. A correct fix needs
one of:

- carry the table's index names in the broadcast message payload, or
- have the provider resolve the schema (it currently has no handle to it), or
- a store-name encoding that makes `_idx_` unambiguous (relates to the CREATE-time
  collision ticket).

## Acceptance

- A cross-tab data-change for `t` does not invalidate the cache of a sibling table named
  `t_idx_<x>`; `t`'s real index caches are still invalidated.
- Add a regression test exercising `invalidateCache('main','t')` with both `t`'s real
  index store and a `main.t_idx_<x>` sibling store cached, asserting only the former is
  cleared.
