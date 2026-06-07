description: IndexedDB provider gained `renameTableStores` (+ `IndexedDBManager.renameObjectStores`) that relocates a table's data + secondary-index object stores during `ALTER TABLE … RENAME TO` via an atomic copy-then-delete inside a single versionchange transaction. Closes a silent-data-loss gap where a renamed indexeddb-backed table rehydrated empty under the new name while its rows/index entries stayed orphaned under the old name.
files:
  - packages/quereus-plugin-indexeddb/src/manager.ts                    # renameObjectStores + doRenameObjectStores (versionchange copy/delete)
  - packages/quereus-plugin-indexeddb/src/provider.ts                   # renameTableStores (collision guard, rename-list build, evict handles)
  - packages/quereus-plugin-indexeddb/test/rename-persistence.spec.ts   # integration tests (fake-indexeddb + Database + StoreModule)
  - packages/quereus-plugin-indexeddb/src/store.ts                      # shared-manager connection model (single connection)
  - packages/quereus-store/src/common/store-module.ts                   # renameTable: calls renameTableStores BEFORE rewriting catalog
  - packages/quereus-store/src/common/cached-kv-store.ts                # write-through cache (no buffered writes lost on evict)
  - packages/quereus-store/README.md                                    # provider interface doc (renameTableStores? added in review)
  - docs/store.md                                                       # provider interface doc (renameTableStores? added in review)
----

# IndexedDB `renameTableStores` — completed

IndexedDB object stores cannot be renamed in place, so `ALTER TABLE … RENAME TO`
on an indexeddb-backed table relocates the data store plus every secondary-index
store via an **atomic copy-then-delete inside one `versionchange` transaction**:
create each `to` store, cursor-copy every entry from `from` verbatim, delete
`from`. A cursor-chained driver keeps a request pending so the transaction stays
alive until the last copy, then auto-commits; any error aborts the whole batch
(old stores intact, new stores never created). `StoreModule.renameTable` calls the
hook **before** rewriting the catalog, so a failed rename leaves the table fully
addressable under its old name.

## Review findings

### Scope checked
- Implement diff `d2fd592c` read first, then the handoff summary.
- `manager.ts` (`renameObjectStores` / `doRenameObjectStores`), `provider.ts`
  (`renameTableStores`), and the new `rename-persistence.spec.ts`.
- Surrounding context: `store.ts` (connection model), `cached-kv-store.ts`
  (write-through semantics), `store-module.ts:renameTable` (call ordering + stats
  handoff), `key-builder.ts` (naming scheme), and the LevelDB reference provider.
- Ran `yarn workspace @quereus/plugin-indexeddb typecheck` → exit 0 and
  `yarn workspace @quereus/plugin-indexeddb test` → **56 passing** (incl. 5 new).

### Correctness — verified, no defects found
- **All-or-nothing relocation**: the cursor-chained driver always has a pending
  request between renames (cursor `continue()` while copying; a fresh
  `openCursor` opened synchronously for the next item before the prior `onsuccess`
  returns), so the versionchange tx cannot auto-commit mid-batch. Empty-source
  store → single `onsuccess(cursor=null)` → `deleteObjectStore` + advance: the
  chain still terminates correctly. Confirmed against the empty-table test.
- **Abort consistency / `dbVersion` self-heal**: on a copy error the tx aborts and
  `request.onerror` rejects with the captured `copyError` (not a bare AbortError).
  `this.db` is left null and `this.objectStores` is never cleared on the failure
  path, so it still reflects the (intact) old stores; the in-memory `dbVersion++`
  is reconciled on the next `ensureOpen()` → `doOpen()` →
  `getExistingDatabaseInfo()`, which re-reads the real on-disk version. Reasoning
  holds — no path reuses the stale `dbVersion` before a `doOpen()`.
- **No cache-driven data loss**: `CachedKVStore` is write-through (`put`/`delete`
  hit the underlying store immediately); evicting `from` handles before the
  relocation only drops read caches. Combined with `StoreModule.renameTable`
  flushing the coordinator + disconnecting the old handle first, no buffered write
  can be lost across the rename.
- **Single-connection model**: all stores (data, index, `__catalog__`, `__stats__`)
  share the one `IndexedDBManager` connection, so `doRenameObjectStores` closing
  `this.db` cannot be blocked by a sibling connection in the single-tab path.
- **Collision guards**: provider-level (data store + each index target) and
  manager-level pre-bump guard both fire before any mutation; the
  StoreModule-level `tables.has(newKey)` check short-circuits the SQL path earlier.
  No destructive op precedes a guard. Covered by the non-destructive collision test.
- **`__stats__` handoff**: provider deliberately leaves `__stats__` untouched;
  `StoreModule.renameTable` deletes the old stats key (advisory, failure-tolerant)
  and stats recompute lazily under the new name. Correct.

### Minor — fixed in this pass
- **Docs out of date**: `packages/quereus-store/README.md` and `docs/store.md` both
  list the `KVStoreProvider` interface but omitted `renameTableStores?` (the method
  was added earlier in `store-alter-table-rename-unsupported` and never documented).
  Added the optional method to both interface listings. No engine README/lifecycle
  doc describes per-provider DROP/RENAME store teardown (the analogous
  `deleteTableStores` is also undocumented at that level); the contract lives in the
  `kv-store.ts` JSDoc, which is accurate — left as-is, not expanded in this pass.

### Major — filed as a new ticket
- **`tickets/fix/store-name-prefix-collision-sibling-tables.md`** — the index sweep
  (`name.startsWith('{schema}.{table}_idx_')`) in both RENAME and DROP, across the
  IndexedDB **and** LevelDB providers, also matches a *sibling table* literally
  named `{table}_idx_…`. Renaming/dropping `t` can therefore silently relocate or
  delete the unrelated `t_idx_archive` table's stores → data loss. Pre-existing and
  structural to the flat naming scheme (predates this feature); the rename path
  merely widens the blast radius. Out of scope to fix inline (touches the shared
  provider contract + both plugins + the delete path); recommended direction is to
  pass the authoritative index list from `StoreModule` rather than prefix-scan.

### Residual gaps (accepted, documented)
- **Mid-copy abort under fault injection is inspection-verified only.** The
  pre-bump collision guard's non-destructive guarantee *is* tested directly; the
  cursor/`put` mid-versionchange failure branch is not, because fake-indexeddb
  offers no clean seam to fail a request mid-upgrade. The all-or-nothing guarantee
  otherwise rests on spec-guaranteed IDB transaction atomicity. Not a blocker;
  a fault-injection seam could be added later if desired.
- **Cross-engine validation.** Cursor-copy + `createObjectStore`/`deleteObjectStore`
  while the versionchange tx is held open by a pending request is per-spec and
  passes under fake-indexeddb, but is not exercised against real Chrome/Firefox/
  Safari IDB engines in CI. Multi-tab (`onblocked` / `onversionchange`) handlers are
  present and copied from the existing upgrade helpers but, like the pre-existing
  upgrade/delete paths, are not exercised under fake-indexeddb's single-connection
  model.

### Tests
Implementer's 5 integration tests (real `IndexedDBProvider` over
`fake-indexeddb/auto` + real `Database` + `StoreModule`, with reopen-from-disk)
cover: rename preserves data + index across reopen with the old name fully gone;
multiple secondary indexes incl. a still-enforcing UNIQUE; empty-table relocation;
non-destructive destination collision; and DROP teardown of data + every index
store. Reviewed as a solid floor — happy path, the empty edge, the collision error
path, and a DROP regression are all present. The two residual gaps above are the
only notable uncovered paths and are accepted as documented.
