description: Verified the fix that forces the materialized-view clean-shutdown marker's deletion to disk before any new writes, so a crash can no longer make the database trust stale data on reopen.
prereq:
files:
  - packages/quereus-store/src/common/kv-store.ts                 # WriteOptions; put/delete optional 3rd arg
  - packages/quereus-store/src/common/index.ts                    # exports WriteOptions
  - packages/quereus-store/src/common/memory-store.ts             # put/delete accept (no-op) WriteOptions
  - packages/quereus-store/src/common/cached-kv-store.ts          # put/delete forward WriteOptions (defensive)
  - packages/quereus-store/src/common/store-module.ts             # consumeCleanShutdownMarker delete(..., { sync: true })
  - packages/quereus-plugin-leveldb/src/store.ts                  # put/del forward { sync } to classic-level
  - packages/quereus-plugin-indexeddb/src/store.ts                # openWriteTx: durability:'strict' defensively
  - docs/materialized-views.md                                    # § Cross-module atomicity: gate-5 + caveat
  - packages/quereus-store/test/marker-durability.spec.ts         # consume-delete fires once, sync:true, trust resolves
  - packages/quereus-store/test/memory-store.spec.ts              # put/delete accept+ignore sync hint
  - packages/quereus-plugin-leveldb/test/store.spec.ts            # put/delete forward sync without error
  - packages/quereus-plugin-indexeddb/test/store.spec.ts          # sync hint honored defensively
difficulty: medium
----

# Complete: clean-shutdown marker durability (synced consume-delete)

## What landed

The MV adopt fast path trusts a single-use `\x00meta\x00clean_shutdown` catalog
marker that `rehydrateCatalog` reads then deletes (`consumeCleanShutdownMarker`).
That consume-delete was a plain **unsynced** `catalogStore.delete`, landing in a
*different* KV store from the session's subsequent data writes with independent
flushing. A power loss could persist mid-session data writes while losing the
marker delete; the next open then found a resurrected marker, attested a clean
shutdown that never happened, and adopted a backing across a real crash window.

The fix introduces a per-write durability hint and uses it on the consume-delete:

- **New `WriteOptions { sync?: boolean }`** on the `KVStore` point-write surface
  (`put`/`delete` gained an optional trailing 3rd arg). Exported from `@quereus/store`.
- **`consumeCleanShutdownMarker`** issues `delete(markerKey, { sync: true })`.
  Because rehydrate runs at open, the synced delete resolves (post-fsync) before
  any session data write is issued — the ordering holds by program order, without
  needing cross-store coordination.
- **Per backend:** LevelDB fsyncs via `db.del(k, { sync })`; IndexedDB requests
  `durability: 'strict'` (defensive try/catch falls back to the plain tx whose
  `oncomplete` is already the real durability boundary); in-memory no-ops;
  CachedKVStore forwards the hint. Mobile backends (nativescript-sqlite,
  rn-leveldb) keep 2-arg signatures that structurally satisfy the widened
  interface and silently ignore the hint (documented best-effort).
- **Close-side marker WRITE left unsynced** by design (losing it is conservative —
  next open refills).
- **Docs** (`materialized-views.md` § Cross-module atomicity) updated: gate-5 + the
  power-loss caveat now describe the synced consume-delete; both references point
  at the subsuming backlog ticket `store-module-wide-atomic-commit`.

## Review findings

Adversarial pass over commit `35613f01`. Read the full diff with fresh eyes before
the handoff summary.

### Checked — and clean

- **Durability ordering soundness.** The fix's core claim — "marker delete durable
  before any session data write becomes durable" — is sound. `consumeCleanShutdownMarker`
  runs inside `rehydrateCatalog` at module open, so the awaited synced delete
  completes (after fsync / strict-durability commit) before any new-session write
  is issued. No cross-store flush coordination is required; program order plus a
  durable delete suffices. Confirmed against both store topologies (LevelDB:
  per-table separate databases; IndexedDB: one DB, multiple object stores).
- **Single-use ordering preserved.** The delete remains unconditional and sequenced
  before the JSON parse — a malformed payload still consumes the marker.
- **Full implementer coverage.** Searched every `implements KVStore` — 5 backends
  (memory, cached, leveldb, indexeddb, nativescript-sqlite, rn-leveldb). All
  compile against the widened interface; the four point-write backends behave per
  the hint, the two mobile backends no-op it.
- **Type safety / no signature breakage.** Built `@quereus/plugin-nativescript-sqlite`
  and `@quereus/plugin-react-native-leveldb` directly — both clean, confirming the
  structural-assignability claim (a 2-arg method satisfies a 3-arg-optional interface).
- **CachedKVStore forwarding is correctly characterized as defensive, not
  load-bearing.** Verified the catalog store is never wrapped in a cache in current
  providers: LevelDBProvider has no cache layer; IndexedDBProvider wraps only
  data/index stores (`getOrCreateStore`), and `getCatalogStore` returns a raw
  `IndexedDBStore`. So the marker delete reaches a sync-honoring store today; the
  forwarding only matters if a future provider caches the catalog. Untested, but
  trivially correct and not on the live path — acceptable.
- **Docs reflect reality.** Both slug references resolve to the existing backlog
  ticket `tickets/backlog/store-module-wide-atomic-commit.md`; caveat wording
  (LevelDB fsync, IDB strict) matches the code.
- **Tests prove the meaningful behavior.** `marker-durability.spec.ts` asserts the
  store-module call site passes `sync: true` exactly once on the marker key, that
  the marker is consumed, and that trust still resolves (sentinel-survives-→-adopt
  vs absent-marker-→-refill). Per-backend cases assert the hint is accepted and
  writes/deletes still take effect.

### Validation run (all green)

- `yarn workspace @quereus/quereus lint` — clean (eslint + test typecheck).
- `yarn workspace @quereus/store test` — 627 passing.
- `yarn workspace @quereus/plugin-leveldb test` — 18 passing.
- `yarn workspace @quereus/plugin-indexeddb test` — 63 passing.
- `yarn test` (full monorepo) — 6330 core + all workspaces passing, exit 0.
  (The `Error: boom` / `batch write failed` / `iterate failed` console lines are
  intentional negative-path fixtures, not failures.)

### Minor observations (no action taken)

- **Per-write object allocation on the LevelDB hot path.** `put`/`delete` now build
  `{ sync: options?.sync }` on every call, even though only the single marker delete
  ever sets `sync`. The overhead is negligible (abstract-level already merges an
  options object) and not worth a code change; recorded for completeness.

### Not in scope (correctly deferred)

- **The crash itself is not reproduced.** Tests assert the hint is passed and
  forwarded per backend, not a real fsync/disk flush — those are backend properties,
  not unit-observable. Honest floor; flagged by the implementer.
- **The subsuming fix** (provider-level atomic multi-store commit domain that would
  let adopt drop gate 5 entirely) remains parked in backlog
  `store-module-wide-atomic-commit`.

**Disposition:** no major findings (no new tickets filed); no minor findings
requiring an inline fix. The implementation is correct, minimal, and well-documented.
