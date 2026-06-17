description: Review the new storage capability that lets a table's rows and indexes be saved to disk in one all-or-nothing commit, so a crash can't leave them out of sync.
prereq:
files:
  - packages/quereus-store/src/common/kv-store.ts            # AtomicBatch interface + KVStoreProvider.beginAtomicBatch
  - packages/quereus-store/src/common/index.ts               # exports AtomicBatch
  - packages/quereus-store/src/common/transaction.ts         # commit() atomic/fallback branch; atomicBatchFactory ctor param
  - packages/quereus-store/src/common/store-module.ts        # getCoordinator (~1840) injects the factory
  - packages/quereus-plugin-indexeddb/src/provider.ts        # beginAtomicBatch + IndexedDBAtomicBatch + resolveStoreName
  - packages/quereus-plugin-indexeddb/src/store.ts           # MultiStoreWriteBatch (reused unchanged)
  - packages/quereus-store/test/transaction.spec.ts          # coordinator atomic-path tests (new "atomic batch path" block)
  - packages/quereus-plugin-indexeddb/test/atomic-batch.spec.ts  # NEW — IDB cache coherence + foreign-handle MISUSE
  - packages/quereus-store/README.md                         # § Atomic multi-store commit + Core Exports row
  - docs/materialized-views.md                               # § Cross-module atomicity reference
difficulty: medium
----

# Review: atomic multi-store batch capability (within-table)

## What was built

An **optional provider capability** so a single table's data store + secondary-index
stores commit in one durable, all-or-nothing physical batch — closing the crash
window where the old per-store `batch()` loop could leave rows and indexes
divergent (no healing exists for that within-table case).

Providers without the capability are **byte-identical to before** (per-store loop).
Shipped for **IndexedDB** (single DB, multiple object stores via the existing
`MultiStoreWriteBatch`) and exercised in the coordinator via a **shared-domain
in-memory test batch**. LevelDB intentionally does not expose the capability yet
(falls back); its shared-root restructure is the parent plan's separate follow-on
`store-leveldb-shared-root`.

### Capability surface (`kv-store.ts`)
`AtomicBatch` addresses stores by **`KVStore` handle** (matching how the coordinator
tracks `op.store`): `put(store,key,value)`, `delete(store,key)`, `write()`, `clear()`.
`KVStoreProvider.beginAtomicBatch?(): AtomicBatch | undefined` — present iff the
provider's stores share one atomic commit domain. Exported from `src/common/index.ts`.

