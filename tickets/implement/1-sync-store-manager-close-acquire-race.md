description: The sync coordinator can hand out a database handle that another part of the system is closing at the same moment, so the caller ends up operating on a dead database. Serialize open/close per database so an acquire always gets a live handle.
files:
  - packages/sync-coordinator/src/service/store-manager.ts   # acquire / closeStore / cleanup / evictLRU lifecycle
  - packages/sync-coordinator/test/store-manager.spec.ts      # add deterministic race repro
difficulty: medium
----

## Root cause (confirmed by code read)

`StoreManager` pools `StoreEntry` handles in `this.stores` keyed by `databaseId`.
Stores are closed by `cleanup()` (idle timeout) and `evictLRU()` (LRU pressure), both
routed through the private `closeStore()`. `acquire()` vends handles from the same map.

The retirement of a handle is **not atomic** with respect to `acquire()`:

`closeStore()` (`store-manager.ts:451`):
```
const entry = this.stores.get(databaseId);   // 452
if (!entry) return;
if (entry.refCount > 0) return;               // 457  refCount recheck — BEFORE the await
const storagePath = this.resolveStoragePath(databaseId, context); // 460 (sync)
await entry.store.close();                     // 463  <-- yields; entry STILL in this.stores
this.stores.delete(databaseId);                // 464  <-- removed only after close resolves
```

The entry remains observable in `this.stores` for the entire duration of the
`await entry.store.close()`. A concurrent `acquire()` (`store-manager.ts:176`) that runs
during that await:
```
this.closedStores.delete(databaseId);          // 178
let entry = this.stores.get(databaseId);        // 181  <-- finds the entry being torn down
if (entry) { entry.refCount++; ...; return entry; } // 183-186  <-- vends a dead handle
```

The caller receives a handle whose `store.close()` has run (or is about to). Any
subsequent `get`/`put`/`batch` hits `LevelDBStore.checkOpen()`
(`packages/quereus-plugin-leveldb/src/store.ts:180-184`) and throws
`"LevelDBStore is closed"` — or, worse, operates on a half-closed resource.

Both close callers hit this:
- `cleanup()` → `closeStore(id)` racing an `acquire(id)` for the **same** key.
- `evictLRU()` (invoked from inside `acquire()` at `store-manager.ts:201`) → `closeStore(victimId)`
  racing a concurrent `acquire(victimId)` for the **evicted** key (a different key than the
  one the outer acquire is opening).

The existing refCount guard at line 457 does **not** close the window: it runs in
`closeStore`'s synchronous prelude, before the `await`. The racing `acquire`'s
`refCount++` happens *after* that guard already decided to proceed.

## Fix design — per-key close serialization via `pendingCloses`

Mirror the existing `pendingOpens` dedup map with a `pendingCloses` map, and make the
close decision + map removal happen **synchronously** (in one JS tick, before any
`await`). JavaScript is single-threaded, so synchronous sections are atomic; the race
only exists across `await` boundaries. Whichever synchronous section wins is safe:

- **acquire's sync section runs first** → `refCount` becomes 1 → `closeStore`'s guard
  (`refCount > 0`) sees it and bails. Entry stays live. Safe.
- **closeStore's sync section runs first** → it removes the entry from `this.stores` and
  registers a pending-close promise *before* awaiting `close()` (refCount was 0). A later
  `acquire` finds no entry in `this.stores`, sees the pending close, `await`s it, then
  opens a **fresh** handle. Safe — and correct for LevelDB's single-open lock, because
  the old handle is fully closed before the new `open()` starts.

### `closeStore` (rewrite)

```ts
private readonly pendingCloses = new Map<string, Promise<void>>();

private async closeStore(databaseId: string, context?: StoreContext): Promise<void> {
  const entry = this.stores.get(databaseId);
  if (!entry) return;
  if (entry.refCount > 0) return;

  // Synchronously retire the entry from the live map and register the in-flight
  // close BEFORE awaiting. A racing acquire either (a) incremented refCount in an
  // earlier tick — caught by the guard above — or (b) runs after this tick, finds
  // no entry, and waits on pendingCloses before opening a fresh handle.
  this.stores.delete(databaseId);
  const storagePath = this.resolveStoragePath(databaseId, context);

  const closePromise = (async () => {
    try {
      await entry.store.close();
      serviceLog('Store closed: %s', databaseId);
      if (this.diskEvictionIdleMs > 0 && this.onEvictStore) {
        this.closedStores.set(databaseId, { storagePath, closedAt: Date.now() });
      }
    } catch (err) {
      serviceLog('Error closing store %s: %O', databaseId, err);
    }
  })();

  this.pendingCloses.set(databaseId, closePromise);
  try {
    await closePromise;
  } finally {
    this.pendingCloses.delete(databaseId);
  }
}
```

