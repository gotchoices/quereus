description: The browser IndexedDB storage plugin has four robustness bugs that make it behave differently from its LevelDB twin — it loads whole tables into memory, re-applies committed writes on batch reuse, gets permanently stuck after one failed open, and throws under concurrent table setup. Fix all four so the two backends behave identically.
prereq:
files:
  - packages/quereus-plugin-indexeddb/src/store.ts (iterate/collectEntries ~156-189; IndexedDBWriteBatch.write ~263-279; MultiStoreWriteBatch.write ~327-350)
  - packages/quereus-plugin-indexeddb/src/manager.ts (ensureOpen ~64-88; ensureObjectStore/doUpgrade ~191-261; deleteObjectStore ~266-333; renameObjectStores ~345-478)
  - packages/quereus-plugin-leveldb/src/store.ts (streaming reference: iterate ~111-135; batch write clears ops ~207-212)
  - packages/quereus-plugin-indexeddb/test/store.spec.ts (harness pattern for new store tests)
  - packages/quereus-plugin-indexeddb/test/manager.spec.ts (harness pattern for new manager tests)
difficulty: medium
----

## Summary

The IndexedDB and LevelDB storage plugins implement the same `KVStore` contract
(`@quereus/store`) and are meant to be drop-in interchangeable. Four bugs in the
IndexedDB path diverge from the LevelDB reference twin. All four confirmed by
reading current code against `packages/quereus-plugin-leveldb/src/store.ts`.

The tests use **mocha + chai + `fake-indexeddb/auto`** (see `package.json` script
`test` and existing `test/*.spec.ts`). Run: `yarn workspace @quereus/plugin-indexeddb test`.

---

## Bug (a) — `iterate` materializes the full result set

`store.ts` `iterate` (~156) delegates to `collectEntries` (~164) which walks the
cursor into a full `KVEntry[]` **before** yielding anything. Memory scales with
result size. LevelDB (`store.ts` ~111-135) streams: it yields directly from
`this.level.iterator(...)` one entry at a time.

**Fix direction — batched pagination, NOT a live cursor across yields.**

The naive fix (bridge one IDB cursor to an async generator, `continue()` per
`yield`) is a **trap**: an IndexedDB `readonly` transaction auto-commits as soon as
no request is pending and control returns to the microtask queue. If the iterate
consumer `await`s anything else between yields (the KVStore/isolation layer does —
e.g. `approximateCount` and isolation commit interleave store ops), the
transaction goes inactive and the next `cursor.continue()` throws
`TransactionInactiveError`. A single long-lived cursor cannot survive consumer
awaits.

Robust approach: read in **bounded batches**, each batch in its own short-lived
transaction, resuming from the last key seen.

- Pick a batch size (e.g. `const BATCH = 256`). Memory is bounded to one batch, not
  the whole range — that is what "streaming with bounded memory" requires here.
- For each batch: open a fresh `readonly` tx + cursor over the range, collect up to
  `BATCH` entries, remember the last key, close the batch (let tx commit), `yield`
  each entry.
- Start the next batch from just-after the last key: tighten the lower bound
  (forward) / upper bound (reverse) using an **exclusive** bound on the last key.
  Reuse `buildKeyRange` logic but override the resume edge — factor the range build
  so a resume key can replace the appropriate open end.
- Honor `options.limit` across batches (decrement a remaining counter; stop when
  hit). Honor `options.reverse` (direction `'prev'`, resume by tightening the upper
  bound instead of the lower).
- Keys/values are `ArrayBuffer` in the store; wrap in `Uint8Array` exactly as the
  current `collectEntries` does (lines 179-182).

Note the batch boundary at the exact site so a future reader understands the tx
lifetime constraint:
`// NOTE: one tx per batch — a single cursor can't survive consumer awaits (IDB auto-commits idle readonly tx → TransactionInactiveError).`

## Bug (b) — write batch not cleared after commit → double-apply

