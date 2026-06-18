description: The persistent store now shares one transaction coordinator across all of a storage module's tables, so a transaction that writes several tables commits as a single all-or-nothing batch — a crash can no longer leave two tables out of sync.
prereq:
files:
  - packages/quereus-store/src/common/transaction.ts          # default-store machinery removed; pure handle addressing; depth-idempotent savepoints
  - packages/quereus-store/src/common/store-module.ts          # single moduleCoordinator; getCoordinator() no-args; teardown/rename/close
  - packages/quereus-store/src/common/store-table.ts           # attachCoordinator() no-args; data ops + read views pass the data-store handle
  - packages/quereus-store/src/common/store-connection.ts      # added readonly owner? for incarnation pinning
  - packages/quereus-store/src/common/backing-host.ts          # ownsConnection by table identity; resolve+pass data store; connect() sets owner
  - packages/quereus-store/src/common/index.ts                 # dropped DefaultStoreSource export
  - packages/quereus-store/test/transaction.spec.ts            # rewritten to explicit-handle; + cross-table-atomic, savepoint-idempotency, commit-ordering
  - packages/quereus-store/test/store-ryow.spec.ts             # getCoordinator() no-args; pending ops queued with data-store handle
  - packages/quereus-store/README.md                           # § Atomic multi-store commit → module-wide cross-table
  - docs/materialized-views.md                                 # § Cross-module atomicity: module-wide commit now EXISTS; gate-5 drop tracked separately
  - docs/sync.md                                               # "per module" coordinator, cross-module caveat
  - docs/coordinator.md                                        # scope-correction note (module-scoped, no default store)
difficulty: hard
----

# Module-scoped transaction coordinator (cross-table atomic commit) — review

## What landed

The per-table `TransactionCoordinator` became **one coordinator per storage
module**, shared by every `StoreConnection` the module owns. Because the engine
commits virtual-table connections **sequentially** (`database-transaction.ts:271`)
and `commit()`/`rollback()` are **idempotent**, the first store connection to
commit flushes **all** the module's accumulated ops in one batch; the rest no-op.
With a provider that exposes `beginAtomicBatch()`, that single batch spans every
touched store of every table → cross-table all-or-nothing commit. Without it, one
`batch()` per store (no worse than the prior per-table commits, which were already
non-atomic across tables).

### The core mechanic: addressing went fully explicit

The old default-`null` bucket (data ops queued with no store arg) was ambiguous
once one coordinator serves many tables, so it was removed entirely:

- `transaction.ts`: dropped `DefaultStoreSource`, `storeSource`/`resolvedStore`/
  `storePromise`, `resolveStore()`, `getStore()`, `bucketKey()`, and the `| null`
  on `pendingIndex`/`opsByStore`. `put`/`delete` now take a **required** `store`;
  `getPendingOpsForStore`/`getOrderedPendingOps` take a **required** `store`.
  Constructor is now `(eventEmitter?, atomicBatchFactory?)`.
- Every call site passes the concrete data-store handle: `update()` (insert/
  update/delete arms), `deleteRowAt`, and the read paths `iterateEffective`,
  `findUniqueConflict`, `readEffectiveRowByKey` — all already had
  `store = await this.ensureStore()` in scope. Index ops already carried an
  explicit `indexStore` handle and are unchanged. The backing host resolves
  `await this.table.openDataStore()` once per `applyMaintenance`/`applyReplaceAll`
  and passes it to every coordinator op.

### Savepoints became module-wide → made idempotent

`Database.registerConnection` replays the active savepoint stack onto every newly
registered connection, and `_createSavepointBroadcast` broadcasts each new
savepoint to all connections. With one shared stack, N connections (+ replay) all
push the SAME depth. Fix: `createSavepoint(depth)` now **pushes only when
`savepointStack.length === depth`** (a `length > depth` call is a duplicate → no-op).
`release`/`rollbackToSavepoint` were already depth-addressed/idempotent — verified,
comments added, behavior unchanged (out-of-range still warns, never throws).

### Incarnation pinning moved from coordinator identity to table identity

Coordinator identity can no longer distinguish incarnations (all module
connections share it). `StoreConnection` gained an optional `readonly owner?`,
set to the owning `StoreTable` **only** by `StoreBackingHost.connect()`; ordinary
DML connections leave it `undefined`. `ownsConnection(conn)` now compares
`conn instanceof StoreConnection && conn.owner === this.table`. `StoreModule`
evicts the StoreTable from `this.tables` on destroy/rename, so a drop+recreate
yields a fresh instance and the old incarnation's connections are rejected.

### Teardown / rename / close

- `tearDownTableStorage` no longer evicts the coordinator (it is module-wide;
  sibling tables still use it).
