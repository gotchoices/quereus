description: Review the store substrate for the MV backing host — sync/lazy TransactionCoordinator construction, incremental per-store pending-op index + ordered view, order-preserving reads-own-writes merge in StoreTable's read paths, and buildPkPrefixBounds. Pure quereus-store change; no engine or isolation edits. All suites green including yarn test:store.
files:
  - packages/quereus-store/src/common/transaction.ts        # lazy default store, pending index, ordered view
  - packages/quereus-store/src/common/store-table.ts        # iterateEffective; query() three-arm RYOW merge
  - packages/quereus-store/src/common/store-module.ts       # sync getCoordinator; capabilities doc
  - packages/quereus-store/src/common/key-builder.ts        # buildPkPrefixBounds; incrementLastByte overflow fix
  - packages/quereus-store/src/common/bytes.ts              # NEW shared bytesToHex/bytesEqual/compareBytes
  - packages/quereus-store/src/common/index.ts              # new exports
  - packages/quereus-store/test/transaction.spec.ts         # pending-index property tests, lazy store, ordered view
  - packages/quereus-store/test/key-builder.spec.ts         # buildPkPrefixBounds exact-slice tests
  - packages/quereus-store/test/store-ryow.spec.ts          # NEW: SQL-level RYOW + direct merge harness
  - packages/quereus-store/README.md                        # RYOW posture; buildPkPrefixBounds row
----

# Review: store substrate for the backing host

First of three steps toward `using store` MV backings (`store-backing-host`
follows, `prereq:` already wired). Everything landed in `quereus-store`; no
engine or isolation code was touched.

## What was built

**TransactionCoordinator** (`transaction.ts`)
- Constructor now accepts `KVStore | (() => Promise<KVStore>)`
  (`DefaultStoreSource`). The thunk resolves lazily — at commit, and only when
  default-bucket ops exist — and caches; a failed resolve clears the cached
  promise so commit can retry. `getStore()` stays sync and throws MISUSE before
  resolution.
- Incremental last-write-wins index alongside the op array:
  `Map<KVStore | null, {puts, deletes}>` where `null` is the default-store
  bucket *by role*. `bucketKey()` folds an explicit handle that IS the resolved
  default into the `null` bucket, so both addressing forms see the same ops and
  an unresolved lazy default can never misfile them. Updated on `put`/`delete`;
  cleared on begin/commit/rollback; **rebuilt by O(ops) replay on
  `rollbackToSavepoint`**.
- `getPendingOpsForStore` is now O(1) and returns the LIVE bucket
  (ReadonlyMap/ReadonlySet types; documented as a not-to-be-retained view —
  previously it allocated a fresh snapshot per call).
- New `getOrderedPendingOps(store?)`: puts sorted ascending by key bytes +
  delete hex set — the merge input. Sorts on demand.
- `commit()` groups ops by `bucketKey` (so explicit-handle-of-default and
  `undefined` ops share one batch — same physical writes as before).

**StoreModule** (`store-module.ts`)
- `getCoordinator(tableKey, config)` is now **synchronous**, constructing with
  the thunk `() => this.getStore(tableKey, config)`. No async alias was kept —
  the only call site (`StoreTable.ensureCoordinator`) is in-package, and
  nothing outside quereus-store referenced it (grep-verified).
- `getCapabilities` doc comment updated: committed-only between connections;
  same-coordinator RYOW within a transaction. `isolation: false` unchanged.

**key-builder.ts**
- `buildPkPrefixBounds(prefixValues, options, directions, collations)`:
  encodes the leading PK values exactly as `buildDataKey` does and returns
  `{gte, lt: incrementLastByte(prefix)}`; empty prefix ⇒ full-scan bounds
  (`{gte: []}`, no `lt`). Prefix-preservation property documented at the
  function.
- **Behavioral fix**: `incrementLastByte` of an all-0xff key (leading DESC
  NULL) previously returned an all-zero array — an inverted, empty window. It
  now returns `undefined` = "no finite upper bound"; `buildPkPrefixBounds` and
  `buildIndexPrefixBounds` surface that as an omitted `lt` (their return type
  is now `{gte, lt?}`). `buildCatalogScanBounds` asserts non-overflow (UTF-8
  never emits 0xff).

**StoreTable** (`store-table.ts`)
- `iterateEffective(store, bounds, reverse)`: order-preserving two-way merge of
  the coordinator's ordered pending puts with `store.iterate(bounds)` by
  encoded key bytes — pending wins on equal keys, pending deletes suppress
  committed entries, pending puts outside `bounds` are excluded, `reverse`
  honored by sign-folding the comparison. With no active transaction or an
  empty bucket it degrades to the bare committed iterate (no merge state
  allocated).
- `query()` three arms: point lookup routes through `readLiveRowByPk`
  (pending delete ⇒ miss, pending put ⇒ its row, else committed `get`); range
  and full scans iterate `iterateEffective`. Merged emission stays in PK key
  order, preserving `providesOrdering`/`monotonicOn`.
- Pending lookups in `findUniqueConflict`/`readLiveRowByPk` now address the
  **default bucket** (`getPendingOpsForStore()` with no arg) instead of passing
  the data-store handle — required for correctness while a lazily-constructed
  coordinator's default is unresolved; semantically identical otherwise (the
  per-table coordinator's default IS the table's data store).
