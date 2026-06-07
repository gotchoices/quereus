description: Review the fix for the store-name prefix collision where RENAME/DROP of table `t` corrupted a sibling table literally named `t_idx_<x>`. Prefix-scan index discovery in the KV providers was replaced with an authoritative index-name list passed down from `StoreModule` (sourced from `tableSchema.indexes`), and exact index store names are now built via `buildIndexStoreName`.
prereq:
files:
  - packages/quereus-store/src/common/kv-store.ts                 # KVStoreProvider: indexNames added to renameTableStores/deleteTableStores
  - packages/quereus-store/src/common/store-module.ts             # renameTable (~1170) + destroy (~293) callers source + pass the index list
  - packages/quereus-plugin-indexeddb/src/provider.ts             # renameTableStores + deleteTableStores now iterate indexNames
  - packages/quereus-plugin-leveldb/src/provider.ts               # renameTableStores + deleteTableStores: readdir/prefix sweeps removed, exact dirs
  - packages/quereus-plugin-nativescript-sqlite/src/provider.ts   # deleteTableStores iterates indexNames
  - packages/quereus-plugin-react-native-leveldb/src/provider.ts  # deleteTableStores iterates indexNames
  - packages/quereus-store/README.md                             # interface snippet updated
  - docs/store.md                                                # interface snippet updated
  - packages/quereus-store/test/index-persistence.spec.ts         # in-memory double adopts indexNames
  - packages/quereus-store/test/alter-table.spec.ts               # in-memory double adopts indexNames
  - packages/quereus-plugin-indexeddb/test/rename-persistence.spec.ts  # +2 sibling regression tests; fixed a direct renameTableStores call
  - packages/quereus-plugin-leveldb/test/sibling-collision.spec.ts     # NEW: LevelDB sibling regression (on-disk dir assertions)
----

# Review: store-name prefix collision between a table and its `<table>_idx_*` siblings

## What the bug was

Index stores are named `{schema}.{table}_idx_{index}`. The providers discovered a
table's index stores by **prefix-matching** the live store list against
`{schema}.{table}_idx_`. Because `_idx_` is a legal substring of an ordinary
identifier, a sibling table literally named `t_idx_archive` (data store
`main.t_idx_archive`) also matched the prefix for table `t`:

- **RENAME `t` → `t2`** relocated the sibling's data store to `main.t2_idx_archive`
  (IndexedDB) / moved its directory (LevelDB) — silently orphaning the sibling.
- **DROP `t`** deleted the sibling's store/directory — destroying its rows.

The ambiguity is structural (flat naming, no unambiguous delimiter), so a tighter
regex can't fix it.

## What the fix does

`StoreModule` now hands each provider the **authoritative** list of the table's real
index names (`tableSchema.indexes.map(i => i.name)`). Providers build **exact** index
store names from it via `buildIndexStoreName` and never prefix-scan the store list.

- `KVStoreProvider.renameTableStores`/`deleteTableStores` gained a trailing
  `indexNames: readonly string[]` param (no back-compat shim, per AGENTS).
- `renameTable`: derives `indexNames` from `currentSchema` (captured before in-memory
  eviction) and passes it down.
- `destroy`: renamed `_db`→`db`; sources the schema as
  `table?.getSchema() ?? db.schemaManager.getTable(...)`, derives `indexNames`, and
  passes it down. **Confirmed** the engine's DROP ordering (`schema/manager.ts:~1191`)
  calls `module.destroy(...)` *before* `schema.removeTable(...)`, so the schemaManager
  fallback still resolves the full schema (with `indexes`) at destroy time even for a
  never-connected table. Falls back to `[]` only if no schema is resolvable at all.
- IndexedDB: rename/delete iterate `indexNames` with `buildIndexStoreName` +
  `hasObjectStore` guards (move/delete only materialized stores); destination-collision
  guard kept per target.
- LevelDB: removed **both** the open-handle prefix scan and the `readdir`+prefix dir
  sweeps; close handles by exact store key and rename/remove exact directories
  (original-case `{table}_idx_{index}` path, mirroring `getIndexStore`).
- NS-sqlite + RN-leveldb: `deleteTableStores` closes exactly the named index stores.