- `renameTable` flushes **the module** coordinator if in-transaction (DDL-commits
  the whole module txn — every table's pending ops — in one batch).
- `closeAll` clears the single `moduleCoordinator` field.

## Validation performed (all green)

- `yarn workspace @quereus/store run typecheck` — clean.
- `yarn workspace @quereus/store run test` — **646 passing**.
- `yarn workspace @quereus/plugin-indexeddb run typecheck` + `test` — **73 passing**
  (the IDB atomic-batch path now spans tables; unchanged batch reuse).
- `yarn workspace @quereus/quereus run typecheck` — clean (engine untouched).
- `yarn test` (all workspaces) — **EXIT 0**, 6364 + others passing, 0 failing.

## Tests to exercise / extend (this is a floor, not a ceiling)

New `transaction.spec.ts` blocks worth re-reading adversarially:

- **cross-table atomicity** — two tables (data + index = 4 distinct handles) commit
  in one `AtomicBatch.write()` (asserts `writeCalls === 1`, all 4 handles present);
  a `failWrite` fault leaves **all** tables unchanged AND pre-seeded committed state
  intact; capability-absent → one batch per store.
- **module-wide savepoints (idempotency)** — duplicate `createSavepoint(0)`
  (registration replay) does not double-push (verified via the out-of-range warn on
  `rollbackToSavepoint(1)`); a broadcast second savepoint records one entry;
  `rollbackToSavepoint(0)` after an idempotent savepoint undoes post-savepoint ops
  across **both** tables while pre-savepoint survive.
- **idempotent commit/rollback ordering** — second `commit()` no-ops; `rollback()`
  after `commit()` no-ops.

Suggested additional adversarial angles the reviewer may want:

- An **end-to-end SQL** cross-table atomicity test (two store tables in one
  `begin … commit`) over a *real* provider, not just the coordinator unit test +
  spy. The unit tests model "atomic" with an in-memory spy because `InMemoryKVStore`
  can't crash; the genuine durable cross-table path is only exercised by the IDB
  suite today.
- A backing-host + same-module source committing in one batch at the SQL level
  (MV-over-source), confirming reads-own-writes across the two mid-transaction.

## Known gaps / honest caveats

- **`yarn test:store` (LevelDB) was NOT run** — slow / native, not agent-runnable
  (deferred to human/CI per ticket). IMPORTANT NUANCE: the ticket assumed it only
  exercises the fallback path, but `store-leveldb-shared-root` has landed —
  `LevelDBProvider.beginAtomicBatch()` exists (`packages/quereus-plugin-leveldb/
  src/provider.ts:282`, with its own `atomic-batch.spec.ts`). So `test:store` would
  now exercise the **module-wide atomic cross-table** path over a real durable
  store, which CI has not yet run for this change. **Recommend a human/CI
  `yarn test:store` run** as the highest-value follow-up verification.
- **`StoreConnection.getCoordinator()` is now unused** (the only caller,
  `ownsConnection`, switched to `owner`). Kept as a harmless public accessor; the
  reviewer may choose to remove it.
- **`ownsConnection` is now stricter.** Previously (per-table coordinator) it
  accepted any connection sharing that coordinator — which on the same table
  included ordinary DML connections. Now it accepts only host-created connections
  (`owner === this.table`), matching the memory host's "only connections this
  incarnation created" intent. The engine only ever passes the host's own
  connection to `applyMaintenance`/`scanEffective`, and all 646 store tests pass,
  but this is a deliberate behavior tightening worth a second look.
- **Stats-callback accumulation (slow leak under DDL churn).** Each StoreTable
  instance registers one `{onCommit, onRollback}` pair on the shared coordinator
  (once per instance, via the `if (!this.coordinator)` guard). The module
  coordinator now lives for the module's lifetime, and nothing **de**registers a
  pair, so a drop/recreate or rename/reconnect cycle leaves the old pair (and, via
  its `() => this.applyPendingStats()` closure, the old StoreTable instance)
  retained — the ticket's "old instance is evicted and GC'd" is slightly
  optimistic on that last point. Not a correctness issue (a stale callback's
  `pendingStatsDelta` is 0 → early return) and bounded by DDL-churn count, not data
  size; the old per-table coordinator avoided it only because it was evicted with
  the table. If the reviewer considers it material, the fix is to deregister on
  `tearDownTableStorage`/disconnect (would need a `registerCallbacks` handle/return).
- **Cross-MODULE atomicity remains out of scope** (store + memory, or two durable
  modules) — coordinated commit is not 2PC; documented in `docs/materialized-views.md`
  § Cross-module atomicity. "Per module" is the boundary.
- **Gate-5 drop NOT done here.** This ticket delivers the coordinator refactor; the
  MV adopt fast-path gate-5 drop it *enables* has an unresolved staleness-durability
  question and is the separate plan ticket `store-adopt-atomic-gate-drop`
  (`tickets/plan/9-...`, `prereq: store-module-wide-coordinator`). Docs were updated
  to say module-wide cross-table atomic commit now EXISTS while keeping gate 5.

## Reviewer focus suggestions

- Confirm the handle-identity invariant: a StoreTable's `this.store` (cached via
  `ensureStore`) is the SAME handle used for both queuing data ops and reading
  pending views, so a table's data ops always bucket where its reads look. Two
  tables → two distinct `provider.getStore` handles → separate buckets (the whole
  point). Check there is no path that queues with one handle and reads with another.
- Confirm the depth-idempotency guard can't *suppress a legitimate* savepoint:
  savepoints are created in increasing-depth order, so `length === depth` is exactly
  the "next" push; a `length < depth` gap (which would now no-op) only arises from
  the in-order replay that fills 0..activeDepth.
