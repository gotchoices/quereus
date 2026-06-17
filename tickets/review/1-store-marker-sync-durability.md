description: Verify the fix that forces the materialized-view clean-shutdown marker's deletion to disk before any new writes, so a crash can no longer make the database trust stale data on reopen.
prereq:
files:
  - packages/quereus-store/src/common/kv-store.ts                 # NEW WriteOptions; put/delete optional 3rd arg
  - packages/quereus-store/src/common/index.ts                    # exports WriteOptions
  - packages/quereus-store/src/common/memory-store.ts             # put/delete accept (no-op) WriteOptions
  - packages/quereus-store/src/common/cached-kv-store.ts          # put/delete FORWARD WriteOptions
  - packages/quereus-store/src/common/store-module.ts             # consumeCleanShutdownMarker delete(..., { sync: true }) (~line 2155)
  - packages/quereus-plugin-leveldb/src/store.ts                  # put/del forward { sync } to classic-level
  - packages/quereus-plugin-indexeddb/src/store.ts                # openWriteTx: durability:'strict' defensively
  - docs/materialized-views.md                                    # § Cross-module atomicity: gate-5 + caveat updated (~line 116, 120)
  - packages/quereus-store/test/marker-durability.spec.ts         # NEW: consume-delete fires once, sync:true, trust still resolves
  - packages/quereus-store/test/memory-store.spec.ts              # NEW case: put/delete accept+ignore sync hint
  - packages/quereus-plugin-leveldb/test/store.spec.ts            # NEW case: put/delete forward sync without error
  - packages/quereus-plugin-indexeddb/test/store.spec.ts          # NEW case: sync hint honored defensively
difficulty: medium
----

# Review: clean-shutdown marker durability (synced consume-delete)

## What this fixes

The MV adopt fast path trusts a single-use `\x00meta\x00clean_shutdown` catalog
marker: `rehydrateCatalog` reads it then deletes it (`consumeCleanShutdownMarker`,
`store-module.ts`). That delete was a plain **unsynced** `catalogStore.delete`,
landing in a *different* KV store from the session's subsequent data writes, with
independent flushing. A **power loss** could persist mid-session data writes while
losing the marker delete; the next open then finds a resurrected marker, attests a
clean shutdown that never happened, and adopts a backing across a real crash window
— and it never self-heals (each clean close re-arms the marker). Process kills are
safe (OS-buffered writes survive); only power loss was exposed.

**Invariant restored:** the marker-consume delete must be durable before any of the
session's data writes can become durable.

## What changed

- **New `WriteOptions { sync?: boolean }`** on the `KVStore` point-write surface.
  `put`/`delete` gained an optional **trailing** 3rd arg `options?: WriteOptions`
  (interface + every implementer). Exported from `@quereus/store` index.
- **Backend behavior**
  - **LevelDB** (`store.ts`): `db.put(k,v,{ sync })` / `db.del(k,{ sync })` —
    classic-level forwards `sync` and fsyncs the log before resolving. `sync` is
    `boolean | undefined`, so passing `options?.sync` type-checks directly.
  - **IndexedDB** (`store.ts`): new private `openWriteTx(db, durable)` helper. When
    `durable`, it opens the readwrite tx with `{ durability: 'strict' }`, **wrapped
    in try/catch** so an engine that rejects the options bag falls back to the plain
    tx (whose `oncomplete` await is already the real IDB durability boundary — so
    `sync` is belt-and-suspenders for IDB).
  - **InMemoryKVStore**: accepts `_options` and no-ops (no crash window).
  - **CachedKVStore**: **forwards** `options` to the wrapped store on put/delete
    (so the hint is not silently dropped if a cached store is ever marker-bearing).
- **`consumeCleanShutdownMarker`**: `delete(markerKey, { sync: true })`. Delete
  still happens before the catalog scan and is still unconditional regardless of
  payload parse outcome (single-use ordering preserved).
- **Close-side marker WRITE left unsynced** (`closeAll`, `store-module.ts` ~2467) —
  by design: losing it is conservative (next open refills).
- **Docs** (`materialized-views.md` § Cross-module atomicity): gate-5 trailing
  sentence + the "Marker durability under power loss" caveat updated to say the
  synced consume-delete closes the window; the subsuming atomic-multi-store-commit
  domain is correctly attributed to backlog **`store-module-wide-atomic-commit`**
  (the doc previously pointed at the parent plan slug `store-atomic-multi-store-commit`).

## How to validate

- Build (type-checks the optional-arg signature across **all** store consumers):
  `yarn build` — **clean** (whole monorepo: store, isolation, sync, both leveldb
  plugins, nativescript-sqlite, web, vscode).
- Lint/test-typecheck call sites: `yarn workspace @quereus/quereus lint` — clean.
- Tests run and green:
  - `yarn workspace @quereus/store test` → 627 passing (incl. new `marker-durability.spec.ts`).
  - `yarn workspace @quereus/plugin-leveldb test` → 18 passing.
  - `yarn workspace @quereus/plugin-indexeddb test` → 63 passing.
  - Full `yarn test` (memory, all workspaces) → 6330 core + all others passing, exit 0.

### Test intent (what the new tests actually prove)

- `marker-durability.spec.ts` (store): a persistent in-memory provider whose
  **catalog store is a spy** recording every `delete` + its `sync` flag.
  - *present marker* → exactly **one** marker-key delete, carrying `sync: true`;
    marker consumed; sentinel row planted in the backing survives → **adopt** (trust
    still resolves correctly with the new arg).
  - *absent marker* (flushed without a clean close) → **zero** consume-deletes; the
    backing refills (sentinel scrubbed) → no-trust path unaffected.
- Per-backend unit cases assert `put`/`delete` **accept** the hint and still behave:
  memory no-ops it; LevelDB forwards `{ sync: true }` without error and persists;
  IndexedDB honors it defensively under fake-indexeddb.

## Known gaps / honest flags for the reviewer

- **The mechanism is tested, not the crash.** Power loss is not reproducible in CI.
  Tests assert the durability *hint is passed and forwarded per backend*, plus
  exactly-once consume-delete and correct trust resolution. They do **not** observe
  a real `fsync` (LevelDB) or a real disk flush (IDB) — those are properties of the
  backend, not unit-observable. Treat the tests as the floor.
- **IndexedDB durability is best-effort/belt-and-suspenders.** Real IDB durability
  is the `oncomplete` boundary; `durability: 'strict'` only *strengthens* the flush
  where the engine supports it. fake-indexeddb in the test likely ignores or accepts
  the options bag — either way the defensive try/catch keeps the default path
  correct. A reviewer wanting more could assert the helper requests strict
  durability when available (spy on `db.transaction`), but that pins fake-idb
  behavior, not real durability.
- **Mobile backends not extended (intentional, in scope as "no-op").** `SQLiteStore`
  (nativescript) and `ReactNativeLevelDBStore` were **not** changed: their 2-arg
  `put`/`delete` remain type-assignable to the widened interface and silently ignore
  the hint. rn-leveldb is LevelDB-based and *could* honor `sync` if its binding were
  extended — it currently does **not** (documented best-effort). Confirm this matches
  the ticket's "any backend without a sync knob must silently no-op, never throw".
- **No-signature-breakage relies on TS structural assignability** (a 2-arg method
  satisfies a 3-arg-optional interface). Verified by the full `yarn build`; worth a
  glance if the reviewer is wary of that rule.
- **Residual position unchanged:** even a synced consume-delete is subsumed by a
  provider-level atomic multi-store commit domain — still parked in backlog
  `store-module-wide-atomic-commit`. Not in scope here.
