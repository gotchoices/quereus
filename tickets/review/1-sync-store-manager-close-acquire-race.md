description: Verify the fix that stops the sync coordinator from handing out a database handle while another task is closing it — an acquire now always gets a live, open database.
files:
  - packages/sync-coordinator/src/service/store-manager.ts   # acquire / closeStore / pendingCloses
  - packages/sync-coordinator/test/store-manager.spec.ts      # close/acquire race repro
difficulty: medium
----

## What was wrong

`StoreManager` pools per-database `LevelDBStore` handles in `this.stores`. Idle
cleanup (`cleanup` → `closeStore`) and LRU pressure (`evictLRU` → `closeStore`) close
handles. The old `closeStore` did `await entry.store.close()` **first** and
`this.stores.delete(databaseId)` **after**, so the entry stayed visible in `this.stores`
for the entire duration of the async close. A concurrent `acquire()` landing in that
window found the entry, did `refCount++`, and returned a handle whose `close()` had run
(or was running) — the caller then hit `"LevelDBStore is closed"` on the next
`get`/`put`/`batch`. The pre-existing `refCount > 0` guard did not help: it runs in
`closeStore`'s sync prelude, before the racing `acquire`'s `refCount++`.

## What changed (the fix)

`store-manager.ts`:
- New field `pendingCloses: Map<string, Promise<void>>` mirroring `pendingOpens`.
- `closeStore` rewritten so the close decision + `this.stores.delete` happen in ONE
  synchronous section (no await between the `refCount` guard and the delete). It then
  registers the in-flight close in `pendingCloses` **before** awaiting `close()`, and
  removes it in a `finally`. JS single-threading makes that section atomic vs. a racing
  acquire — whichever sync section wins is safe (details in the closeStore doc comment).
- `acquire` awaits `pendingCloses.get(id)` (if present) right after the shutdown guard,
  before touching `this.stores`. After the close resolves it falls through to the normal
  cached/pending/open path and opens a **fresh** handle — correct for LevelDB's
  single-open lock, since the old handle is fully closed first.
- **Secondary concern decision (shutdown/acquire):** added a one-line guard — `acquire`
  now throws `"...StoreManager is shutting down"` when `_shuttingDown` is set. The ticket
  flagged this as optional; it was a clean one-liner so I took it rather than leaving a
  NOTE. No existing test acquires after shutdown, so nothing regressed.

## How to validate

- `yarn workspace @quereus/sync-coordinator test` → **127 passing** (was 126 + 1 new).
- `yarn lint` from root → clean (quereus eslint + `tsc -p tsconfig.test.json` ran ~35s;
  every other package is an intentional `No lint configured` no-op).

### The new test — and proof it bites

`test/store-manager.spec.ts` → `describe('close/acquire race')`. It parks
`store.close()` on a barrier so a racing `acquire` is *guaranteed* to run mid-close
(deterministic — no timing luck), then asserts the acquired handle
`isClosed() === false` and that `get()` does not throw.

I verified the **red state**: temporarily restoring the old `delete-after-await`
`closeStore` body made the test fail with `AssertionError: expected true to be false`
at the `isClosed()` check (the handle came back closed). Restoring the fix → green.
So the test genuinely catches the regression, not just the happy path.

## Known gaps / where to push (treat tests as a floor)

- **Only the cleanup-driven race is directly tested.** The `evictLRU`-driven variant
  (a concurrent `acquire(victimId)` racing the eviction of that same key) goes through
  the *same* `closeStore`, so the fix covers it — but there is **no separate test** that
  drives the eviction path specifically. A reviewer wanting belt-and-suspenders could add
  one with `maxOpenStores: 1`: acquire `db-a`, release, patch its `close` on a barrier,
  `acquire('db-b')` to trigger eviction of `db-a`, then race `acquire('db-a')`.
- **Only one of the two safe branches is exercised.** The test drives the "closeStore's
  sync section wins → acquire waits on `pendingCloses` and reopens" branch. The mirror
  branch ("acquire's sync section wins → `refCount++` → closeStore's guard bails, entry
  stays live") is covered indirectly by the existing LRU/cleanup suites but not asserted
  head-on. Consider an explicit assertion that the SAME entry object survives.
- **`resolveStoragePath` between delete and register.** `closeStore` now does
  `stores.delete` then calls the (synchronous) `resolveStoragePath` hook before building
  the close promise. If a *custom* hook threw there, the entry would be removed from
  `stores` but never closed (handle leak). The default hook can't throw, and the old code
  called `resolveStoragePath` before its `await` too, so this is not a new risk — noting
  it only so a future custom-hook author is aware.
- Not load/stress-tested under real concurrency; the guarantee rests on the
  single-threaded-atomicity argument in the doc comment plus the deterministic barrier
  test, not on fuzzing.

## Review findings

- **Secondary concern resolved inline (not deferred):** added a `_shuttingDown` guard to
  `acquire` (throws on acquire-after-shutdown-start) instead of leaving a NOTE. Confirm
  this is the desired behavior vs. silently returning — no caller currently acquires
  post-shutdown, so it's latent.
- **Tripwire (parked, not a ticket):** `evictLRU`-driven race shares `closeStore` so the
  fix covers it, but only the cleanup path has a dedicated repro test — see "Known gaps".
  If the eviction path ever regresses independently, add the `maxOpenStores: 1` test above.
