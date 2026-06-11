description: Store substrate prerequisites for the MV backing host — synchronous/lazy TransactionCoordinator construction, an incremental per-store pending-op index, order-preserving reads-own-writes merge in StoreTable's read paths, and PK-prefix seek bounds in the key builder. Pure quereus-store change; no engine or isolation edits.
files:
  - packages/quereus-store/src/common/transaction.ts        # lazy default store, pending index, ordered pending view
  - packages/quereus-store/src/common/store-table.ts        # query()/point-lookup pending merge; iterateEffective helper
  - packages/quereus-store/src/common/store-module.ts       # getCoordinator becomes synchronously constructible
  - packages/quereus-store/src/common/key-builder.ts        # buildPkPrefixBounds (data-store PK prefix range)
  - packages/quereus-store/src/common/encoding.ts           # (read-only reference: composite-key prefix property)
  - packages/quereus-store/test/                            # new spec(s) using InMemoryKVStore-backed provider
----

# Store substrate for the backing host

First of three steps realizing `using store` MV backings (research resolved in
the `store-mv-backing-host` plan pass). This ticket contains only store-internal
plumbing the host needs; the `BackingHost` itself lands in the follow-on
`store-backing-host`.

## Background facts (verified)

- `TransactionCoordinator` is **per table** (`StoreModule.coordinators` keyed by
  `schema.table`); its pending state is an **array** of ops
  (`pendingOps: PendingOp[]`), and `getPendingOpsForStore` re-scans the whole
  array per call (O(ops)). Savepoints are index snapshots into that array.
- `StoreTable.query()` reads **committed only** (`store.get` / `store.iterate`);
  only the UNIQUE-check paths (`findUniqueConflict`, `readLiveRowByPk`) merge
  pending ops. So the bare store has no read-your-own-writes for scans, and a
  store-backed MV's mid-transaction reads would miss just-applied maintenance.
- `BackingHost.connect()` is **synchronous** by contract
  (`packages/quereus/src/vtab/backing-host.ts`), but
  `StoreModule.getCoordinator` is async (it awaits `getStore`). The coordinator
  only actually needs the store at commit time.
- `encodeCompositeKey` concatenates self-delimiting per-column encodings
  (text NUL-terminated with `0x01` escaping, fixed-width tagged numerics), so
  the encoding of a leading value subset is a byte-prefix of the full key —
  including per-column DESC bit-inversion and per-column collation encoders.
  `buildIndexPrefixBounds` + `incrementLastByte` already exist for index
  stores; the data store has no PK-prefix equivalent.

## Changes

### 1. TransactionCoordinator — lazy store + pending index

- Allow construction with a **lazy default store** (`KVStore | (() => Promise<KVStore>)`):
  resolve at `commit()` (and anywhere else the concrete handle is needed).
  `StoreModule.getCoordinator` becomes synchronously constructible
  (`getCoordinator(tableKey, config): TransactionCoordinator` with the thunk
  `() => this.getStore(tableKey, config)`); keep an async alias if call sites
  prefer it. This is what lets the future host's `connect()` stay sync.
- Maintain an **incremental last-write-wins index** alongside the op array:
  conceptually `Map<storeKey, { puts: Map<hex, {key,value}>, deletes: Set<hex> }>`
  where `storeKey` distinguishes the default store (sentinel) from explicit
  per-op stores (index stores). Update on `put`/`delete`; clear on
  begin/commit/rollback; **rebuild from the truncated array on
  `rollbackToSavepoint`** (rollback-to is rare; O(ops) there is fine).
- `getPendingOpsForStore` returns the indexed view (O(1)); preserve its
  current semantics exactly — `store === undefined` and the resolved default
  store must address the same bucket (compare "is default" rather than raw
  identity so the lazy default cannot misfile ops).
- Expose an **ordered pending view** for a store: pending puts sorted by key
  bytes plus the delete set — the merge input for §3. Sorting on demand is
  acceptable (pending sets are transaction-sized).

### 2. Key builder — PK prefix bounds

