description: Store substrate for the MV backing host — sync/lazy TransactionCoordinator construction, incremental per-store pending-op index + ordered snapshot view, order-preserving reads-own-writes merge in StoreTable's read paths, and buildPkPrefixBounds. Pure quereus-store change; reviewed and complete.
files:
  - packages/quereus-store/src/common/transaction.ts        # lazy default store, pending index, ordered snapshot view
  - packages/quereus-store/src/common/store-table.ts        # iterateEffective; query() three-arm RYOW merge
  - packages/quereus-store/src/common/store-module.ts       # sync getCoordinator; capabilities (savepoints: true)
  - packages/quereus-store/src/common/key-builder.ts        # buildPkPrefixBounds; incrementLastByte overflow fix; empty-index-prefix unbounded
  - packages/quereus-store/src/common/bytes.ts              # shared bytesToHex/bytesEqual/compareBytes
  - packages/quereus-store/test/transaction.spec.ts
  - packages/quereus-store/test/key-builder.spec.ts
  - packages/quereus-store/test/store-ryow.spec.ts
  - packages/quereus-store/test/isolated-store.spec.ts
  - packages/quereus-store/README.md
----

# Complete: store substrate for the backing host

First of three steps toward `using store` MV backings (`store-backing-host`
follows). Everything landed in `quereus-store`; no engine or isolation code was
touched.

## What was delivered (implement stage)

- **TransactionCoordinator**: constructor accepts `KVStore | (() => Promise<KVStore>)`
  (`DefaultStoreSource`); the thunk resolves lazily at commit (and only when
  default-bucket ops exist), caching the handle; a failed resolve clears the
  cached promise so the coordinator isn't poisoned for later transactions.
  `getStore()` stays sync and throws MISUSE before resolution.
- Incremental last-write-wins pending-op index bucketed per target store
  (`null` = default-by-role; an explicit handle that IS the resolved default
  folds into the default bucket). Updated on put/delete; cleared on
  begin/commit/rollback; rebuilt by O(ops) replay on `rollbackToSavepoint`.
  `getPendingOpsForStore` is O(1) (live read-only view);
  `getOrderedPendingOps` returns the key-ordered merge input.
- **StoreModule.getCoordinator** is synchronous (thunk-constructed); the only
  call site is in-package. Capabilities doc updated: committed-only between
  connections, same-coordinator RYOW within a transaction; `isolation: false`
  unchanged.
- **buildPkPrefixBounds**: PK-prefix bounds encoded exactly as `buildDataKey`
  (per-column DESC directions + key collations); empty prefix ⇒ full-scan
  bounds. **Behavioral fix**: `incrementLastByte` of an all-0xff key now
  returns `undefined` (no finite upper bound, `lt` omitted) instead of an
  inverted empty window; `buildCatalogScanBounds` asserts non-overflow.
- **StoreTable.iterateEffective**: order-preserving two-way merge of the
  coordinator's ordered pending puts with `store.iterate(bounds)` by encoded
  key bytes — pending wins on equal keys, pending deletes suppress committed
  entries, out-of-bounds pending puts excluded, `reverse` honored by
  sign-folded comparison; degrades to bare committed iterate when no
  transaction/empty bucket. `query()`'s three arms all read the effective
  state (point via `readLiveRowByPk`, range/full via the merge), preserving
  `providesOrdering`/`monotonicOn`. UNIQUE-check pending lookups address the
  default bucket by role (no handle) — required while a lazily-constructed
  coordinator's default is unresolved.
- Shared `bytes.ts` helpers; new exports from `common/index.ts`; README
  updated.

## Review findings

Reviewed the implement diff fresh (commit `c15c1c61`) before reading the
handoff, then verified every cross-cutting assumption against the code.

### Checked

- **Bucket-addressing safety of the lazy default**: audited every
  `coordinator.put`/`coordinator.delete` call site — data-store ops are always
  queued by role (no store argument); explicit handles are used only for index
  stores, which are never the default. Verified `StoreModule.getStore` caches
  per tableKey, so the coordinator thunk resolves the exact instance
  `StoreTable.ensureStore` holds.
