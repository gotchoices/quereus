description: A single shared behavioral test suite now runs the same checks against all three storage backends (in-memory, LevelDB, IndexedDB), so any future drift between them fails a test instead of reaching users.
prereq:
files:
  - packages/quereus-store/src/testing/kv-conformance.ts (NEW — the shared suite: KVBackend adapter interface + runKVStoreConformance + all 6 tiers)
  - packages/quereus-store/package.json (NEW ./testing subpath export + typesVersions)
  - packages/quereus-store/src/common/memory-store.ts (fix: get/iterate now return copies; NOTE tripwire on per-entry copy)
  - packages/quereus-store/test/kv-conformance.spec.ts (NEW — memory backend adapter)
  - packages/quereus-plugin-leveldb/test/conformance.spec.ts (NEW — LevelDB adapter)
  - packages/quereus-plugin-indexeddb/test/conformance.spec.ts (NEW — IndexedDB adapter)
  - packages/quereus-store/test/memory-store.spec.ts (trimmed to InMemoryKVStore-specific clear/size)
  - packages/quereus-plugin-leveldb/test/store.spec.ts (DELETED — fully subsumed by the suite)
  - packages/quereus-plugin-indexeddb/test/store.spec.ts (trimmed; kept concurrent-upgrade + MultiStoreWriteBatch)
difficulty: medium
----

## What landed

One **KVStore conformance suite** — a single parameterized battery of behavioral
tests written against the `KVStore` contract (not against any one backend) — invoked
once per backend. Each backend supplies only a tiny lifecycle *adapter* (`open` /
optional `reopen` / `teardown`); the shared suite supplies every assertion. A behavior
that drifts on one backend now fails the suite instead of silently diverging.

- Suite: `packages/quereus-store/src/testing/kv-conformance.ts`, exported from the new
  `@quereus/store/testing` subpath. Zero test-framework dependency in the shipped
  package: assertions use `node:assert/strict`; Mocha's `describe`/`it`/`beforeEach`/
  `afterEach` are referenced via **module-local `declare const`** (module-scoped, so
  they shadow — never redeclare — any `@types/mocha` globals present at build time; the
  real Mocha functions bind at runtime).
- Ordering oracle is `compareBytes` (the literal contract definition), NOT the memory
  store — so the memory backend is tested against the contract as honestly as the others.
- Three thin adapters wired: memory (no `reopen`), LevelDB (temp dir, `reopen` re-opens
  same path), IndexedDB (`fake-indexeddb/auto`, `reopen` drops the manager + resets the
  singleton WITHOUT deleting the db, then re-opens — a genuine reopen against persisted
  data).

### Tiers asserted (per backend)

1. Point ops: round-trip; missing⇒undefined; **empty value ≠ missing**; **empty key is
   valid**; overwrite; delete-missing no-op; `has`↔`get`; **copy semantics** (mutating
   caller buffers post-put, and mutating a returned value, leave the store intact);
   `{ sync: true }` accepted; get/put reject after `close()`.
2. Iteration & ordering: empty store; forward = `compareBytes` order, reverse = exact
   reverse; prefix-before-extension (`[1] < [1,0] < [1,1]`); every bound + combinations;
   reverse with bounds; crossed/empty ranges yield nothing; `limit` (0, oversized,
   reverse); `approximateCount(range)` = actual.
3. Streaming across IndexedDB's 256-entry page boundary (306 entries, 2-byte BE keys):
   mid-iteration `await store.get(...)` each step (the load-bearing anti-
   `TransactionInactiveError` assertion); reverse; limit spanning the boundary; the
   collapsed-range `DataError` regression (inclusive bound on an exact 256-multiple) +
   its reverse mirror.
4. Batch: nothing visible until `write()`; mixed put+delete; **reuse after commit does
   not re-apply**; `clear()`; empty `write()` no-op.
5. Persistence (only registered when the adapter supplies `reopen`): write → close →
   reopen same keyspace → data present. Skipped for memory (documented contract
   *difference*, not a bug).
6. Encoded-key ordering agreement: a curated `encodeCompositeKey` golden vector (null,
   negative int, zero, ints interleaving a real, the 2^53 / 2^53+1 double-tie, NOCASE
   text, blobs sorting by content-not-length, a JSON object) inserted **shuffled** must
   iterate in `compareBytes` order (+ reverse); reorder-equal JSON objects and `5n`
   vs `5.0` each collapse to a **single** stored entry on every backend.

## Validation performed (this is a floor, not a ceiling)

- `yarn workspace @quereus/store test` → **915 passing**, exit 0 (memory conformance +
  trimmed memory-store.spec + the rest of the store suite).
- `yarn build` (full, dependency-ordered) → exit 0. Confirms every cross-package
  consumer of `@quereus/store` still type-resolves with the new export, and the store
  build emits `dist/src/testing/kv-conformance.{js,d.ts}`.
