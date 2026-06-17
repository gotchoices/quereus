description: Add an optional storage-provider capability that writes all of one table's data and index changes to disk in a single all-or-nothing commit, so a crash can no longer leave a table's secondary indexes out of sync with its rows.
prereq:
files:
  - packages/quereus-store/src/common/kv-store.ts            # capability surface (AtomicBatch, provider hook)
  - packages/quereus-store/src/common/transaction.ts         # commit() — use atomic batch when present
  - packages/quereus-store/src/common/store-module.ts        # getCoordinator injects the capability (~line 1840)
  - packages/quereus-store/src/common/memory-store.ts        # shared-domain memory provider for tests
  - packages/quereus-plugin-indexeddb/src/provider.ts        # beginAtomicBatch via MultiStoreWriteBatch
  - packages/quereus-plugin-indexeddb/src/store.ts           # MultiStoreWriteBatch (exists), storeName resolution
  - packages/quereus-store/test/transaction.spec.ts          # coordinator atomic-path tests
difficulty: hard
----

# Atomic multi-store batch capability (within-table)

Today `TransactionCoordinator.commit()` (`transaction.ts` ~189) groups pending
ops by target store and writes **one `store.batch()` per store sequentially**
(data store, then each secondary-index store). A crash between those batches
leaves a table's data and its secondary indexes divergent, and **no healing
mechanism exists** for that — unlike MV backings, which rehydrate-refill. This
is the most acute window the parent plan
(`store-atomic-multi-store-commit`) names.

This ticket introduces the **optional provider capability** and wires the
coordinator to use it so a single table's data + index stores commit in **one
durable, all-or-nothing batch**. Providers without the capability keep today's
per-store loop (documented windows unchanged). It ships the capability for the
backends that already have a shared commit domain — **IndexedDB** (one DB,
multiple object stores — `MultiStoreWriteBatch` already exists) and a
**shared-domain in-memory** provider for tests. LevelDB is restructured to a
shared root in the prereq-chained follow-on `store-leveldb-shared-root`; until
then it simply does not expose the capability and falls back.

> The capability surface is deliberately designed to also span **multiple
> tables** of one module (every store belongs to one provider), so the later
> module-wide cross-table commit (backlog `store-module-wide-atomic-commit`)
> reuses this exact batch with no interface change. This ticket only exercises
> the within-one-coordinator (data + indexes) case.

## Capability surface (`kv-store.ts`)

```ts
/**
 * An atomic batch spanning multiple stores of ONE provider. `write()` commits
 * every queued op across every referenced store in a single durable,
 * all-or-nothing physical commit. Obtained from
 * `KVStoreProvider.beginAtomicBatch()`; a provider exposes that method iff its
 * stores share one atomic commit domain. All stores passed to `put`/`delete`
 * must have been produced by the same provider.
 */
export interface AtomicBatch {
	put(store: KVStore, key: Uint8Array, value: Uint8Array): void;
	delete(store: KVStore, key: Uint8Array): void;
	/** Commit all queued ops across all referenced stores atomically + durably. */
	write(): Promise<void>;
	/** Discard all queued ops. */
	clear(): void;
}

export interface KVStoreProvider {
	// ...existing members...
	/**
	 * Open an atomic batch across this provider's stores, or return undefined
	 * when the provider has no shared atomic commit domain (callers then fall
	 * back to per-store `KVStore.batch()`).
	 */
	beginAtomicBatch?(): AtomicBatch | undefined;
}
```

The batch addresses stores by **KVStore handle** (matching how the coordinator
already tracks `op.store`), not by name — so it composes with the coordinator's
existing per-store bucketing without a name lookup.

## Coordinator wiring (`transaction.ts`)

Inject an optional factory into the coordinator constructor:

```ts
constructor(
  store: DefaultStoreSource,
  eventEmitter?: StoreEventEmitter,
  atomicBatchFactory?: () => AtomicBatch | undefined,
)
```

In `commit()`, after grouping `opsByStore` and resolving `defaultStore` (the
existing logic at ~211–225), branch:

- **Atomic path** — if `atomicBatchFactory?.()` returns a batch: queue every
  grouped op into the single `AtomicBatch` (mapping the `null` bucket to the
  resolved `defaultStore` handle), then one `await atomicBatch.write()`. One
  physical commit for the whole table.
- **Fallback path** — otherwise, today's loop (one `store.batch().write()` per
  store).

Resolve the default store **before** opening the atomic batch (as today),
keeping a failed resolve from stranding a partial commit. The atomic batch is
opened only when there are pending ops.

## Module wiring (`store-module.ts`)

`getCoordinator` (~1840) passes the capability through:

```ts
coordinator = new TransactionCoordinator(
  () => this.getStore(tableKey, config),
  this.eventEmitter,
  () => this.provider.beginAtomicBatch?.(),
);
```

(The factory is re-evaluated per commit so a provider that gains/loses the
capability — or is swapped under test — is always honored.)