- **API-change blast radius**: no out-of-package callers of `getCoordinator`
  (sync change safe); `coordinator.getStore()` is called only in tests, so the
  new MISUSE throw is low-risk; `getPendingOpsForStore` is consumed only
  in-package, immediately, with no coordinator mutations while held
  (re-checked `findUniqueConflict`'s loop specifically).
- **Isolation-flush interaction**: re-derived the safety argument —
  `flushOverlayToUnderlying` applies tombstones before writes and the overlay
  holds at most one entry per PK, so the `rowExistsInUnderlying` probe (now
  RYOW) can never observe a pending op at its own key from the same flush;
  the `trustedWrite` insert-hits-existing INTERNAL guard stays committed-only.
  Pinned by green isolation suites and the LevelDB engine run.
- **Merge algorithm**: bounds filtering (`keyWithinBounds` covers
  gte/gt/lte/lt), sign-folded reverse, and the LWW invariant (a key is in puts
  XOR deletes) that makes the equal-key shadow-and-continue safe.
- **Tests**: read all three spec files; the property tests are seeded
  (reproducible) and cover all four addressing forms; the direct harness
  covers the reverse and bounded arms `query()` doesn't exercise yet.

### Found and fixed in this pass (minor)

- **Ordered pending view was half-live**: `getOrderedPendingOps` copied `puts`
  (via sort) but returned the LIVE delete set. `iterateEffective` holds the
  view across the entire async scan, where pipelined DML over an open cursor
  can interleave coordinator mutations — mid-scan deletes would suppress
  not-yet-reached committed entries while mid-scan puts never appeared,
  violating the view's own documented no-retention contract. Fixed: the
  ordered view now copies the delete set too (true point-in-time snapshot,
  O(transaction-size)); `OrderedPendingOps` doc rewritten; pinned with a new
  snapshot-stability test.
- **Partial-commit window in `commit()`**: the lazy default resolved inside
  the per-store batch loop, so a thunk rejection after an explicit-store batch
  had written would strand a partial multi-store commit (and `finally` clears
  the transaction). Fixed: the default resolves before any batch is written.
- **`buildIndexPrefixBounds([])` kept the `lt: [0xff]` cap**, excluding index
  entries whose leading column is a DESC NULL (0xff type byte) from full index
  scans — the exact trap this ticket fixed in the non-empty arm and documented
  at `buildFullScanBounds`. Dormant (no runtime callers in-repo) but the
  export contradicted its own docs. Fixed to unbounded full-scan bounds; test
  updated.
- **`bucketKey` doc stated a false premise** ("no caller can hold the
  unresolved default's handle — it has never been opened through this
  coordinator"): the handle is obtainable through the module's store cache
  (e.g. `ensureStore`) while the thunk is unresolved. The actual safety
  invariant is the call-site convention (default addressed by omission until
  resolved). Doc rewritten to state that contract explicitly.
- **Stale savepoint claims**: README said "Savepoints are not supported" and
  `getCapabilities` reported `savepoints: false`, contradicted by the
  coordinator implementation and this ticket's own SQL-level savepoint test.
  The flag is advisory (`capabilities.ts`: not engine-consulted; verified
  nothing reads it for behavior). Flipped to `true` with a comment, fixed the
  README bullets, and updated the capabilities test that pinned the stale
  value.

### Major findings

None requiring new tickets. The one significant gap —
`StoreTable.update()`'s internal reads (insert PK probe, oldRow reads,
PK-change conflict probe) staying committed-only — was already identified and
filed by the implementer as `backlog/store-update-internal-reads-committed-only`
with a full case analysis; nothing in it blocks the backing host (the flush
paths were analyzed safe above).

### Left as-is, with reasons

- Custom comparator-only PK collation residual (flush tombstone visible to the
  probe at a byte-colliding key): the documented store-collation residual the
  source ticket scoped out; untested, unchanged.
- RYOW visibility is per-table-coordinator, not per-connection: exactly the
  posture the ticket specified, now consistent between scans and the
  pre-existing UNIQUE-check paths.
- `scanPKRange` still full-scans + post-filters: pre-existing
  `backlog/store-pk-range-seek`; `buildPkPrefixBounds` is the substrate for it
  and for the backing host.
- `iterateEffective`'s `reverse` arm has no engine caller yet: covered by the
  direct harness test; the backing host is the intended consumer.
- `buildIndexPrefixBounds`' `lt?` return-type change is a type-level break for
  out-of-repo consumers: backwards compatibility explicitly out of scope per
  AGENTS.md.

## Verification (review pass, after fixes)

- `yarn build` (root) — green.
- `yarn lint` (packages/quereus) — clean.
- `packages/quereus-store`: 455 passing, 0 failing; `tsc --noEmit -p
  tsconfig.test.json` clean.
- `yarn test` (root, all workspaces) — green: quereus 5,719 passing,
  quereus-isolation 126 passing, all other packages passing.
- `yarn test:store` (LevelDB-backed engine logic tests — isolation flush over
  real StoreTables, value-swap cycle, PK-change flush, trustedWrite guard) —
  5,715 passing, 0 failing.
