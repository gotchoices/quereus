description: Review the four robustness fixes that bring the browser IndexedDB storage plugin in line with its LevelDB twin — streaming iteration, batch-reuse safety, failed-open recovery, and serialized concurrent table setup.
prereq:
files:
  - packages/quereus-plugin-indexeddb/src/store.ts (iterate/readBatch/rangeBounds/buildKeyRange; IndexedDBWriteBatch.write; MultiStoreWriteBatch.write)
  - packages/quereus-plugin-indexeddb/src/manager.ts (ensureOpen; runSerialized/schemaTail; ensureObjectStore; deleteObjectStore; renameObjectStores)
  - packages/quereus-plugin-indexeddb/src/provider.ts (IndexedDBAtomicBatch.write comment)
  - packages/quereus-plugin-indexeddb/test/store.spec.ts (streaming + batch-reuse specs; adjusted race test)
  - packages/quereus-plugin-indexeddb/test/manager.spec.ts (failed-open + concurrent-schema specs)
  - packages/quereus-plugin-leveldb/src/store.ts (reference twin)
difficulty: medium
----

## What was implemented

Four divergences between the IndexedDB `KVStore` and its LevelDB reference twin,
all fixed in the IndexedDB plugin. Both backends implement the same `@quereus/store`
`KVStore` contract and are meant to be drop-in interchangeable.

**Validate with:** `yarn workspace @quereus/plugin-indexeddb test` (mocha + chai +
`fake-indexeddb/auto`) and `yarn workspace @quereus/plugin-indexeddb typecheck`.
Both green as of handoff (84 passing).

### (a) `iterate` now streams in bounded batches

`store.ts` `iterate` previously materialized the whole result set into a
`KVEntry[]` before yielding (old `collectEntries`). Rewrote it as **batched
pagination**: `readBatch` reads up to `BATCH` (256) entries in its own short-lived
readonly transaction, `iterate` yields them, then resumes from the last key seen
via an **exclusive** bound (forward → tighten lower bound; reverse → tighten upper
bound). Memory is bounded to one batch, not the whole range.

Why not a single long-lived cursor: an IDB readonly transaction auto-commits once
no request is pending and control returns to the microtask queue. The KVStore /
isolation consumer awaits other store ops between yields, so a single cursor would
throw `TransactionInactiveError` on the next `continue()`. The one-tx-per-batch
design is documented in a `NOTE:` at the loop site (`store.ts` ~182).

Range-building was refactored: `rangeBounds` derives independent lower/upper
`KeyBound`s from the iterate options; `makeKeyRange` turns bounds into an
`IDBKeyRange`. `buildKeyRange` (still used by `approximateCount`) now delegates to
these, so count and iterate share one range definition.

### (b) Write batches clear their ops after a successful commit

`IndexedDBWriteBatch.write` and `MultiStoreWriteBatch.write` committed `this.ops`
but never cleared them, so reusing the same batch handle for a second `write()`
re-applied the first batch's mutations (LevelDB clears ops after a successful
`batch()`). Both now clear in `oncomplete` (on success only, before `resolve()`) —
`IndexedDBWriteBatch` clears `this.ops`; `MultiStoreWriteBatch` clears `this.ops`
and `this.storeNames`.

Follow-on: `provider.ts` `IndexedDBAtomicBatch.write` already captures store names
*before* `write()` for post-write cache invalidation; its stale "clears nothing on
write" comment was corrected (the capture-before is now genuinely required).

### (c) A failed open no longer poisons the manager forever

`manager.ts` `ensureOpen` set `this.openPromise = this.doOpen()`, awaited it, then
`this.openPromise = null` — but on rejection the reset line never ran, so the
rejected promise stayed cached and every future call replayed the failure. Wrapped
the await in `try/finally` so a failure clears `openPromise` and a later call
retries. (`openDatabase` can reject via the 10s timeout or `request.onerror`.)

### (d) Concurrent table setup no longer throws `VersionError`

