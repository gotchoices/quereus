description: Fixed `IndexedDBProvider.invalidateCache`'s `{table}_idx_` prefix-scan — the last residual store-name prefix-collision anti-pattern. The provider now tracks each table's own index store names (registered as index stores are opened via `getIndexStore`) and clears exactly the table's data + index caches, so a cross-tab data-change for `t` no longer over-invalidates the read cache of a sibling table literally named `t_idx_<x>`. Reviewed and completed.
files:
  - packages/quereus-plugin-indexeddb/src/provider.ts            # indexStoresByTable map; getIndexStore registers; invalidateCache + invalidateStore; teardown cleanup in deleteIndexStore/renameTableStores/deleteTableStores/closeAll; STORE_SUFFIX import removed
  - packages/quereus-plugin-indexeddb/test/invalidate-cache.spec.ts  # regression spec (now 4 tests; +1 rename interaction added in review)
  - packages/quereus-plugin-indexeddb/src/broadcast.ts           # sole caller, UNCHANGED (signature unchanged)
----

# IndexedDB invalidateCache prefix-collision fix — completed

## What shipped

`invalidateCache(schema, table)` is called cross-tab from `broadcast.ts:handleMessage`
with only `{schemaName, tableName}` — no index list. The provider holds only physical
store *names*, which cannot distinguish a real index store of `t`
(`main.t_idx_<index>`) from a sibling table `t_idx_<x>` (`main.t_idx_<x>`) by string
alone; both share the `main.t_idx_` prefix. The old prefix-scan therefore over-cleared
the sibling's read cache.

Fix (self-contained in the IndexedDB plugin — no `@quereus/store` event-type change, no
per-write overhead, no provider→schema coupling):

- New `private indexStoresByTable = Map<dataStoreName, Set<indexStoreName>>`.
  `getIndexStore` registers each index store under its owning table's data-store name
  (via `registerIndexStore`) — the provider already knows the authoritative
  `(schema, table, index) → physical name` mapping at that point.
- `invalidateCache` clears the data store, then iterates **only** that table's
  registered index store names. Shared `invalidateStore(name)` helper looks up
  `this.stores` and calls `invalidateAll()` if it's a `CachedKVStore`.
- Map maintenance keeps it authoritative across DDL churn: `deleteIndexStore` removes
  the single index name; `renameTableStores` and `deleteTableStores` drop the whole
  table entry; `closeAll` clears the map.
- `STORE_SUFFIX` import removed (used only by the deleted prefix scan).

## Review findings

Adversarial pass over the implement-stage diff (`9c8f5f19`), read before the handoff.
Scrutinized for SPP/DRY/modularity, the map-completeness invariant, resource cleanup,
error handling, type safety, and the four-provider scope claim.

**Checked — map-completeness invariant (the crux): CONFIRMED sound.** A missed
invalidation would require an index store present in `this.stores` but absent from the
map. `getOrCreateStore` is private and the *only* writer to `this.stores`, reached only
via `getStore` (data) and `getIndexStore` (which calls `registerIndexStore` first). So
every index store is registered when (or before) it enters `this.stores`. On rename,
`renameTableStores` evicts the old handles (`closeStoreByName`) *and* drops the old map
entry, with lazy re-registration under the new name — neither map nor `this.stores`
retains a stale index name. Invariant holds.

**Checked — `closeStore`/`closeIndexStore` deliberately don't touch the map: CORRECT,
not a leak.** They only evict a cached handle; `invalidateStore` no-ops on a name absent
from `this.stores`, and re-open re-registers. Map size is bounded by live index count
and cleared on delete/rename/closeAll.

**Checked — caller / signature: UNCHANGED.** `broadcast.ts:handleMessage` is the sole
`invalidateCache` consumer; signature identical, no caller change needed. The
`{schemaName, tableName}`-present branch hits `invalidateCache`; the absent branch still
hits the deliberately-broad `invalidateAllCaches`.

**Checked — scope across providers: CONFIRMED only site.** This was the last prefix-scan
index site; `deleteTableStores`/`renameTableStores` already map explicit `indexNames`
rather than prefix-scanning (prior ticket). LevelDB/NS-sqlite/RN-leveldb have no
`invalidateCache`. No cross-provider work.

**Checked — docs: no update needed.** The fix is an internal cache-invalidation
correctness change with no user-facing behavior shift. The `provider.ts` header naming
convention remains accurate; no `docs/` file describes the invalidation internals. The
new `indexStoresByTable` is documented inline at its declaration and at every mutation
site.

**Checked — tests: PASS (62 passing, typecheck clean).** The implementer's 3-test spec
covers the acceptance criterion (sibling `t_idx_archive` left alone), the
DROP-INDEX-then-sibling-reuse staleness path (guards the `deleteIndexStore` map cleanup),
and the unscoped `invalidateAllCaches`. The implementer's negative control (temporarily
restoring the buggy prefix-scan → tests 1 & 2 fail) was reproduced in the handoff and is
credible.

**Found — minor, FIXED IN THIS PASS: missing rename-interaction coverage.** The
implementer honestly flagged the rename-then-reopen path (introduced by this change's
`renameTableStores` map-drop + lazy re-registration) as reasoned-but-not-asserted. Added
a 4th regression test: `create t` + index `ix_b` → `alter table t rename to t2` →
re-open under the new name → assert `invalidateCache('main','t2')` clears the
re-registered index cache. Guards the real post-rename cross-tab correctness path. Suite
now 62 passing.

**Found — trivial, NOT fixed (documented): empty-Set lingering.** After the last index
of a table is dropped via `deleteIndexStore`, an empty `Set` remains under the data-store
key until table delete/rename/closeAll. Bounded, harmless (an empty set yields no
iterations in `invalidateCache`); not worth an extra branch.

**Found — out of scope (documented, no action): schema/table-name case normalization.**
The map keys via `buildDataStoreName(schema, table)`; cross-tab matching relies on the
originating and receiving tabs using consistent casing. This is identical to the
pre-existing data-store invalidation assumption (`invalidateStore(dataStoreName)` uses
the same builder) — not a regression introduced here. No new ticket.

**No major findings.** No new fix/plan/backlog tickets filed. No `.pre-existing-error.md`
written — no failures encountered.

## Validation run

- `yarn workspace @quereus/plugin-indexeddb test` → **62 passing** (58 baseline + 3
  implement + 1 review).
- `yarn workspace @quereus/plugin-indexeddb typecheck` → clean.
- Rebuilt `@quereus/store`, `@quereus/quereus`, `@quereus/isolation` (exit 0) — the
  ts-node test path imports those from `dist`.
- No lint script outside `packages/quereus` (untouched).

## Severity

Low / non-destructive. Pre-fix behavior only dropped a sibling's read cache (one extra
re-read from IndexedDB) — never moved/deleted data or returned wrong rows. The fix makes
invalidation exact.