## How to validate (commands that were run, all green)

- `yarn workspace @quereus/store run build` → exit 0
- `yarn workspace @quereus/store run test` → **330 passing**
  (the `Error: boom` line and the `THIS IS NOT VALID SQL` rehydrate warning are
  deliberate fixtures in `events.spec.ts` / a bad-DDL test, not failures)
- `yarn workspace @quereus/plugin-indexeddb test` → **58 passing** (incl. 2 new siblings)
- `yarn workspace @quereus/plugin-leveldb test` → **14 passing** (incl. 2 new siblings)
- `yarn workspace @quereus/plugin-indexeddb run build` / `@quereus/plugin-leveldb run build` → exit 0
- `yarn workspace @quereus/plugin-nativescript-sqlite run typecheck` → exit 0
- `yarn workspace @quereus/plugin-react-native-leveldb run typecheck` → exit 0

## Regression tests added (the core acceptance criteria)

Sibling pair `t` + `"t_idx_archive"`, each populated; `t` has a real index `ix_b`:

- **IndexedDB** (`rename-persistence.spec.ts`): RENAME `t`→`t2` and DROP `t` each leave
  `main.t_idx_archive` (object store + rows) intact, assert the sibling is NOT mis-moved
  to `main.t2_idx_archive`, and confirm `t`'s real index still relocates/removes. RENAME
  case also survives a fresh-provider reopen.
- **LevelDB** (`sibling-collision.spec.ts`, NEW): same scenarios asserting on-disk
  directories (`main/t_idx_archive` survives; `main/t2_idx_archive` never created;
  `main/t_idx_ix_b` → `main/t2_idx_ix_b` on rename, removed on drop) plus engine-visible
  rows.

These genuinely exercise the bug: under the old code the RENAME assertion
`indexDir('t2','archive')` would have existed and `dataDir('t_idx_archive')` would have
been moved away.

## Reviewer focus / known gaps (treat as a floor, not a finish line)

1. **No runtime test coverage for NS-sqlite / RN-leveldb.** Those packages have no test
   suite; only `tsc --noEmit` was run. The `deleteTableStores` change there is mechanical
   (same iterate-indexNames pattern) but unexercised at runtime. Note their old bug was
   milder than IDB/LevelDB: they only *closed the sibling's cached handle* (no data
   delete — RN's `deleteIndexStore` even documents that on-disk removal isn't
   implemented, and NS never DROPs the SQLite table). Still correct to stop touching the
   sibling. Worth a skim that the cache-key construction matches `getIndexStore`.

2. **Residual, out-of-scope ambiguity at CREATE time.** If table `t` has a real index
   named `archive` *and* a sibling table is named exactly `t_idx_archive`, both map to
   the same physical store name `main.t_idx_archive`. The authoritative-list approach
   does **not** resolve that — it's a fundamental collision in the flat naming scheme and
   a separate concern (would need CREATE-time collision detection). This fix only closes
   the prefix-*scan* hole (sibling wrongly swept when `t` is renamed/dropped). Flagging in
   case the reviewer wants a follow-up backlog ticket for CREATE-time detection.

3. **LevelDB orphan-dir sweep removed (intentional tradeoff).** The old
   `deleteTableStores` also `readdir`-swept any `{table}_idx_*` directory not in the open
   set (e.g. left by a crash mid-`DROP INDEX`). That incidental cleanup is gone — a truly
   orphaned index dir not present in the rehydrated schema is no longer swept. Accepted by
   the ticket as the safe choice (better to leak an orphan than destroy a sibling).

4. **`destroy` `[]` fallback.** Only triggers if neither the cached `StoreTable` nor the
   schemaManager yields a schema. Given the confirmed DROP ordering this should be
   unreachable in normal flow, but if hit, index stores aren't swept by name (no worse
   than today for the no-sibling case, strictly safer for the sibling case).

5. **Engine logic suite (`packages/quereus`) not re-run** — no engine files changed; the
   default engine tests use the in-memory vtab, not `StoreModule`, so they don't exercise
   this path. Store + both plugin suites are the relevant coverage. No
   `.pre-existing-error.md` written (all run suites green).