- `buildPkPrefixBounds(prefixValues, options, directions, collations)` in
  `key-builder.ts`: encode the leading PK values exactly as `buildDataKey`
  does (same per-column directions and `pkKeyCollations`), return
  `{ gte: prefix, lt: incrementLastByte(prefix) }`; empty prefix ⇒ full-scan
  bounds. Document the prefix-preservation property it relies on (and note the
  `buildFullScanBounds` caveat: no `lt: [0xff]` cap, since DESC-inverted NULL
  prefixes can produce leading `0xff` — the increment-based upper bound is not
  affected because it derives from the actual prefix bytes).

### 3. StoreTable — order-preserving reads-own-writes

- Shared helper (e.g. `iterateEffective(store, bounds, reverse)`):
  merge the coordinator's ordered pending puts with the committed
  `store.iterate(bounds)` stream **by encoded key bytes** (both are key-sorted;
  pending wins on equal keys; pending deletes suppress committed entries),
  honoring `reverse`. Bound the pending side to `bounds` too.
- Route `query()`'s three arms through it: point lookup consults the pending
  view first (delete ⇒ miss, put ⇒ its row, else committed `get`); range and
  full scans use the merged iterate. This preserves the module's
  `providesOrdering` / `monotonicOn` advertisements (merged emission stays in
  PK key order).
- When no transaction is active (or the pending bucket is empty) the merge
  must degrade to the bare committed iterate with no measurable overhead.

## Edge cases & interactions

- **Isolation flush invariant** — `IsolatedTable.flushOverlayToUnderlying`
  routes insert-vs-update via `rowExistsInUnderlying` (an underlying point
  query) *inside* the flush's own mini-transaction. With reads-own-writes, an
  earlier flush write to the same store becomes visible to that probe. The
  overlay holds at most one entry per PK so the same key is never visited
  twice, and the flush applies tombstones before puts — analyze and pin with a
  regression run of the existing isolation suites (value-swap cycle, PK-change
  flush, `trustedWrite` insert-hits-existing INTERNAL guard, which reads the
  committed `store.get` and must stay committed-only).
- **Bare-store semantics change** — bare `StoreModule` (no isolation wrapper)
  gains read-your-own-writes inside an explicit transaction. `getCapabilities`
  still reports `isolation: false` (no snapshot isolation, no cross-connection
  isolation); update the `StoreModule` doc comment so the claim matches
  ("committed-only between connections; same-coordinator RYOW within a
  transaction").
- **Savepoint truncation vs index** — `rollbackToSavepoint` truncates the op
  array; the rebuilt index must equal a from-scratch replay (test: put, sp,
  put-overwrite, delete, rollback-to, assert merged read).
- **DESC + collation keys** — merged ordering must agree with encoded-byte
  order under DESC PK columns and NOCASE per-column key collations (case-only
  distinct values collapse to one key; pending overwrite of `'A'` over `'a'`
  must merge, not duplicate).
- **Pending entries outside scan bounds** must not leak into a bounded merge;
  reverse iteration must yield exact reverse order of forward.
- **Events / stats untouched** — queued DataChangeEvents and stats deltas keep
  their existing commit-time behavior; the index is read-side only.

## Tests (new spec in packages/quereus-store/test, InMemoryKVStore provider)

- Coordinator: indexed pending view equals legacy array-scan semantics
  (property-style over random op sequences); savepoint rebuild; lazy-store
  commit (coordinator constructed before the store ever opened).
- buildPkPrefixBounds: text with embedded NUL/escape bytes, integer, multi-col
  prefix, DESC leading column, NOCASE collation; bounds window is exactly the
  prefix-equal slice of generated keys.
- StoreTable RYOW: bare store `begin → insert → select` sees the row; rollback
  discards; rollback-to-savepoint discards the tail only; merged full scan
  order matches PK order with mixed pending/committed rows (asc + desc PK);
  point lookup honors pending delete and pending put.
- Full `yarn test` + targeted isolation suites green (the flush-probe
  interaction above).

## TODO

- TransactionCoordinator lazy default store; sync `getCoordinator` path
- Incremental per-store pending index + ordered pending view; savepoint rebuild
- buildPkPrefixBounds + prefix-property doc note
- StoreTable iterateEffective + query()/point-lookup merge
- StoreModule/StoreTable doc-comment updates (RYOW posture)
- New spec file(s); run yarn build / lint / test; spot-run quereus-isolation tests
