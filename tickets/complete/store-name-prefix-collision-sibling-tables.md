description: Fixed the store-name prefix collision where RENAME/DROP of table `t` corrupted a sibling table literally named `t_idx_<x>`. Prefix-scan index discovery in the KV providers was replaced with an authoritative index-name list passed down from `StoreModule` (from `tableSchema.indexes`); exact index store names are built via `buildIndexStoreName`. Reviewed and accepted.
files:
  - packages/quereus-store/src/common/kv-store.ts
  - packages/quereus-store/src/common/store-module.ts
  - packages/quereus-plugin-indexeddb/src/provider.ts
  - packages/quereus-plugin-leveldb/src/provider.ts
  - packages/quereus-plugin-nativescript-sqlite/src/provider.ts
  - packages/quereus-plugin-react-native-leveldb/src/provider.ts
  - packages/quereus-store/README.md
  - docs/store.md
  - packages/quereus-store/test/index-persistence.spec.ts
  - packages/quereus-store/test/alter-table.spec.ts
  - packages/quereus-plugin-indexeddb/test/rename-persistence.spec.ts
  - packages/quereus-plugin-leveldb/test/sibling-collision.spec.ts
----

# Store-name prefix collision between a table and its `<table>_idx_*` siblings — COMPLETE

## What shipped

Index stores are named `{schema}.{table}_idx_{index}`. Providers used to discover a
table's index stores by **prefix-matching** the live store list against
`{schema}.{table}_idx_`. Because `_idx_` is a legal identifier substring, a sibling table
literally named `t_idx_archive` (data store `main.t_idx_archive`) matched table `t`'s
index prefix, so **RENAME `t`** silently relocated the sibling's storage and **DROP `t`**
destroyed it.

`StoreModule` now hands each provider the authoritative list of the table's real index
names (`tableSchema.indexes.map(i => i.name)`), captured **before** in-memory eviction.
Providers build exact index store names from it via `buildIndexStoreName` and never
prefix-scan. `KVStoreProvider.renameTableStores`/`deleteTableStores` gained a trailing
`indexNames: readonly string[]` param (no back-compat shim). All four real providers
(IndexedDB, LevelDB, NS-sqlite, RN-leveldb) plus the in-memory test doubles were updated;
docs (`docs/store.md`, `packages/quereus-store/README.md`) reflect the new interface.

## Review findings

Adversarial pass over commit `27e5276e` (implement). Read the full diff first, then
verified against the live code.

### Checked — correctness of the fix

- **Authoritative-list invariant holds.** Every physical `_idx_` store is created/opened
  from an entry in `tableSchema.indexes` (`store-module.ts` createIndex @366, connect/
  rekey @890–897, rehydrate @1493). There is no path that materializes an index store
  without a matching `.indexes` entry, so `tableSchema.indexes.map(i => i.name)` is a
  *complete* enumeration. UNIQUE constraints are `derivedFromIndex` and ride on the same
  index entries — no orphan stores. **Sound.**
- **`destroy` schema resolution.** Confirmed engine DROP ordering: `schema/manager.ts`
  calls `module.destroy(...)` (@1194) **before** `schema.removeTable(...)` (@1214), so
  `db.schemaManager.getTable(...)` still resolves the full schema (with `indexes`) at
  destroy time even for a never-connected table. `db` is now passed (was `_db`). **Sound.**
- **`renameTable` schema resolution.** Confirmed `runRenameTable`
  (`runtime/emit/alter-table.ts` @158) calls `module.renameTable(...)` **before**
  `schema.removeTable(oldName)` (@161). `currentSchema`/`indexNames` are captured before
  in-memory eviction. **Sound.**
- **Name construction parity across providers.** LevelDB index dirs use original-case
  `{table}_idx_{index}` (mirrors `getIndexStore` @67-71) while store keys lowercase —
  consistent on both the write and the rename/delete sides. IndexedDB uses
  `buildIndexStoreName` (lowercased) everywhere. NS-sqlite/RN-leveldb build the delete key
  as `${getStoreKey()}${STORE_SUFFIX.INDEX}${indexName}`, **byte-identical** to their
  `getIndexStore` cache key. Verified each. **Sound.**