- `yarn workspace @quereus/plugin-leveldb test` → **50 passing**, exit 0.
- `yarn workspace @quereus/plugin-indexeddb test` → **103 passing**, exit 0.
- The stderr noise in the store run (`events.spec` "boom", `[StoreModule] Failed to
  rehydrate…`, `[TransactionCoordinator] rollback-to savepoint … out of range`) is
  OTHER specs' intentional error-path logging — those tests pass. Not new, not mine.

## Genuine find, fixed inline: memory-store copy-on-read

The copy-semantics tier surfaced a real in-memory divergence: `InMemoryKVStore.get`
returned the *internal* stored buffer, and `iterate` yielded the internal buffers — so
a caller mutating a read value corrupted the store. LevelDB (fresh deserialize) and
IndexedDB (structured clone) both hand back independent buffers per read. Fixed
`memory-store.ts` `get`/`iterate` to return copies, aligning it with the shared
observable contract. This is the desirable kind of find the ticket anticipated; the
suite was NOT weakened to accommodate the old behavior.

- **Tripwire (parked, not a ticket):** `iterate` now allocates two buffers per yielded
  entry. `NOTE:` comment at `memory-store.ts` iterate site — if a hot full-scan over a
  large in-memory store ever shows up as slow, hand out views and copy only at the
  mutation boundary.

## Reconciliation (removed duplication so the two copies can't drift)

- `quereus-plugin-leveldb/test/store.spec.ts` — **deleted**; it was 100% generic
  `KVStore` behavior (standalone `LevelDBStore.open` is now exercised by the conformance
  adapter). Sublevel/atomic/collision behavior stays in `shared-root.spec.ts`,
  `atomic-batch.spec.ts`, `sibling-collision.spec.ts`.
- `quereus-plugin-indexeddb/test/store.spec.ts` — **trimmed**: removed basic point ops,
  basic iteration, batch-put, the whole streaming/batch-boundary describe, and the
  `IndexedDBWriteBatch`-reuse test (all now in the shared suite). **Kept**: the
  concurrent-version-upgrade write test and the `MultiStoreWriteBatch`-reuse test (both
  IndexedDB-specific, no cross-backend analogue) and both SQL Integration describes.
- `quereus-store/test/memory-store.spec.ts` — **trimmed** to only the `clear()`/`size`
  surface unique to `InMemoryKVStore`.

## Where to look hardest (known gaps / things to scrutinize)

- **Subpath type resolution mechanism.** The two plugin test tsconfigs use
  `moduleResolution: "node"` (node10), which does NOT read package `exports` for
  *types*. Runtime resolution (Node ESM loader via ts-node) honors `exports` fine; to
  make the *type-check* also resolve `@quereus/store/testing`, I added a `typesVersions`
  entry to `quereus-store/package.json` alongside the `exports` entry. Both are needed;
  if either is removed the plugin specs break (runtime or type-check). A cleaner
  long-term fix is to move those test tsconfigs to `nodenext` resolution — deliberately
  not done here to keep the diff scoped.
- **IndexedDB `reopen` adapter** closes the singleton manager and calls
  `resetInstance` before re-opening (without deleting the db). Confirm this genuinely
  models persistence under `fake-indexeddb` (data lives in its global store until
  `deleteDatabase`) and leaks no handles across the suite's many tests.
- **Real-browser IndexedDB is NOT exercised** — the suite runs under `fake-indexeddb` in
  Node, same as every existing IDB spec. Real-env coverage is parked in
  `backlog/feat-indexeddb-real-browser-smoke.md`.
- **Provider-level atomic cross-store commit** (`beginAtomicBatch`, foreign-handle
  `MISUSE`) is intentionally out of scope — it is provider-shaped, not `KVStore`-shaped.
  Parked in `backlog/debt-kvstore-provider-conformance.md`; the near-identical
  `atomic-batch.spec.ts` twins in both plugins were left in place.
- **Tier 6 `-0`/`+0`/`0n` collapse** is asserted at the *encoding* level in
  `encoding.spec.ts`; at the *store* level the collapse tests use the object-reorder and
  `5n`/`5.0` pairs (same "equal-logical ⇒ equal-bytes ⇒ single entry" path). `0n` is in
  the ordering vector but there is no store-level `-0` vs `0n` collapse assertion — add
  one if you want that instance pinned per-backend too. The large-int64 double-tie IS
  pinned per-backend (2^53 and 2^53+1 must store as two distinct, correctly-ordered
  entries — the distinctness guard would fail if the tie-break tail regressed).
- **Empty key/value passed on all three backends** (a real divergence risk) — verified
  green here, including LevelDB (`abstract-level` v3 accepts empty keys/values) and
  `fake-indexeddb` (empty `ArrayBuffer` key). A real browser's IDB may differ; see the
  real-browser backlog ticket.
