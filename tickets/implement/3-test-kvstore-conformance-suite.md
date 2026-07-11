description: The project has three interchangeable storage backends (in-memory, server LevelDB, browser IndexedDB) that must behave identically, but each is tested on its own; build one shared test suite that runs the same behavioral checks against all three so future drift fails a test instead of reaching users.
prereq:
files:
  - packages/quereus-store/src/common/kv-store.ts (the KVStore contract under test)
  - packages/quereus-store/src/common/memory-store.ts (in-memory backend + iterate/compare reference)
  - packages/quereus-store/src/common/bytes.ts (compareBytes — the byte-lex oracle)
  - packages/quereus-store/src/common/encoding.ts (encodeCompositeKey for the ordering-agreement tier)
  - packages/quereus-store/src/index.ts (package entry; add the ./testing export)
  - packages/quereus-store/package.json (add "./testing" subpath export)
  - packages/quereus-store/tsconfig.json (include already covers src/**; confirm)
  - packages/quereus-plugin-leveldb/src/store.ts (LevelDB backend under test)
  - packages/quereus-plugin-indexeddb/src/store.ts (IndexedDB backend under test)
  - packages/quereus-plugin-indexeddb/src/manager.ts (IndexedDBManager — reopen/teardown for the backend adapter)
  - packages/quereus-plugin-leveldb/test/store.spec.ts (existing per-backend spec — reference for the adapter + what to fold in)
  - packages/quereus-plugin-indexeddb/test/store.spec.ts (existing streaming/batch-reuse specs — reference)
  - packages/quereus-store/test/memory-store.spec.ts (existing per-backend spec — reference)
difficulty: medium
----

## What this builds

One **KVStore conformance suite**: a single parameterized battery of behavioral
tests, written against the `KVStore` contract in `kv-store.ts` (not against any one
backend), invoked once per backend. Each of the three backends provides only a tiny
*adapter* (how to open / reopen / tear down a store); the shared suite supplies every
assertion. A behavior that drifts on one backend now fails the suite instead of
silently diverging.

"Interchangeable behind the contract" is exactly what drifted before
(`plugins-indexeddb-diverges`, now complete: streaming iteration, batch reuse,
failed-open, racy upgrades). Those got targeted regression specs on the IndexedDB
side only; this suite makes the shared expectations structural.

### The three backends

- **in-memory** — `InMemoryKVStore` (`packages/quereus-store/src/common/memory-store.ts`)
- **LevelDB** — `LevelDBStore` (`packages/quereus-plugin-leveldb/src/store.ts`), standalone
  store over a temp directory (`LevelDBStore.open({ path })`)
- **IndexedDB** — `IndexedDBStore` (`packages/quereus-plugin-indexeddb/src/store.ts`) over
  `fake-indexeddb/auto`, opened via `IndexedDBStore.openForTable(dbName, storeName)`

## Design decisions (settled — do not re-open)

### Where the suite lives

`packages/quereus-store/src/testing/kv-conformance.ts`, exported from the package
under a new **`./testing` subpath** (`@quereus/store/testing`).

- `quereus-store` is the lowest package in this stack — both plugins already depend on
  it, so importing the suite from it introduces **no circular dependency**.
- The in-memory store lives in `quereus-store` itself, so its own `test/` imports the
  suite by relative path (`../src/testing/kv-conformance.js`); the two plugins import
  the built `@quereus/store/testing`, exactly as they already consume `@quereus/store`
  from `dist`. Run the store build (or `yarn build`, which is dependency-ordered via
  project references) before the plugin conformance specs so their `dist` import
  resolves — same prerequisite the existing plugin specs already have.

### No test-framework dependency in the shipped package

The suite is compiled into `@quereus/store`'s normal `src` build (tsconfig `include`
is `src/**/*`), so it must not drag Mocha/Chai types into the runtime package:

- Assertions use **`node:assert/strict`** (built-in, zero deps).
  `assert.deepStrictEqual` compares two `Uint8Array`s by content, and
  `assert.strictEqual(x, undefined)` distinguishes a missing key. No Chai.
- Mocha's `describe`/`it` are referenced via a **module-local ambient declaration**
  inside the file:
  ```ts
  declare const describe: (name: string, fn: () => void) => void;
  declare const it: (name: string, fn: () => void | Promise<void>) => void;
  ```
  The file has imports/exports, so these are module-scoped (no global pollution, no
  `@types/mocha` needed at store build time). At runtime the real Mocha globals bind.

Consumers of the `./testing` subpath must therefore run under Mocha; document that in
a one-line header comment. (All three test packages already do — Mocha + ts-node.)

### Backend adapter shape

The suite drives per-test lifecycle itself (its own `beforeEach`/`afterEach`); each
backend hands it a fresh lifecycle object:

```ts
export interface KVBackend {
  /** Prepare backend state; return a fresh EMPTY store. Called per test. */
  open(): Promise<KVStore>;
  /**
   * Reopen the SAME physical keyspace open() last created, WITHOUT wiping it —
   * for the persistence tier. Omit for a non-persistent backend (in-memory).
   */
  reopen?(): Promise<KVStore>;
  /** Release everything open()/reopen() created (close handles, rm temp dir / delete db). */
  teardown(): Promise<void>;
}

export function runKVStoreConformance(name: string, makeBackend: () => KVBackend): void;
```

`name` is the `describe()` title (`'InMemoryKVStore'`, `'LevelDBStore'`,
`'IndexedDBStore'`). `makeBackend()` is called fresh per test so state never leaks.
Persistence tests are only registered when the adapter supplies `reopen`.

### Scope line: shared contract vs. backend-specific

This suite pins the surface **all three backends share** (single-store `KVStore`
contract + byte ordering + optional persistence). It deliberately does **not** absorb
behaviors that are genuinely backend-specific and cannot be expressed identically
across all three:

- IndexedDB **failed-open recovery** and **concurrent version-upgrade** serialization
  are `IndexedDBManager` concerns with no LevelDB/in-memory analogue — they stay in
  the IndexedDB plugin's own `manager.spec.ts` / `store.spec.ts` (already covered by
  `plugins-indexeddb-diverges`).
- **Provider-level** atomic cross-store commit (`beginAtomicBatch`, foreign-handle
  `MISUSE`) is provider-shaped, not `KVStore`-shaped, and is already covered by
  near-identical `atomic-batch.spec.ts` twins in both plugins. Folding those into a
  shared *provider* conformance suite is a natural follow-up but out of scope here to
  keep this one agent-run-sized — parked as `debt-kvstore-provider-conformance` in
  backlog.

The "concurrent/forked access" surface for this suite is the **mid-iteration await**
test (below), which is what actually exercised the IndexedDB per-batch-transaction
design — not multi-connection concurrency.

### IndexedDB harness: Node fake-indexeddb (not real browser)

Confirmed decision: the conformance suite runs IndexedDB under **`fake-indexeddb/auto`
in Node/Mocha**, same as every existing IndexedDB spec. Real-browser execution is a
separate, heavier concern already captured in
`tickets/backlog/feat-indexeddb-real-browser-smoke.md` — cross-reference it, do not
solve browser-env here. fake-indexeddb models the spec behaviors this suite leans on
(idle readonly-tx auto-commit; `IDBKeyRange` DataError on a collapsed range).

## The suite's tiers (what to assert)

Write these as `describe` blocks inside `runKVStoreConformance`. Use the store's own
`compareBytes` (`packages/quereus-store/src/common/bytes.ts`) as the **ordering
oracle** — it is the literal definition of the contract ("keys compared
lexicographically by bytes"), so it tests the in-memory backend honestly too rather
than making the memory store its own oracle.

### Tier 1 — point operations
- put then get round-trips; get of a missing key is `undefined`.
- **empty value** (`new Uint8Array(0)`) round-trips and is distinct from missing
  (`get` returns a 0-length array, not `undefined`) — a real divergence risk.
- **empty key** (`new Uint8Array(0)`) is a valid key: put/get/has/delete round-trip.
- overwrite replaces the value.
- delete of a missing key is a no-op (no throw).
- `has` agrees with `get` presence.
- **copy semantics**: mutating the caller's key/value buffer *after* `put` must not
  change stored data; mutating a *returned* value must not corrupt the store.
- `put`/`delete` accept the `{ sync: true }` `WriteOptions` hint without error and
  still persist (no-op on memory; honored/best-effort elsewhere).
- after `close()`, `get`/`put` reject (message matches `/closed/i` loosely).

### Tier 2 — iteration & ordering
- empty store: `iterate()` yields nothing; `approximateCount()` is 0.
- forward iterate returns entries in `compareBytes` order; reverse returns the exact
  reverse.
- **prefix-before-extension**: keys `[1] < [1,0] < [1,1]` come back in that order.
- each bound individually and combined: `gte`, `gt`, `lte`, `lt`, `gte`+`lt`,
  `gt`+`lt`; reverse with bounds; a crossed/empty range yields nothing.
- `limit`: `0` yields nothing; a limit larger than the count yields all; `reverse`
  + `limit`.
- `approximateCount(range)` equals the actual count over that range (exact for these
  small backends).

### Tier 3 — streaming iteration (bounded, not full-materialization)
Seed **> 256 entries** (use e.g. 306 — IndexedDB pages in 256-entry batches, so this
crosses ≥ 1 boundary). Keys are 2-byte big-endian ints so order is unambiguous.
- iterate the whole range while `await`-ing an unrelated `store.get(...)` **inside the
  loop** each step; assert every entry appears exactly once, strictly ascending, no
  gaps/dupes. (A naive single-cursor IDB iterate throws `TransactionInactiveError`
  here — this is the load-bearing streaming assertion.)
- `reverse` across the boundary.
- `limit` that spans the boundary (e.g. 300).
- inclusive upper bound landing exactly on a batch multiple (`lte` on key 255 over
  0..255) and the reverse mirror (`gte` on the min over a 256-wide reverse range) —
  the collapsed-range `DataError` regression from `plugins-indexeddb-diverges`.

### Tier 4 — batch
- batch put/delete: nothing visible until `write()`; then all applied.
- **mixed** put+delete in one batch apply together.
- **reuse after commit**: `b.put(k1); await b.write();` then `b.put(k2); await
  b.write();` must not resurrect `k1` (the batch cleared its ops on the first commit).
- `clear()` discards queued ops.
- empty batch `write()` is a no-op (no throw).

### Tier 5 — persistence (only when the adapter provides `reopen`)
- write via `open()`, close that handle, `reopen()` the same keyspace, assert the data
  is present. In-memory omits `reopen`, so this tier is skipped for it (in-memory is
  intentionally non-persistent — a documented contract *difference*, expected, not a
  bug).

### Tier 6 — cross-backend byte-ordering agreement (the encoding coupling)
Build a golden set of keys with `encodeCompositeKey`
(`packages/quereus-store/src/common/encoding.ts`) over a curated SQL-value vector, so
this tier confirms every backend iterates identically-encoded keys in identical order
— the cross-backend invariant `json-canonical-key-hashing` (complete) produces and
this suite only *checks*. Curated vector must include: `null`; a negative int; the
`-0` / `+0` / `0n` collapse; a large int64 past 2^53 that shares its nearest double
with a neighbour; a real interleaving ints (`2.5` between `2` and `3`); NOCASE text
case-fold equality (`'ABC'` vs `'abc'` collapse to one key); blobs that must sort by
content not length; and a JSON object reorder-equal pair (`{a:1,b:2}` vs `{b:2,a:1}`).
- Insert the encoded keys in **shuffled** order; assert forward `iterate()` returns
  them in `compareBytes`-sorted order, and reverse returns the reverse.
- **equal-logical ⇒ equal-bytes, observable per backend**: inserting both encodings of
  a reorder-equal object (and `5n` vs `5.0`) collapses to a **single** stored entry on
  every backend (the second put overwrites the same key). This ties encoding equality
  to store behavior on each backend without duplicating `encoding.spec.ts`.

## TODO

### Phase 1 — the shared suite
- Create `packages/quereus-store/src/testing/kv-conformance.ts`: the `KVBackend`
  interface, `runKVStoreConformance(name, makeBackend)`, all six tiers above. Use
  `node:assert/strict` + the module-local `declare const describe/it`. Import
  `KVStore`/`KVEntry`/`IterateOptions` from `../common/kv-store.js`, `compareBytes`
  from `../common/bytes.js`, `encodeCompositeKey` from `../common/encoding.js`, and
  `InMemoryKVStore` only if a helper needs it (the oracle is `compareBytes`, not the
  memory store). Header comment: "test-support; run under Mocha".
- Add the `./testing` subpath to `packages/quereus-store/package.json` `exports`:
  ```json
  "./testing": {
    "types": "./dist/src/testing/kv-conformance.d.ts",
    "import": "./dist/src/testing/kv-conformance.js"
  }
  ```
- Confirm `src/testing/**` is emitted by the store build (tsconfig `include` is
  `src/**/*`, `exclude` is `test` — it is). Keep the file clean under
  `noUnusedLocals`/`noUnusedParameters`.

### Phase 2 — wire the three backends
- `packages/quereus-store/test/kv-conformance.spec.ts`: `runKVStoreConformance(
  'InMemoryKVStore', () => ({ open: async () => new InMemoryKVStore(),
  teardown: async () => {} }))` (no `reopen`).
- `packages/quereus-plugin-leveldb/test/conformance.spec.ts`: adapter over a per-test
  temp dir (mirror `store.spec.ts` setup); `open` = `LevelDBStore.open({ path })`,
  `reopen` = open again at the same path, `teardown` = close + `fs.rmSync`. Import the
  suite from `@quereus/store/testing`.
- `packages/quereus-plugin-indexeddb/test/conformance.spec.ts`: `import
  'fake-indexeddb/auto'`; adapter over a per-test db name (mirror `store.spec.ts`
  setup/teardown, incl. `IndexedDBManager.resetInstance` + `indexedDB.deleteDatabase`);
  `open` = `IndexedDBStore.openForTable(dbName, storeName)`, `reopen` = open the same
  store name on the same db **without** deleting, `teardown` = close + reset + delete.
  Import from `@quereus/store/testing`.

### Phase 3 — reconcile & validate
- Where the new suite fully subsumes an existing hand-written per-backend spec, remove
  the now-redundant cases (do NOT delete backend-specific ones: the IndexedDB
  concurrent-upgrade race test, LevelDB sublevel/atomic-batch specs, etc. stay). Prefer
  deleting duplicated point/iterate/batch cases over leaving two copies to drift again.
  If unsure a case is truly covered, keep it — a redundant test is cheaper than a lost one.
- If the suite surfaces a genuine **in-memory** gap (expected: none; the memory store
  should pass), that is a desirable find — fix it in `memory-store.ts` if trivial, else
  file a `fix/` ticket and note it in the review handoff. Do NOT weaken the suite to
  make memory pass.
- Validate (stream output, never silent-redirect):
  - `yarn workspace @quereus/store test 2>&1 | tee /tmp/store.log; tail -n 60 /tmp/store.log`
  - `yarn build 2>&1 | tee /tmp/build.log; tail -n 40 /tmp/build.log` (so the plugins'
    `@quereus/store/testing` dist import resolves)
  - `yarn workspace @quereus/plugin-leveldb test 2>&1 | tee /tmp/lvl.log; tail -n 60 /tmp/lvl.log`
  - `yarn workspace @quereus/plugin-indexeddb test 2>&1 | tee /tmp/idb.log; tail -n 60 /tmp/idb.log`
  - `yarn workspace @quereus/quereus run lint` (only package with a real lint) if any
    exported types changed.

## Edge cases & interactions (the reviewer will check these)

- **empty value vs missing key** — `get` of a stored empty `Uint8Array` returns a
  0-length array, NOT `undefined`. Most likely single divergence across backends.
- **empty key** as a legal key on all three (memory hex `''`, LevelDB empty key,
  IndexedDB empty `ArrayBuffer`).
- **byte extremes & ordering** — keys containing `0x00` and `0xff`; a key that is a
  proper prefix of another must sort before it.
- **mid-iteration await** (Tier 3) is the concurrent-access surface — it forces
  IndexedDB's per-batch-transaction path; without it the streaming design is untested.
- **collapsed-range boundary** — inclusive bound landing exactly on a 256 multiple must
  be treated as "exhausted", never throw `DataError` (regression from the prereq).
- **batch reuse after commit** must not re-apply the first commit's ops on any backend.
- **copy semantics** — a backend that stores the caller's buffer by reference (rather
  than a copy) fails the post-put-mutation assertion; the suite must catch that.
- **persistence tier gating** — running the reopen test against a non-persistent
  backend would spuriously fail; it must be registered only when `reopen` is present.
- **-0 / +0 / 0n and large-int64 tie** (Tier 6) — these collapse or interleave per the
  numeric encoding; the encoded golden set must exercise the double-tie path.
- **stale `dist`** — plugin specs import `@quereus/store/testing` from `dist`; the
  build must run first (Phase 3 validation ordering handles this).
- **cross-package type drift** — if `KVBackend`/`runKVStoreConformance` signatures
  change, all three call sites update together; keep the adapter interface minimal.