## IndexedDB implementation (`provider.ts` + `store.ts`)

- Implement `beginAtomicBatch()` on `IndexedDBProvider`, returning a wrapper
  over the existing `MultiStoreWriteBatch` (`store.ts`) + `this.manager`.
- The wrapper maps each `KVStore` handle to its object-store name. Handles the
  provider hands out are `CachedKVStore(IndexedDBStore)` (or raw
  `IndexedDBStore` when caching is disabled). Resolve the underlying
  `IndexedDBStore` and call `getStoreName()` — add an unwrap helper
  (`CachedKVStore` should expose its wrapped store, or the provider reverse-maps
  via `this.stores`). A handle not produced by this provider is a programming
  error → throw `QuereusError(MISUSE)`.
- **Cache coherence:** the atomic write bypasses the `CachedKVStore` wrapper, so
  after `write()` the wrapper's read cache for every touched store would be
  stale. The provider knows the wrapping; the batch must invalidate (or update)
  each touched store's cache on successful `write()`. Reuse `invalidateStore`.
- One `db.transaction(storeNames, 'readwrite')` already gives IDB atomicity —
  `MultiStoreWriteBatch.write()` does exactly this. Keep `{ durability }`
  default unless `store-marker-sync-durability` introduced a knob worth reusing.

## Shared-domain in-memory provider (tests)

`InMemoryKVStore` cannot crash, so "atomic" is trivially modeled — but the
coordinator's atomic code path still needs deterministic coverage. Add a small
test-only provider (or extend the existing test provider in
`transaction.spec.ts` / `backing-host.spec.ts`) whose `beginAtomicBatch()`
returns a batch that buffers ops keyed by store handle and applies them to each
`InMemoryKVStore` on `write()`. Assert the coordinator routes through the atomic
path (e.g. a spy counting `beginAtomicBatch` calls vs per-store `batch()`
calls) and that data + index ops land together.

## Edge cases & interactions

- **Capability absent → byte-identical behavior.** With no
  `beginAtomicBatch`, `commit()` must behave exactly as today (LevelDB, and any
  provider that omits the method). The factory returning `undefined` mid-run
  must also fall back cleanly.
- **Empty transaction.** No pending ops → no batch opened (preserve the
  `pendingOps.length > 0` guard).
- **Default-only / index-only / mixed buckets.** All three must route correctly:
  default bucket → resolved `defaultStore`; explicit index handles → themselves;
  the resolved-default-by-handle fold (`bucketKey`) must still collapse to one
  store entry (no double-write of the same store in one atomic batch).
- **Failed `defaultStore` resolve.** Must abort before any op is queued into the
  atomic batch (no partial commit), same as the fallback path today.
- **`write()` failure / rejection.** A rejected atomic `write()` must propagate
  (commit throws), the engine's coordinated-commit catch rolls back all
  connections; the coordinator's `finally { clearTransaction() }` still runs.
  Verify no ops leak into the next transaction.
- **Stats callbacks unchanged.** `onCommit`/`onRollback` (stats apply/discard)
  fire after the write, same ordering as today — the atomic path must not skip
  them.
- **Events unchanged.** Pending `DataChangeEvent`s still flush after the write.
- **CachedKVStore staleness (IDB).** Assert that a read after an atomic write
  through the cache returns post-write data (cache invalidated). Without this,
  RYOW across the cache regresses.
- **Handle from wrong provider.** `AtomicBatch.put/delete` with a foreign handle
  → MISUSE, not a silent misfile.
- **Savepoints / rollback-to.** Unaffected (atomic batch is built only at
  `commit()` from the final `opsByStore`); confirm a commit after a
  rollback-to-savepoint writes exactly the surviving ops.

## TODO

- Define `AtomicBatch` + optional `KVStoreProvider.beginAtomicBatch` in
  `kv-store.ts`; export from `src/common/index.ts`.
- Add the `atomicBatchFactory` constructor param to `TransactionCoordinator`
  and the atomic/fallback branch in `commit()`.
- Inject the factory from `StoreModule.getCoordinator`.
- Implement `IndexedDBProvider.beginAtomicBatch` over `MultiStoreWriteBatch`
  with handle→storeName unwrap and post-write cache invalidation; add the
  unwrap accessor on `CachedKVStore`.
- Add the shared-domain in-memory test provider.
- Tests (`transaction.spec.ts`): atomic path is taken when the factory yields a
  batch; data + index ops commit together; fallback when factory yields
  undefined; `write()` rejection rolls back and clears; stats/events still fire;
  mixed/default-only/index-only buckets; foreign-handle MISUSE.
- `yarn test` (memory + IDB happy path via fake-indexeddb if present);
  `yarn lint` in `packages/quereus`.
- Document the capability in `packages/quereus-store/README.md` (Core Exports +
  a short "Atomic multi-store commit" note) and reference it from
  `docs/materialized-views.md` § Cross-module atomicity.
