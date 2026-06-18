description: Make one transaction that writes several tables in the persistent store land as a single all-or-nothing commit, so a crash can never leave two tables out of sync, by sharing one transaction coordinator across all of a storage module's tables instead of one per table.
prereq:
files:
  - packages/quereus-store/src/common/transaction.ts          # remove default-store bucket; pure handle addressing; idempotent depth-keyed savepoints
  - packages/quereus-store/src/common/store-module.ts          # getCoordinator() returns ONE module coordinator; teardown/rename/close handling
  - packages/quereus-store/src/common/store-table.ts           # attachCoordinator(); queue/read data ops with explicit data-store handle
  - packages/quereus-store/src/common/store-connection.ts      # carry owning StoreTable for incarnation pinning
  - packages/quereus-store/src/common/backing-host.ts          # queue backing ops with explicit data-store handle; ownsConnection by table identity
  - packages/quereus-store/src/common/index.ts                 # drop DefaultStoreSource export
  - packages/quereus-store/test/transaction.spec.ts            # rewrite default-bucket tests → explicit-handle; add cross-table atomic + savepoint-idempotency tests
  - packages/quereus-store/README.md                           # § Atomic multi-store commit → module-wide cross-table
  - docs/materialized-views.md                                 # § Cross-module atomicity: note module-wide commit now exists (gate-5 drop tracked separately)
difficulty: hard
----

# Module-scoped transaction coordinator (cross-table atomic commit)

Replace the **per-table** `TransactionCoordinator` with **one coordinator per
storage module**, shared by every `StoreConnection` the module owns. Because the
engine commits virtual-table connections **sequentially** (one
`connection.commit()` each, inside `inCoordinatedCommit` —
`packages/quereus/src/core/database-transaction.ts:271`) and the coordinator's
`commit()`/`rollback()` are **idempotent** (`if (!this.inTransaction) return`),
the *first* store connection to commit flushes **all** the module's accumulated
ops in one `AtomicBatch.write()` (when `provider.beginAtomicBatch` is present);
the remaining connections no-op. This closes the crash window where a transaction
touching tables A and B could persist A but not B, and finally makes the
coordinator's own docstring ("Coordinates transactions across multiple tables")
true.

This is the coordinator-refactor half of the parent plan. It delivers cross-table
atomicity. The MV adopt fast-path gate-5 drop that this *enables* is **not** in
this ticket — it has an unresolved staleness-durability question and is tracked
as the plan ticket `store-adopt-atomic-gate-drop` (prereq: this ticket).

## Why the addressing must go fully explicit (the core change)

Today data ops are queued with **no store argument** and land in a per-coordinator
**default (`null`) bucket** that *is* the table's data store; only index ops carry
an explicit `KVStore` handle. Sharing one coordinator across tables makes that
default **ambiguous** — every table's data ops would collide in the single `null`
bucket. The refactor removes the default entirely:

- **Every** op is addressed by explicit `KVStore` handle (data ops included). The
  pending index buckets purely by handle — no `null` key, no `bucketKey`, no
  `DefaultStoreSource` thunk, no `resolveStore()`/`getStore()`/`storePromise`.
- `getPendingOpsForStore(store)` / `getOrderedPendingOps(store)` keep their
  `store` parameter but it becomes **required** — callers always pass the concrete
  data-store handle. Every call site already has it in scope
  (`store-table.ts:905 const store = await this.ensureStore()`;
  read paths `iterateEffective(store,…)`, `findUniqueConflict` /
  `readEffectiveRowByKey` both `await this.ensureStore()`).

This dissolves the original "synchronous `BackingHost.connect()`" problem that
motivated the lazy default thunk: `connect()` needs only the coordinator (obtained
synchronously from the module), never a store handle. The async write paths
(`StoreTable.update`, `StoreBackingHost.applyMaintenance` /`applyReplaceAll`)
resolve the data-store handle before queuing and pass it explicitly.

## Coordinator shape after the change

```
class TransactionCoordinator {
  // construction: (eventEmitter?, atomicBatchFactory?) — NO store source
  put(key, value, store: KVStore): void        // store now REQUIRED
  delete(key, store: KVStore): void             // store now REQUIRED
  getPendingOpsForStore(store: KVStore): PendingStoreOps
  getOrderedPendingOps(store: KVStore): OrderedPendingOps
  // pendingIndex: Map<KVStore, PendingBucket>  — no `| null`
  // commit(): groups opsByStore (Map<KVStore, PendingOp[]>); atomic path
  //           queues every op by its own handle into one AtomicBatch; else
  //           per-store fallback loop (unchanged in spirit)
  // savepoints: depth-keyed + idempotent (see below)
}
```

`StoreModule` holds a **single** `private moduleCoordinator?: TransactionCoordinator`
(replacing the `coordinators: Map`). `getCoordinator()` (drop the `tableKey` /
`config` params on both the `StoreTableModule` interface in `store-table.ts:153`
and the impl in `store-module.ts:1951`) lazily constructs it with
`(this.eventEmitter, () => this.provider.beginAtomicBatch?.())` and returns the
same instance to every table.