`IndexedDBWriteBatch.write` (~263) commits `this.ops` but never clears them.
Reusing the same batch handle for a second `write()` re-applies the first batch's
mutations. LevelDB (`store.ts` ~207-212) sets `this.ops = []` after a successful
`batch()`.

**Fix:** in `IndexedDBWriteBatch.write`, clear `this.ops = []` in the `oncomplete`
handler (after commit succeeds, before `resolve()`) — clear only on success, not on
error, matching LevelDB semantics.

`MultiStoreWriteBatch.write` (~327) has the **same** defect (no clear after commit).
It is IndexedDB-only (no LevelDB twin) but the `WriteBatch` contract is the same —
a committed batch must not re-apply on reuse. Clear `this.ops` and `this.storeNames`
in its `oncomplete` too. Quick-check callers (isolation atomic commit path) don't
rely on ops surviving `write()`; the reference contract says they must not.

## Bug (c) — a failed open is cached forever

`manager.ts` `ensureOpen` (~84):

```ts
this.openPromise = this.doOpen();
await this.openPromise;      // if doOpen rejects, throws here...
this.openPromise = null;     // ...so this never runs — rejected promise stays cached
return this.db!;
```

The waiter branch (~79-82) then `await`s that same rejected promise on every future
call → the store is permanently poisoned even after the transient cause clears.
(`getExistingDatabaseInfo` resolves `null` on error, but `openDatabase` can reject —
e.g. the 10s timeout or `request.onerror`.)

**Fix:** reset `openPromise` in a `finally` so a rejection clears it and a later call
retries:

```ts
this.openPromise = this.doOpen();
try {
  await this.openPromise;
} finally {
  this.openPromise = null;
}
return this.db!;
```

Waiters in the `if (this.openPromise)` branch still see the rejection propagate (good
— they surface the failure), and the next fresh call re-attempts.

## Bug (d) — racy upgrade serialization → `VersionError`

`ensureObjectStore` (~191), `deleteObjectStore` (~266), `renameObjectStores` (~345)
each guard with a single `if (this.upgradePromise) await this.upgradePromise;` then
set `this.upgradePromise = this.doX(...)`. That single check does **not** serialize:
two concurrent callers both pass the `if` (promise null), both `await ensureOpen()`
(yielding), both find their store missing, and both assign `upgradePromise` — the
second overwrites the first, and two `doUpgrade`s run concurrently. Each closes the
db, bumps `dbVersion`, and reopens → overlapping `onupgradeneeded` version
transitions → IndexedDB `VersionError`.

**Fix — serialize all schema mutations through one chained queue.** Add a tail-promise
mutex and route every version-changing op through it:

```ts
private schemaTail: Promise<void> = Promise.resolve();

/** Run a schema mutation serialized against all other schema mutations. */
private runSerialized<T>(fn: () => Promise<T>): Promise<T> {
  // chain regardless of prior outcome so one failure doesn't wedge the queue
  const run = this.schemaTail.then(fn, fn);
  // keep the tail alive but swallow so a rejection doesn't poison later ops
  this.schemaTail = run.then(() => {}, () => {});
  return run;
}
```

Then in each of the three methods, drop the `upgradePromise` dance and do:

```ts
async ensureObjectStore(storeName: string): Promise<void> {
  await this.ensureOpen();
  if (this.objectStores.has(storeName)) return;
  await this.runSerialized(async () => {
    if (this.objectStores.has(storeName)) return; // re-check: a queued peer may have created it
    await this.doUpgrade(storeName);
  });
}
```

Same shape for `deleteObjectStore` (re-check `!has` inside) and `renameObjectStores`
(move the filter/collision guard inside the serialized section so it sees committed
state). The inside-the-lock re-check prevents redundant version bumps when several
callers request the same store.