- **Materialization guards.** IndexedDB rename/delete guard with `hasObjectStore`;
  LevelDB rename guards each dir with `pathExists`; destination-collision guards retained.

### Found — residual prefix-scan, non-destructive → filed backlog

- **`IndexedDBProvider.invalidateCache` (`provider.ts:207`) still prefix-scans
  `{table}_idx_`.** A cross-tab data-change for `t` also clears the sibling's read cache.
  **Disposition: backlog, not inline.** It is non-destructive (over-invalidation = one
  harmless extra re-read; never wrong data), and its only caller (`broadcast.ts`) has just
  `{schemaName, tableName}` — no index list — so a correct fix needs payload/plumbing
  changes out of this ticket's scope. → `tickets/backlog/indexeddb-invalidatecache-prefix-collision.md`.
  Confirmed via grep that this is the *only* remaining `startsWith`/prefix index site
  across all four providers; every destructive path is fixed.

### Found — structural CREATE-time collision (pre-existing) → filed backlog

- Index `archive` on table `t` and a sibling table named exactly `t_idx_archive` both map
  to physical store `main.t_idx_archive`. The authoritative-list approach does **not**
  resolve this (the names are genuinely equal); needs CREATE-time collision detection or
  an unambiguous encoding. Pre-existing, out of scope, flagged by the implementer.
  → `tickets/backlog/store-index-vs-sibling-table-name-collision-at-create.md`.

### Tests — verified and adequate for the destructive paths

- **End-to-end coverage of the real fix.** The IndexedDB (`rename-persistence.spec.ts`)
  and LevelDB (`sibling-collision.spec.ts`, new) regression tests wire a real
  `Database` + `StoreModule` over a real provider, `create index ix_b on t`, then
  RENAME/DROP — asserting the sibling `t_idx_archive` survives (object store/dir + rows),
  is NOT mis-moved to `t2_idx_archive`, and `t`'s real index still relocates/removes. This
  exercises the full `indexNames` derivation, not just the provider in isolation. The IDB
  rename case also survives a fresh-provider reopen. These genuinely fail under the old
  prefix-scan code.
- In-memory doubles (`alter-table.spec.ts`, `index-persistence.spec.ts`) adopt the new
  exact-name semantics.
- **Minor gaps (accepted, not blocking):** (1) the never-connected rename/destroy branch
  (schema sourced from `schemaManager` rather than a cached `StoreTable`) is covered by
  code-reading of the confirmed engine ordering but not by a dedicated test — every
  sibling test inserts first, connecting the table. (2) NS-sqlite/RN-leveldb have no
  runtime suite (none exists); only `tsc --noEmit` was run, and their old bug was milder
  (closed the sibling's cached handle, no data delete). Key-construction parity was
  verified by reading. Both are documented residuals, low risk.

### Validation (all green at review)

- `yarn workspace @quereus/store run build` → exit 0
- `yarn workspace @quereus/store run test` → **330 passing** (the `Error: boom` and
  `THIS IS NOT VALID SQL` lines are deliberate fixtures in `events.spec.ts` / a bad-DDL
  rehydrate test, not failures)
- `yarn workspace @quereus/plugin-indexeddb test` → **58 passing** (incl. 2 new siblings)
- `yarn workspace @quereus/plugin-leveldb test` → **14 passing** (incl. 2 new siblings)
- `yarn workspace @quereus/plugin-nativescript-sqlite run typecheck` → exit 0
- `yarn workspace @quereus/plugin-react-native-leveldb run typecheck` → exit 0
- Lint: only `packages/quereus` has an eslint script and no engine files changed, so the
  lint target does not apply to this diff.
- No `.pre-existing-error.md` written — every suite run was green.

## Spawned follow-ups

- `backlog/indexeddb-invalidatecache-prefix-collision.md` (low; non-destructive residual)
- `backlog/store-index-vs-sibling-table-name-collision-at-create.md` (structural, pre-existing)