## Savepoints become module-wide — and must be idempotent

`Database.registerConnection` (`database.ts:1788`) **replays the active savepoint
stack** onto every newly-registered connection (`for depth in 0..activeDepth:
connection.createSavepoint(depth)`), and `_createSavepointBroadcast`
(`database.ts:1464`) broadcasts each new savepoint to **all** active connections.
With per-table coordinators each call hit a *separate* stack, so the current
push-only `createSavepoint(_depth)` was fine. With **one shared** coordinator,
N connections (plus lazy-registration replay) all push the SAME depth →
**duplicate savepoints, corrupted depth accounting.**

Fix: make `createSavepoint(depth)` **depth-idempotent** — only push when
`this.savepointStack.length === depth`; if `length > depth` the depth is already
recorded by a sibling connection (or replay), so **no-op**. `releaseSavepoint`
(sets `length = targetDepth`) and `rollbackToSavepoint` (re-slices ops to
`savepointStack[targetDepth]`) are already depth-addressed and idempotent under
repeated same-target calls — verify, add a guard comment, leave behavior. The
existing out-of-range warnings (DDL-commit-cleared-the-stack) stay.

## Stats callbacks fan out across all participating tables

Each `StoreTable.attachCoordinator` registers `{ onCommit: applyPendingStats,
onRollback: discardPendingStats }` on the coordinator. With a shared coordinator
the callbacks array now holds one pair **per participating table** — the
coordinator already loops `for (const cb of this.callbacks)`, so all tables'
stats hooks fire on the single commit/rollback. A table that did no work has
`pendingStatsDelta === 0` → `applyPendingStats` early-returns. No double-attach:
`attachCoordinator` registers only on first call per StoreTable instance (the
`if (!this.coordinator)` guard), and a fresh StoreTable instance (drop+recreate)
re-registers against the shared coordinator — acceptable, the old instance is
evicted and GC'd.

## Backing-host incarnation pinning moves to table identity

`StoreBackingHost.ownsConnection` compares `conn.getCoordinator() ===
this.coordinator`. With a module-scoped coordinator **every** store connection
shares it, so coordinator-identity would wrongly accept any module connection
(and a stale connection from a dropped+recreated incarnation). Move pinning to
the **StoreTable instance** identity (evicted on `destroy`/`renameTable`, fresh on
reconnect — the same eviction that today evicts the coordinator):

- give `StoreConnection` an optional `readonly owner?: object` (the owning
  StoreTable), set ONLY when the connection is created by `StoreBackingHost.connect`
  (`new StoreConnection(this.table.tableName, this.coordinator, this.table)`);
  ordinary DML connections (`ensureCoordinator`) leave it `undefined`;
- `ownsConnection(conn) => conn instanceof StoreConnection && conn.owner === this.table`.

## Teardown / rename / close must not drop the shared coordinator per-table

- `tearDownTableStorage` (`store-module.ts:647`) currently
  `this.coordinators.delete(tableKey)` — with one shared coordinator a single
  table's drop must **not** evict it (sibling tables still use it). Remove that
  delete; the shared coordinator lives for the module's lifetime. (StoreTable
  eviction `this.tables.delete` remains — it is now the pinning identity.)