`ensureOpen` currently awaits `upgradePromise` (~70) to avoid returning `this.db`
mid-upgrade (`doUpgrade` sets `this.db = null` while reopening). Preserve that: have
`ensureOpen` `await this.schemaTail` before the `if (this.db) return this.db;` check
so an in-flight schema op finishes first. Confirm no deadlock — the `doX` methods
manipulate `this.db` directly and never call `ensureOpen`, so the serialized fn does
not re-enter the queue.

Remove the now-dead `upgradePromise` field and its `if (this.upgradePromise)` guards
once all three methods and `ensureOpen` use `schemaTail`.

---

## Expected outcome

No behavioral difference an interchangeable-store consumer can observe between the
IndexedDB and LevelDB backends for these paths: iteration streams with bounded
memory, a committed batch does not re-apply on reuse, a transient open failure
recovers on retry, and concurrent table setup does not throw `VersionError`.

## Reproduction / test skeletons

Add focused specs (harness: copy the `beforeEach`/`afterEach` reset pattern from
`test/store.spec.ts` and `test/manager.spec.ts` — `fake-indexeddb/auto`,
`IndexedDBManager.resetInstance` + `indexedDB.deleteDatabase` teardown).

- **(a)** Put more than one batch worth of keys (e.g. `BATCH + 50`), iterate the full
  range, assert every entry returned in order and count matches. To pin the
  streaming property, iterate and `await store.get(...)` a different key *inside* the
  `for await` loop — this exercises the cross-await tx boundary and would throw
  `TransactionInactiveError` under a naive single-cursor fix. Also assert `reverse`
  and `limit` still hold across the batch boundary.
- **(b)** `const b = store.batch(); b.put(k1,v1); await b.write();` then
  `b.put(k2,v2); await b.write();` and assert `k1` was written exactly once (delete
  `k1` between the two writes, then assert it's still absent after the second write).
  Add the mirror test for `MultiStoreWriteBatch`.
- **(c)** Force the first `doOpen` to fail (simplest: stub/monkeypatch `indexedDB.open`
  used by `openDatabase` to fire `onerror` once, or set `dbVersion` to trigger the
  timeout path with a shortened timeout), assert `ensureOpen()` rejects, restore, then
  assert a second `ensureOpen()` succeeds. Confirm `openPromise` is `null` after the
  failure.
- **(d)** `await Promise.all([...Array(N)].map((_,i) => manager.ensureObjectStore('t'+i)))`
  triggering N concurrent upgrades; assert it resolves with no `VersionError` and all
  N stores exist. Add an N-same-name variant asserting exactly one version bump.

## TODO

- [ ] Rewrite `iterate`/`collectEntries` in `store.ts` as bounded batched pagination
      (own tx per batch, resume by exclusive bound on last key, honor limit+reverse);
      add the `NOTE:` tripwire comment about the per-batch tx lifetime.
- [ ] Clear `this.ops` on `oncomplete` in `IndexedDBWriteBatch.write`; clear
      `this.ops`+`this.storeNames` on `oncomplete` in `MultiStoreWriteBatch.write`.
- [ ] Wrap `ensureOpen`'s `openPromise` await in `try/finally` so failed opens don't
      cache.
- [ ] Add `schemaTail` + `runSerialized`; route `ensureObjectStore`,
      `deleteObjectStore`, `renameObjectStores` through it with an inside-lock
      re-check; make `ensureOpen` await `schemaTail`; remove dead `upgradePromise`.
- [ ] Add the four specs above.
- [ ] `yarn workspace @quereus/plugin-indexeddb test` green; `yarn workspace
      @quereus/plugin-indexeddb typecheck` clean.

## Related — shared conformance suite (cross-reference, do not build here)

These bugs existed because "the two stores behave identically" was asserted only in
prose, never tested. A shared `KVStore` conformance suite run against LevelDB,
IndexedDB, and the in-memory store would have caught (a)-(d). That suite is scoped
separately in `test-kvstore-conformance-suite`. This ticket fixes the concrete bugs
and adds targeted regression specs; it is intentionally **not** gated on the suite
(the fixes shouldn't wait). When the suite lands it should subsume these specs.
