description: Fixed `IndexedDBProvider.invalidateCache`'s `{table}_idx_` prefix-scan, the last residual store-name prefix-collision anti-pattern. The provider now tracks each table's own index store names (registered as index stores are opened via `getIndexStore`) and clears exactly the table's data + index caches, so a cross-tab data-change for `t` no longer over-invalidates the read cache of a sibling table literally named `t_idx_<x>`.
files:
  - packages/quereus-plugin-indexeddb/src/provider.ts            # indexStoresByTable map; getIndexStore registers; invalidateCache + invalidateStore; teardown cleanup in deleteIndexStore/renameTableStores/deleteTableStores/closeAll; STORE_SUFFIX import removed
  - packages/quereus-plugin-indexeddb/test/invalidate-cache.spec.ts  # NEW regression spec (3 tests)
  - packages/quereus-plugin-indexeddb/src/broadcast.ts           # sole caller, UNCHANGED (signature unchanged)
----

# Review: IndexedDB invalidateCache prefix-collision fix

## Triage resolution (why this was worked now)

The source ticket's triage note said: work this only once
`store-index-vs-sibling-table-name-collision-at-create` chose its direction —
**encoding** would subsume this site, **detection** would leave it as a standalone
fix. That ticket completed choosing **CREATE-time collision detection**
(`tickets/complete/2-store-index-vs-sibling-table-name-collision-at-create.md`), so
this benign over-invalidation survives and is a legitimate standalone fix. Confirmed
the bug is still reachable under detection: detection only rejects when *physical
store names* collide, so table `t` (with, say, index `ix_b`) and a sibling table
`t_idx_archive` (data store `main.t_idx_archive`) coexist fine — yet `main.t_idx_archive`
matches the old `main.t_idx_` prefix scan and got its cache wrongly cleared.

## What shipped

`invalidateCache(schema, table)` is called cross-tab from `broadcast.ts:handleMessage`,
which carries only `{schemaName, tableName}` — no index list — and the provider holds
only physical store *names*, which cannot distinguish a real index store of `t`
(`main.t_idx_<index>`) from a sibling table `t_idx_<x>` (`main.t_idx_<x>`) by string
alone. Both share the `main.t_idx_` prefix; that ambiguity is the whole bug.

Fix is self-contained in the IndexedDB plugin (no `@quereus/store` event-type changes,
no per-write overhead, no provider→schema coupling):

- New `private indexStoresByTable = Map<dataStoreName, Set<indexStoreName>>`. The
  provider already knows the authoritative `(schema, table, index) → physical name`
  mapping at `getIndexStore` time, so `getIndexStore` now registers each index store
  under its owning table's data-store name (via a small `registerIndexStore` helper).
- `invalidateCache` clears the data store, then iterates **only** that table's
  registered index store names — never prefix-scanning. Shared `invalidateStore(name)`
  helper looks up `this.stores` and calls `invalidateAll()` if it's a `CachedKVStore`.
- The map is the complete superset of "index stores currently in `this.stores`",
  because `getOrCreateStore` (the only path that adds to `this.stores`) is private and
  reached only via `getStore`/`getIndexStore`. So no cached index store of `t` is ever
  missed.
- Stale-entry maintenance (to keep the map authoritative even across DDL churn):
  `deleteIndexStore` removes the single index name; `renameTableStores` and
  `deleteTableStores` drop the whole table entry; `closeAll` clears the map.
- `STORE_SUFFIX` import removed (it was used only by the deleted prefix scan).

`broadcast.ts` is unchanged — the signature is identical.

## Tests / validation run (all green)

- **`yarn workspace @quereus/plugin-indexeddb test` → 61 passing** (was 58; +3 new).
- **`yarn workspace @quereus/plugin-indexeddb typecheck` → clean.**
- Rebuilt `@quereus/quereus`, `@quereus/store`, `@quereus/isolation` (exit 0) — needed
  because the collision-detection ticket changed `@quereus/store` source and the
  ts-node test path imports those packages from `dist`. **The reviewer's env likely
  needs the same `yarn build` of those three before the IDB suite runs.**