- `renameTable` (`store-module.ts:1663`) flushes the per-table coordinator before
  moving the directory. Becomes: flush the **module** coordinator if in-transaction
  (`if (this.moduleCoordinator?.isInTransaction()) await this.moduleCoordinator.commit()`).
  Note in a comment that this now DDL-commits the whole module transaction (every
  table's pending ops), not just the renamed table's — the correct, consistent
  posture for a store DDL-commit, and the same all-or-nothing batch.
- `closeAll` (`store-module.ts:2593`) `this.coordinators.clear()` → clear the single
  field (`this.moduleCoordinator = undefined`).

## Capability-gated, with safe fallback

Unchanged from the prereq's design: `commit()` re-evaluates `atomicBatchFactory()`
per commit. Present → one `AtomicBatch.write()` spanning every touched store of
every table. Absent → the per-store fallback loop (now iterating more stores, but
each store still gets one `batch().write()`) — **no worse than today**, where N
per-table commits were already non-atomic across tables. LevelDB before
`store-leveldb-shared-root` and any minimal provider keep byte-identical behavior.

## Edge cases & interactions (write these as tests)

- **Cross-table atomicity (the headline).** Two tables (+ their indexes) written in
  one transaction, atomic provider present: assert a single `AtomicBatch.write()`
  carries all stores, and that injecting a fault at write time leaves **all**
  tables unchanged (all-or-nothing). Without the capability: per-store batches,
  behavior matches today.
- **Savepoint idempotency.** Begin txn, write table A (registers conn A), create
  savepoint at depth 0, then first-touch table B mid-transaction so conn B
  registers and `registerConnection` REPLAYS `createSavepoint(0)` → assert the
  shared stack has depth 1, not 2. Then `rollbackToSavepoint(0)` and assert A's
  post-savepoint ops are undone while pre-savepoint ops survive, across both
  tables. Broadcast a second savepoint to all connections → one entry.
- **Empty / no-work connection.** A connection whose table did no work commits as a
  clean no-op (first committer already flushed, or nothing pending → no batch
  opened). `applyPendingStats` with zero delta is a no-op.
- **Idempotent commit/rollback ordering.** The sequential per-connection loop:
  first `commit()` flushes everything; subsequent `commit()`s early-return; a
  rollback after a commit (or vice versa) no-ops. A commit whose atomic write
  REJECTS propagates out of the first connection's commit → engine rolls back →
  `clearTransaction` runs in `finally`; no ops leak into the next transaction.
- **Backing host + same-module source in one batch.** A store-hosted MV's backing
  write (via `applyMaintenance`/`replaceContents` queuing on the shared
  coordinator) and a write to its same-module source commit/rollback together in
  one atomic batch. Reads-own-writes across the two still holds (pending merge
  addressed by each table's data-store handle).
- **Incarnation pinning.** Drop+recreate a backing table; assert a connection from
  the OLD incarnation is rejected by `ownsConnection` (owner StoreTable differs)
  even though both share the module coordinator. A foreign module's connection is
  rejected (not a StoreConnection / different owner).
- **DDL mid-transaction.** `renameTable` / `replaceContents` flushing the module
  coordinator commits the whole module txn; subsequent `commit()` on sibling
  connections no-ops; the savepoint-stack-cleared warnings in
  `release/rollbackToSavepoint` still behave (out-of-range → warn, no throw).
- **Index + data of one table, atomic vs fallback.** The prereq's within-table
  guarantee is preserved (data store + secondary-index stores of one table land in
  the same batch) — now just a subset of the module-wide batch.
- **Out of scope (document, don't implement):** cross-MODULE transactions (store
  backing + memory source, or two durable modules) — coordinated commit is not 2PC;
  that window stays documented in `docs/materialized-views.md` § Cross-module
  atomicity. "Per module" is the boundary.

## Validation

- `yarn workspace @quereus/store run test` and `run typecheck` green
  (rewrite `transaction.spec.ts`'s default-bucket cases to explicit-handle; add the
  cross-table + savepoint-idempotency cases above).
- `yarn workspace @quereus/plugin-indexeddb run test` / `typecheck` green
  (atomic path now spans tables; the IDB batch reuse is unchanged).
- `yarn workspace @quereus/quereus run typecheck` green (the engine commit loop and
  `registerConnection` are unchanged; only store-internal types move).
- `yarn test` green. `yarn test:store` (LevelDB) is slow / not agent-runnable —
  it exercises only the fallback path (no `beginAtomicBatch` until
  `store-leveldb-shared-root`, which is complete but verify whether it now exposes
  the capability); defer to human/CI, document the deferral.
- Docs: update `packages/quereus-store/README.md` § Atomic multi-store commit to
  describe the module-wide (cross-table) scope, and `docs/materialized-views.md`
  § Cross-module atomicity (lines ~116, ~122) to state that module-wide cross-table
  atomic commit now EXISTS, with the adopt gate-5 drop it enables tracked under
  `store-adopt-atomic-gate-drop` (do NOT drop gate 5 here).

## TODO

- Strip the default-store machinery from `transaction.ts`: remove `DefaultStoreSource`,
  `storeSource`/`resolvedStore`/`storePromise`, `resolveStore`, `getStore`,
  `bucketKey`, the `| null` from `pendingIndex`/`opsByStore`. Make `put`/`delete`
  `store` arg required; make `getPendingOpsForStore`/`getOrderedPendingOps` `store`
  arg required. Update `EMPTY_*` usage and the commit grouping to key purely by handle.
- Make `createSavepoint(depth)` depth-idempotent (push only when `length === depth`).
- Constructor: `(eventEmitter?, atomicBatchFactory?)` — drop the store source param.
- `store-module.ts`: replace `coordinators: Map` with one `moduleCoordinator` field;
  `getCoordinator()` (no params) constructs/returns it; fix `tearDownTableStorage`
  (don't evict), `renameTable` (flush module coordinator), `closeAll` (clear field).
- `store-table.ts`: `attachCoordinator()` calls `getCoordinator()`; every
  `coordinator.put/delete(key, …)` passes the data-store `store` handle; every
  `getPendingOpsForStore()/getOrderedPendingOps()` passes `store`.
- `store-connection.ts`: add `owner?` field + constructor param.
- `backing-host.ts`: resolve `const store = await this.table.openDataStore()` once
  per `applyMaintenance`/`applyReplaceAll`, pass it to every `coordinator.put/delete`;
  `connect()` passes `this.table` as owner; `ownsConnection` compares `conn.owner ===
  this.table`.
- `index.ts`: drop the `DefaultStoreSource` export.
- Rewrite/extend `test/transaction.spec.ts`; update `README.md` and
  `docs/materialized-views.md`.