### `acquire` (add close-wait at the top)

```ts
async acquire(databaseId: string, context?: StoreContext): Promise<StoreEntry> {
  this.closedStores.delete(databaseId);

  // Wait for any in-flight close of this key to finish before deciding, so we never
  // observe (and increment the refCount of) a handle being torn down.
  const closing = this.pendingCloses.get(databaseId);
  if (closing) {
    await closing;
  }

  // ... existing logic unchanged: stores.get → cached; pendingOpens → wait;
  //     evict-if-full; openAndRestore + pendingOpens dedup.
}
```

After `await closing`, fall through to the existing cached/pending/open path — the entry
is gone from `this.stores`, so it re-opens a fresh handle (or joins a `pendingOpens` that
another acquire started). No further re-check needed: while an open is in flight the key
is absent from `this.stores`, so `cleanup`/`evictLRU` won't try to close it.

## Notes / secondary concern (do NOT expand scope)

- `shutdown()` (`store-manager.ts:269`) closes handles directly (not via `closeStore`)
  and does not consult `pendingCloses`. An `acquire()` racing `shutdown()` is a separate,
  pre-existing lifecycle gap and is **out of scope** for this bug. If it's a one-line
  guard (e.g. `acquire` rejects when `this._shuttingDown`), consider adding it; otherwise
  leave a `// NOTE:` at the acquire site and mention it in the review handoff rather than
  growing this ticket.
- Keep the `evictFromDisk` skip-if-reopened check (`store-manager.ts:393`) — it already
  consults `pendingOpens`; it does not need to consult `pendingCloses` because a store
  only enters `closedStores` after its close fully resolves.

## TODO

- [ ] Add a **deterministic** reproducing test to `store-manager.spec.ts` under a new
  `describe('close/acquire race')`. Recipe (no private access needed — patch the entry's
  `store.close` to block on a barrier, then race an acquire against a cleanup-driven close):
  - Configure a manager with `idleTimeoutMs: 0`, small `cleanupIntervalMs` (e.g. 20).
  - `const entry = await manager.acquire(id); manager.release(id);` (refCount → 0).
  - Replace `entry.store.close` with a wrapper that resolves a `closeStarted` promise, then
    awaits a `closeBarrier` promise, then calls the original close.
  - `await closeStarted` (cleanup has entered the close and is parked on the barrier).
  - Start `const acquireP = manager.acquire(id);` (the racing acquire).
  - Release the barrier; `const entry2 = await acquireP;`.
  - Assert the acquired handle is usable: `expect(entry2.store.isClosed()).to.be.false;`
    and `await entry2.store.get(new Uint8Array([1]))` resolves without throwing
    `"LevelDBStore is closed"`. (`isClosed()` / `get()` per
    `packages/quereus-plugin-leveldb/src/store.ts:86,165`.)
  - This test must FAIL on current `main` (returns the closed `entry`) and PASS after the fix
    (returns a fresh open handle). Verify the red state before applying the fix.
- [ ] Add `private readonly pendingCloses = new Map<string, Promise<void>>();` to
  `StoreManager`.
- [ ] Rewrite `closeStore` per the design above (synchronous retire + registered close promise).
- [ ] Add the `pendingCloses` wait at the top of `acquire`.
- [ ] Decide the `shutdown`/`acquire` secondary concern (guard or `NOTE:` + handoff line).
- [ ] `yarn workspace @quereus/sync-coordinator test 2>&1 | tee /tmp/sc-test.log; tail -n 60 /tmp/sc-test.log`
  (confirm existing StoreManager tests + new race test pass; watch the `pendingOpens dedup`
  and `LRU eviction` suites for regressions).
- [ ] `yarn lint` (only `packages/quereus` has a real lint; sync-coordinator is a no-op, but
  run from root to stay consistent).
- [ ] Update the `closeStore`/`acquire` doc comments to state the serialization invariant.