- Local hex/equality helpers replaced by the new shared `bytes.ts`
  (`bytesToHex`/`bytesEqual`/`compareBytes`); `keyWithinBounds` added.

## Isolation-flush analysis (the ticket's flagged interaction)

`IsolatedTable.flushOverlayToUnderlying` probes insert-vs-update via
`rowExistsInUnderlying` → `underlyingTable.query()` point arm, which now reads
through the pending view. Analyzed safe: the overlay holds at most one entry
per PK and each flush write touches only its own PK key (trustedWrite skips
UNIQUE checks, so no REPLACE evictions touch other keys), so the probe for key
K can never observe a pending op at K from this flush. The `trustedWrite`
insert-hits-existing INTERNAL guard reads the committed `store.get` and was
left committed-only, as required. Pinned by regression: full isolation suites
and the store-backed engine logic tests are green (see below).

## Verification performed

- `yarn build` (root, all packages) — green.
- `yarn test` (root, all workspaces) — green; quereus engine 5,719 passing.
- `yarn test:store` (LevelDB-backed engine logic tests — exercises the
  isolation flush over real StoreTables, value-swap cycle, PK-change flush,
  trustedWrite guard) — 5,715 passing, 0 failing.
- `quereus-isolation` package suite — 126 passing.
- `quereus-store` suite — 454 passing (31 new tests), plus
  `tsc --noEmit -p tsconfig.test.json` clean.
- `yarn lint` (packages/quereus) — clean (changed package has no lint script).

New tests:
- `transaction.spec.ts`: property-style equivalence of the indexed pending view
  vs a legacy array-scan reference over seeded-random op sequences across four
  addressing forms (default-as-undefined, default-by-handle, two explicit
  stores); LWW put/delete/put; savepoint-rollback rebuild == from-scratch
  replay (incl. per-store separation and post-rollback ops); ordered-view
  sorting; lazy store (sync construction, resolve-at-commit, resolve-once,
  never-resolve-when-only-explicit-stores, getStore before/after, fold of
  explicit resolved handle).
- `key-builder.spec.ts`: `buildPkPrefixBounds` exact-slice property (window
  selects precisely the prefix-equal keys) for integer, multi-column, embedded
  NUL/escape text, DESC leading column, NOCASE per-column collation; all-0xff
  (DESC NULL) prefix omits `lt`; same overflow case for
  `buildIndexPrefixBounds`.
- `store-ryow.spec.ts` (SQL-level, bare StoreModule over InMemoryKVStore):
  begin→insert→select; rollback discards; commit persists; point lookup honors
  pending put/delete; merged full-scan order (ASC and DESC PK); NOCASE
  pending-overwrite of `'A'` over committed `'a'` merges without duplicating;
  savepoint rollback discards tail only; intra-transaction UNIQUE duplicate
  still rejected. Plus a direct `iterateEffective` harness (subclass exposing
  the protected method, pending ops driven through the shared coordinator):
  bounded merge excludes out-of-bounds pending puts, reverse yields the exact
  reverse of forward, no-transaction degrade.

## Known gaps / flags for the reviewer

- **`update()` internal reads stay committed-only** (insert PK probe, oldRow
  reads, PK-change conflict probe whose comment already *claims* coordinator
  read-through). Pre-existing divergence, now more visible since queries gained
  RYOW; deliberately out of scope per the ticket ("query()'s three arms").
  Filed as `backlog/store-update-internal-reads-committed-only` with the full
  case analysis — review whether any of it should be pulled forward before the
  backing host lands.
- **Custom comparator-only collation residual**: a PK collation whose
  comparator distinguishes case while key bytes fall back to NOCASE could make
  a flush tombstone visible to the probe at the colliding key (probe says
  "absent" → insert path → trustedWrite INTERNAL guard trips where the old
  committed-only probe took the update path). This is the same documented
  store-collation residual called out in the source ticket as out of scope; no
  test covers it.
- **Live pending views**: `getPendingOpsForStore` now returns the live bucket
  instead of a snapshot. All in-repo callers consume immediately; the doc
  comment forbids retention. Worth a second pair of eyes on
  `findUniqueConflict`'s loop (it iterates the committed store while holding
  the view, but performs no coordinator mutations mid-iteration).
- **RYOW visibility is per-table-coordinator, not per-connection**: any
  in-process transaction on a table is visible to all readers of that table
  through the same module. That is exactly the posture the ticket specified
  (and what the UNIQUE-check paths already did), now extended to scans.
- `iterateEffective`'s `reverse` path has no engine-level caller yet (query()
  never passes it); it is covered only by the direct harness test.
- `scanPKRange` still full-scans + post-filters (existing TODO untouched);
  wiring `buildPkPrefixBounds` into user range scans is the pre-existing
  `backlog/store-pk-range-seek` ticket.
- `buildIndexPrefixBounds`' return-type change (`lt` now optional) compiles
  everywhere in-repo; out-of-repo consumers of `@quereus/store` would see a
  type-level change (backwards compatibility explicitly out of scope per
  AGENTS.md).
