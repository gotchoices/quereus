description: Fixed and reviewed a race where the sync coordinator could hand out a database handle while another task was closing it; an acquire now always gets a live, open database.
files:
  - packages/sync-coordinator/src/service/store-manager.ts   # acquire / closeStore / pendingCloses
  - packages/sync-coordinator/test/store-manager.spec.ts      # close/acquire + LRU-evict race repros
difficulty: medium
----

## What was wrong

`StoreManager` pools per-database `LevelDBStore` handles in `this.stores`. Idle cleanup
(`cleanup` → `closeStore`) and LRU pressure (`evictLRU` → `closeStore`) close handles.
The old `closeStore` awaited `entry.store.close()` **first** and did
`this.stores.delete(databaseId)` **after**, leaving the entry visible in `this.stores`
for the whole async close. A concurrent `acquire()` landing in that window found the
entry, did `refCount++`, and returned a handle whose `close()` had run — the caller then
hit `"LevelDBStore is closed"` on the next `get`/`put`/`batch`. The pre-existing
`refCount > 0` guard did not help: it runs in `closeStore`'s sync prelude, before the
racing `acquire`'s `refCount++`.

## The fix (implement stage)

`store-manager.ts`:
- New field `pendingCloses: Map<string, Promise<void>>` mirroring `pendingOpens`.
- `closeStore` rewritten so the close decision, `this.stores.delete`, the sync
  `resolveStoragePath`, the close-IIFE kickoff, and `pendingCloses.set` all run in ONE
  synchronous tick — no await between the `refCount` guard and the register. JS
  single-threading makes that section atomic vs. a racing acquire; the `finally` removes
  the `pendingCloses` entry.
- `acquire` awaits `pendingCloses.get(id)` (if present) after the shutdown guard, before
  touching `this.stores`. After the close resolves it opens a **fresh** handle — correct
  for LevelDB's single-open lock.
- Added a `_shuttingDown` guard to `acquire` (throws when shutdown has begun).

## Review findings

**Scope reviewed:** the full `store-manager.ts` (not only the diff) — `acquire`,
`closeStore`, `cleanup`, `evictLRU`, `evictFromDisk`, `shutdown`, `openAndRestore`, plus
their concurrency interactions; the new + existing tests; and a doc sweep of the
sync-coordinator package.

**Correctness — CONFIRMED sound.** Verified the serialization invariant by hand: in
`closeStore` the span `stores.delete → resolveStoragePath → (async IIFE start) →
pendingCloses.set` contains no `await`, so it is one atomic tick; the IIFE only yields at
`await entry.store.close()`, by which point `pendingCloses` is already registered. A
racing `acquire` therefore either (a) bumped `refCount` first, so `closeStore`'s guard
bails and the entry stays live, or (b) runs after, finds no entry, awaits
`pendingCloses`, and reopens fresh. Double-close is prevented because the sync
`stores.delete` makes a second `closeStore(id)` short-circuit on the missing entry. The
`evictLRU` trigger routes through the same `closeStore`, so it is covered too.

**Tests — added coverage (minor, fixed in this pass).** The implementer shipped one
deterministic barrier test for the *cleanup*-driven race. I added a sibling
`acquire of an LRU-evicted key racing its eviction returns a live handle` that drives the
close from **inside** `acquire` via `maxOpenStores: 1` (a distinct trigger and call
stack, no cleanup timer). I verified **both** race tests go red against the old
`delete-after-await` body (`AssertionError: expected true to be false` at the
`isClosed()` checks) and green with the fix — so they bite, not just pass. Suite now
**128 passing** (was 127).

**Docs — checked, nothing to update.** No `docs/` file or README references
`StoreManager`, `closeStore`, `acquire`, or the store lifecycle (grep + semantic search);
this is an internal concurrency fix with no doc-facing surface.

**Lint — clean.** `yarn lint` exit 0 (quereus eslint + `tsc -p tsconfig.test.json`, which
type-checks the spec call sites; every other package is an intentional no-op).

### Tripwires (parked, not tickets)

- **shutdown/acquire is best-effort.** The `_shuttingDown` guard only checks at
  `acquire` entry; the awaits below (`pendingCloses`, `evictLRU`, `openAndRestore`) can
  yield to a `shutdown()` that flips the flag mid-acquire, so a handle could still be
  opened after teardown began. Harmless today — no caller acquires concurrently with
  shutdown. Recorded as a `NOTE:` at the guard site in `store-manager.ts` (acquire).
- **`resolveStoragePath` between `stores.delete` and the close register.** If a *custom*
  hook threw there, the entry would be gone from `stores` but never closed (handle leak).
  The default hook can't throw and the old code called it before its `await` too, so this
  is not a new risk — flagged only for a future custom-hook author.
- **`shutdown` does not await `pendingCloses`.** An in-flight `closeStore` already removed
  its entry from `stores`, so `shutdown`'s `Array.from(this.stores.entries())` won't
  double-close it, but `shutdown` may resolve while that close is still finishing. The
  handle still closes via its own promise; no leak. Only matters if a future caller needs
  a hard "everything closed" barrier at shutdown.

**No major findings — no new tickets filed.** Everything found was minor (fixed inline)
or conditional (tripwire).