### Coordinator wiring (`transaction.ts`)
Third ctor param `atomicBatchFactory?: () => AtomicBatch | undefined`. In `commit()`,
after grouping `opsByStore` and resolving `defaultStore` (unchanged ordering — resolve
**before** any batch opens, so a failed resolve can't strand a partial commit):
- **Atomic path** (factory yields a batch): queue every grouped op into the one
  `AtomicBatch` (null bucket → resolved `defaultStore` handle), then one `write()`.
- **Fallback path** (factory yields `undefined`, or no factory): today's per-store loop.

`opsByStore` is already folded by `bucketKey`, so each physical store appears once →
no double-write of the same store within the single atomic batch.

### Module wiring (`store-module.ts`)
`getCoordinator` passes `() => this.provider.beginAtomicBatch?.()` — re-evaluated per
commit, so a provider that gains/loses the capability (or is swapped under test) is
always honored.

### IndexedDB (`provider.ts`)
`beginAtomicBatch()` returns `IndexedDBAtomicBatch` over `MultiStoreWriteBatch` +
`this.manager`. `resolveStoreName(store)` unwraps `CachedKVStore` via `getUnderlying()`,
then requires `IndexedDBStore` **bound to this provider's manager** (`getManager() ===
this.manager`) → else `QuereusError(MISUSE)`. After a successful `write()`, each touched
store's read cache is **invalidated** (via the existing `invalidateStore`) — the atomic
write bypasses the `CachedKVStore` wrapper, so without this RYOW across the cache would
regress. `MultiStoreWriteBatch` is reused unchanged.

## How it was validated

- `yarn workspace @quereus/store run test` → **637 passing** (10 new atomic-path tests).
- `yarn workspace @quereus/plugin-indexeddb run test` → **68 passing** (5 new atomic-batch tests).
- `typecheck` (tsc --noEmit) clean for both packages.
- New test code type-checked clean via an ad-hoc tsconfig that includes `test/` (since
  the package tsconfigs exclude `test/`); temp config removed afterward.

### Coordinator tests (`transaction.spec.ts` → "atomic batch path")
atomic path taken when factory yields a batch (data+index land together, per-store
`batch()` never called); fallback when factory yields `undefined`; byte-identical
fallback when **no** factory supplied; rejected `write()` propagates + clears state +
no op leak into next txn; events + commit callbacks still fire on the atomic path;
default-only / index-only (default never resolved) / mixed buckets; resolved-default-
by-handle fold = one store entry (no double-write); empty txn opens no batch.

### IndexedDB tests (`atomic-batch.spec.ts`)
multi-store atomic commit across data+index object stores; **cache coherence** (negative
cache warmed → atomic write → read returns post-write value); `clear()` discards;
foreign-handle MISUSE for wrong type (`InMemoryKVStore`) **and** for an `IndexedDBStore`
bound to a different provider/manager.

## Validation use cases for the reviewer

- Confirm a real `create table … using store` + `create index` + `insert` over the
  **IndexedDB** provider routes the whole DML through ONE `db.transaction(...)` (the wiring
  is unit-covered + typecheck-verified, but there is **no end-to-end integration test**
  asserting the full `getCoordinator → beginAtomicBatch` path through `StoreModule` DML —
  see gaps).
- Confirm the LevelDB path is unchanged (no `beginAtomicBatch` → fallback loop).
- Re-examine the failure semantics: a rejected atomic `write()` must let the engine's
  coordinated-commit catch roll back all connections; verify `finally { clearTransaction() }`
  ordering vs. events/callbacks (events + callbacks fire only **after** a successful write,
  matching the fallback path).

## Known gaps / honest flags (treat tests as a floor)

- **No end-to-end DML integration test.** The atomic path is verified at the unit level
  (coordinator via in-memory spy; provider via direct `beginAtomicBatch`) and the wiring
  via typecheck. A test that drives `insert into t` (t having a secondary index) over a
  real `IndexedDBProvider` and asserts a single IDB transaction / atomic visibility would
  close the loop. Recommended add.
- **`yarn test:store` (LevelDB store-mode logic tests) was NOT run** — slow / not
  agent-runnable in the idle-timeout budget. LevelDB only exercises the unchanged fallback
  path, so risk is low, but a human/CI run is the real confirmation.
- **Cache coherence = invalidate, not update.** Touched-store caches are dropped (next read
  re-fetches) rather than updated in place. Correct + simple; a perf-minded reviewer may
  prefer update-in-place. The ticket allowed either.
- **Durability knob not reused.** `IndexedDBAtomicBatch` uses `MultiStoreWriteBatch`'s
  default IDB durability (durable at `oncomplete`, not `durability:'strict'`), matching the
  existing batch path. The `store-marker-sync-durability` `{ durability }` knob was not
  threaded in (ticket said "keep default unless worth reusing"). Confirm that's acceptable
  for the atomic commit, or wire a strict option.
- **Test files aren't type-checked by the project build** (both package tsconfigs exclude
  `test/`). My ad-hoc check surfaced **pre-existing** issues in files I did not touch —
  `transaction.spec.ts:6` unused `TransactionCallbacks` import (pre-existing, not added by
  me), `unique-constraints.spec.ts:296` a `number`/`void` mismatch, `store.spec.ts:10`
  unused `Row`. None break any project gate (`yarn test` is transpile-only and green), so no
  `.pre-existing-error.md` was filed. Left untouched to avoid scope creep; flag if the team
  wants test typechecking enforced.
- **Concurrent in-flight edits observed (NOT mine):** `packages/quereus/src/runtime/emit/
  alter-table.ts`, `.../materialized-view-helpers.ts`, `src/vtab/module.ts` differ from HEAD
  in the working tree (the tree was clean at session start). Left untouched per the no-
  sanitize rule — noted so the reviewer isn't surprised by them in the diff.

## Follow-on (already chained in the parent plan, do NOT refile)
- `store-leveldb-shared-root` — restructure LevelDB to a shared commit domain so it can
  expose `beginAtomicBatch`.
- `store-module-wide-atomic-commit` (backlog) — the capability surface already spans
  multiple tables of one provider, so module-wide cross-table commit reuses this exact
  batch with no interface change.
