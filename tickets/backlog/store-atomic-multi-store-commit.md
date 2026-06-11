description: Optional provider capability for an atomic multi-store write batch, so one transaction's writes across a table's data store, its index stores, and sibling tables (incl. MV backings) land in ONE durable commit — closing the per-store crash window the store currently accepts.
difficulty: hard
files:
  - packages/quereus-store/src/common/kv-store.ts          # KVStoreProvider capability surface
  - packages/quereus-store/src/common/transaction.ts       # commit currently writes one batch per store
  - packages/quereus-plugin-leveldb/src/provider.ts        # one separate LevelDB database per table today
  - packages/quereus-plugin-indexeddb/                     # IDB object stores CAN share one transaction
----

# Atomic multi-store commit (provider capability)

Verified during the `store-mv-backing-host` plan research: the store's
durability granularity is one KV batch per store. `TransactionCoordinator`s
are per table; `commit()` groups pending ops by target store and awaits one
`batch().write()` per store sequentially. The LevelDB provider opens a
**separate database per table/index**, so no cross-store batch is possible. A
crash between batches leaves:

- a table's data store and its secondary-index stores divergent (no healing
  mechanism exists today);
- two tables written in one transaction divergent;
- an MV's source and its store-hosted backing divergent (healed today by the
  rehydrate refill / clean-shutdown gate from `mv-adopt-fast-path`).

## Expected behavior / use case

An optional provider capability (e.g. `batchAcross(ops: Map<storeName, BatchOp[]>): Promise<void>`
or a shared-root design where all stores are sublevels/column-families of one
physical database, as `abstract-level` sublevels and IndexedDB's multi-store
transactions both support) that the coordinator/module layer detects and uses
to emit one atomic commit per transaction per module. Providers without the
capability keep today's per-store batches and documented windows.

Benefits when present:
- secondary indexes can never diverge from data across a crash;
- the MV adopt fast path can drop its clean-shutdown gate for same-module
  backings (see `docs/materialized-views.md` rehydrate semantics) — gate (4)
  alone becomes sufficient;
- sync/event consumers observe transactionally-consistent store states.

Specify migration story for existing per-directory LevelDB layouts (or scope
the capability to new providers only).