- **Negative control performed:** temporarily restored the buggy prefix-scan and ran
  the new spec — tests 1 & 2 FAILED (sibling re-read the post-invalidation `FRESH`
  value instead of the preserved `CACHED`), test 3 passed. Restored the fix; full suite
  green again. This proves the two regression tests genuinely depend on the fix rather
  than passing trivially.
- No lint: only `packages/quereus` has an eslint script and it was untouched.
- No `.pre-existing-error.md` written — no failures encountered.

### New regression spec (`test/invalidate-cache.spec.ts`)

Wires the real `IndexedDBProvider` over `fake-indexeddb/auto` with a real
`Database` + `StoreModule` (mirrors `rename-persistence.spec.ts`). Each test warms a
store's cache with a `CACHED` byte, then mutates the store's underlying handle behind
the cache to `FRESH`; a post-invalidation `get()` returns `FRESH` iff that store's
cache was cleared, `CACHED` iff preserved.

1. **`invalidateCache(t)` clears t's data + real index caches but NOT a sibling
   `t_idx_archive`** — the literal acceptance criterion. `t` has index `ix_b`; sibling
   table `t_idx_archive` coexists. After `invalidateCache('main','t')`: `t` data and
   `t_idx_ix_b` re-read `FRESH` (cleared); sibling re-reads `CACHED` (untouched).
2. **DROP INDEX + sibling reuse** — `t` first owns an index literally named `archive`
   (store `main.t_idx_archive`); after `drop index "archive"`, a sibling table
   `t_idx_archive` legitimately reuses the freed physical name. Asserts
   `invalidateCache('main','t')` leaves the reused sibling alone — this fails if the
   `deleteIndexStore` map cleanup is omitted (the contrived-but-real staleness path).
3. **`invalidateAllCaches` still clears everything**, sibling included (the unscoped
   path used when the affected table is unknown is deliberately broad).

## Suggested review focus / known gaps (honest)

- **Map-completeness invariant** is the crux. Confirm `getOrCreateStore` truly is the
  only path adding to `this.stores`, and `getIndexStore` the only one adding index
  stores — if some future path materializes an index store another way, the map would
  under-cover and an index cache could go stale-uninvalidated. (Verified true today.)
- **`closeIndexStore` / `closeStore` intentionally do NOT touch the map.** Rationale:
  they only evict a cached handle; the store/table still exists, and `invalidateStore`
  no-ops on a name absent from `this.stores`, with re-registration on re-open. Confirm
  you agree this is correct and not a leak (entries are bounded by live index count and
  cleared on delete/rename/closeAll).
- **Test 2's staleness path** depends on (a) create-time detection allowing the sibling
  after the index drop and (b) `drop index` routing through `provider.deleteIndexStore`
  (verified at `store-module.ts:609`). Worth a sanity re-confirm that both still hold.
- **Cross-tab correctness:** the receiving tab only invalidates stores it has itself
  opened; un-opened stores aren't cached, so there's nothing to clear — by design, not
  a gap, but call it out for completeness.
- **Scope:** this was confirmed (by the prior destructive-path ticket) to be the *only*
  remaining prefix-scan index site across all four providers; LevelDB/NS-sqlite/
  RN-leveldb have no `invalidateCache`. No cross-provider work needed.
- **Not covered by an automated test:** the rename-then-reopen interaction with the map
  (relies on `renameTableStores` dropping the old entry + lazy re-registration). The
  existing `rename-persistence.spec.ts` covers the rename data path; the map's
  contribution there is reasoned, not separately asserted. Low risk (map staleness on a
  renamed-away name is harmless — `invalidateStore` no-ops on absent names).

## Severity reminder

Low / non-destructive. The pre-fix behavior only dropped a sibling's read cache (one
extra re-read from IndexedDB), never moved/deleted data or returned wrong rows. The fix
makes invalidation exact.