`ensureObjectStore`, `deleteObjectStore`, `renameObjectStores` each used a single
`if (this.upgradePromise) await …; this.upgradePromise = this.doX(…)` guard that did
**not** serialize: two concurrent callers both passed the null-check, both ran a
version-bumping upgrade, and the overlapping `onupgradeneeded` transitions threw
`VersionError`. Replaced with a single chained-tail mutex: `schemaTail` +
`runSerialized(fn)` routes every version-changing op through one queue (chained on
both fulfil and reject so one failure doesn't wedge the queue). Each method does an
**inside-the-lock re-check** (`has` / `!has` / filter+collision guard) so queued
peers requesting the same store don't cause redundant version bumps. `ensureOpen`
awaits `schemaTail` before returning `this.db` so it never hands back a handle
mid-upgrade. The dead `upgradePromise` field and its guards were removed.

## Tests added (regression floor — treat as a floor, not a ceiling)

- `store.spec.ts` › **Iteration across batch boundaries** — 306 keys (> one 256
  batch): full-range order + count; a cross-await `store.get()` *inside* the
  `for await` loop (this is the assertion that would throw `TransactionInactiveError`
  under a naive single-cursor fix); reverse across the boundary; limit spanning the
  boundary.
- `store.spec.ts` › **Batch reuse after commit** — reuse an `IndexedDBWriteBatch`
  and a `MultiStoreWriteBatch` after `write()`, deleting the first key in between,
  and assert it is not resurrected by the second write.
- `manager.spec.ts` › **Failed open recovery** — monkeypatch `indexedDB.open` to
  fire `onerror`, assert `ensureOpen()` rejects and `openPromise` is `null`
  afterward, restore, assert a fresh `ensureOpen()` succeeds.
- `manager.spec.ts` › **Concurrent schema mutations** — N concurrent distinct
  `ensureObjectStore` calls resolve with no `VersionError` and all stores exist; N
  concurrent same-name calls bump the version exactly once.

## Reviewer attention / known gaps

1. **Adjusted existing race test — verify the change is faithful, not a paper-over.**
   `store.spec.ts` › "should complete write batch during a concurrent version
   upgrade" previously used a single `await Promise.resolve()` calibrated to the old
   microtask count. The new `ensureOpen` adds one `await schemaTail` hop, which
   shifted the timing and made the write land in a pre-enqueue window and capture a
   db handle that `doUpgrade` then closed → `InvalidStateError`. Rewrote the setup to
   **poll the public `getDatabase()` until it returns `null`** (the observable
   "upgrade in flight" state, bounded to 50 ticks so it can't spin) before firing the
   write. All assertions are unchanged. Confirm this still genuinely exercises
   write-during-in-flight-upgrade and isn't accidentally serializing.

2. **Tripwire — residual data-write-vs-DDL race (parked as a `NOTE:`, not a ticket).**
   `ensureOpen` only waits for schema ops enqueued *before* it is called. A schema
   mutation enqueued in the microtask gap between `ensureOpen`'s await resolving and
   the caller building its transaction can still close the returned handle. IDB
   `close()` defers to already-open transactions, so the common concurrent case
   survives (verified: concurrent-fire ordering creates the write tx before
   `doUpgrade` closes). This is pre-existing and conditional — documented as a `NOTE:`
   at `manager.ts` ensureOpen (~line 84). If data-write-vs-DDL interleaving ever
   surfaces `InvalidStateError` in practice, the write path should retry on a closed
   handle. Not filed as a ticket per tripwire rules.

3. **Tripwire — batch size (BATCH = 256, `store.ts`).** Fixed constant; bounds
   memory per iterate batch but also caps entries-per-transaction. Fine now; if
   iteration over very large ranges shows overhead from many short-lived
   transactions, this is the knob. Documented at the constant.

4. **Range-build edge case.** `rangeBounds` derives lower/upper independently
   (prefers gte over gt, lte over lt). If a caller passes *both* `lte` and `lt` (or
   both `gte` and `gt`) the chosen precedence may differ from the old
   `buildKeyRange`'s branch order. These are degenerate/contradictory inputs not
   expected from the KVStore contract; worth a glance but low-risk.

5. **`fake-indexeddb` fidelity.** All tests run against `fake-indexeddb/auto`, not a
   real browser IDB. The auto-commit-idle-tx behavior that motivates fix (a), and
   the `close()`-defers-to-open-tx behavior that fix (d)'s race test leans on, are
   spec behaviors that fake-indexeddb models — but a real-browser smoke test of large
   iteration and concurrent DDL would harden confidence beyond the fake.

## Not done here (intentional)

A shared `KVStore` conformance suite run against LevelDB, IndexedDB, and the
in-memory store would have caught all four divergences structurally. It is scoped
separately in `test-kvstore-conformance-suite` and this ticket is **not** gated on
it — the fixes shouldn't wait. When that suite lands it should subsume these
targeted regression specs.
