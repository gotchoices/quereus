description: The persistent store now shares one transaction coordinator across all of a storage module's tables, so a transaction that writes several tables commits as a single all-or-nothing batch — a crash can no longer leave two tables out of sync.
prereq:
files:
  - packages/quereus-store/src/common/transaction.ts
  - packages/quereus-store/src/common/store-module.ts
  - packages/quereus-store/src/common/store-table.ts
  - packages/quereus-store/src/common/store-connection.ts
  - packages/quereus-store/src/common/backing-host.ts
  - packages/quereus-store/src/common/index.ts
  - packages/quereus-store/test/transaction.spec.ts
  - packages/quereus-store/test/store-ryow.spec.ts          # + cross-table transaction (module-wide coordinator) block (review)
  - packages/quereus-store/README.md
  - docs/materialized-views.md
  - docs/sync.md
  - docs/coordinator.md
----

# Module-scoped transaction coordinator (cross-table atomic commit) — COMPLETE

The per-table `TransactionCoordinator` became **one coordinator per storage
module**, shared by every `StoreConnection` the module owns. Addressing went
fully explicit (every op carries its target `KVStore` handle; the default-store
bucket and `getStore()`/`DefaultStoreSource`/lazy-thunk machinery were removed),
savepoints became depth-idempotent (one shared stack across N connections), and
incarnation pinning moved from coordinator identity to `StoreConnection.owner ===
StoreTable`. The first connection to commit flushes the whole module's pending
ops in one batch (atomic when the provider exposes `beginAtomicBatch`, else
one batch per store); the rest no-op. Full design detail is in the implement
commit `d0594b98` and the doc updates listed above.

## Review findings

Reviewed the implement diff (`d0594b98`) with fresh eyes against SPP, DRY,
modularity, scalability, maintainability, performance, resource cleanup, error
handling, and type safety, then re-derived the tests.

### Verified correct (no action)

- **Explicit-handle addressing — completeness.** Confirmed every former no-arg
  `put`/`delete`/`getPendingOpsForStore`/`getOrderedPendingOps` call site now
  passes a concrete handle (grep clean; only a comment mentions the old form).
  `put`/`delete`'s `store` param is now required, so a missed site would be a
  typecheck error — and typecheck is clean.
- **Handle-identity invariant (the load-bearing one).** `openDataStore()`
  delegates to `ensureStore()`, which caches `this.store`; the backing host queues
  data ops under that exact handle and `iterateEffective` / `findUniqueConflict` /
  `readEffectiveRowByKey` read under the same handle. A table's writes always
  bucket where its reads look; two tables hold two distinct `provider.getStore`
  handles → separate buckets. No path queues with one handle and reads with
  another.
- **Savepoint depth-idempotency.** The `length === depth` guard pushes only the
  "next" savepoint; a `length > depth` call (sibling connection or
  registration replay) no-ops, and the only `length < depth` case is the
  documented post-DDL-commit degraded path (stack cleared, engine still
  broadcasts → warn, never throw). Mid-transaction connection registration is
  safe: `begin()` is guarded, so the replay never wipes already-queued pending
  ops. `release`/`rollbackToSavepoint` remain depth-addressed and idempotent.
- **Commit/rollback across N shared-coordinator connections.** First flushes all
  + fires all events + all callbacks, then `clearTransaction`; the rest no-op.
- **Incarnation pinning / `ownsConnection` tightening.** `owner === this.table`
  rejects stale, foreign-table, and foreign-module connections; the deliberate
  tightening (host-created connections only) is consistent with the memory host's
  intent and all store tests pass.
- **Teardown/rename/closeAll.** A single table's teardown no longer evicts the
  shared coordinator; `renameTable` DDL-commits the whole module txn;
  `closeAll` clears the single field.

### Minor — fixed inline this pass

- **No SQL-level cross-table test existed.** The headline feature (two store
  tables, one transaction, via the shared coordinator) was only covered at the
  coordinator-unit level (spy) and the single-table IDB e2e. Added a
  **`cross-table transaction (module-wide coordinator)`** block to
  `store-ryow.spec.ts` over a real `Database` + in-memory provider: (1) reads own
  writes across two tables mid-transaction + commit persists both; (2) rollback
  discards writes to both; (3) savepoint rollback undoes the tail on both tables
  while the pre-savepoint head survives. Store suite now **649 passing** (was 646).
- **Dead code: `StoreConnection.getCoordinator()`.** The only caller
  (`ownsConnection`) switched to `owner`; the accessor was unused repo-wide
  (verified). Removed it (the private `coordinator` field is still used by
  `begin`/`disconnect`).

### Major — filed as a new ticket (not fixed here)

- **Stats-callback accumulation leak under DDL churn** →
  `tickets/fix/store-coordinator-stats-callback-leak.md`. Each `StoreTable`
  registers an `{onCommit,onRollback}` pair on the now-module-lifetime
  coordinator and nothing deregisters it, so drop/recreate/rename cycles retain
  the old instance via its callback closure. Bounded by DDL-churn count, **not a
  correctness bug** (a stale pair's `pendingStatsDelta` is 0 → no-op), so it is
  deferred rather than fixed inline: the fix needs a disposer on
  `registerCallbacks` plus a genuine hard-teardown hook (NOT the per-scan
  `disconnect()`), which is more than a one-liner.

### Notes (no code change)

- **`yarn test:store` (LevelDB) not run** — slow/native, not agent-runnable.
  Per the implement handoff this now exercises the **real durable cross-table
  atomic** path (`LevelDBProvider.beginAtomicBatch` has landed via
  `store-leveldb-shared-root`), which CI has not yet run for this change.
  **Recommend a human/CI `yarn test:store` run** as the highest-value follow-up
  verification. Not filed as a ticket — it is a CI-run recommendation, not a
  code defect.
- **docs/coordinator.md** retains historical `getStore()` / default-store
  references in its body, but a top-of-file banner (lines 3–14) explicitly
  disclaims them as predating the module-scoped change and lists both
  corrections. Accepted as an honest scope-correction rather than a full rewrite
  of the original isolation-design doc.
- **Cross-MODULE atomicity remains out of scope** (documented in
  `docs/materialized-views.md` § Cross-module atomicity); "per module" is the
  boundary.
- **Gate-5 drop** the coordinator enables is tracked separately in the plan
  ticket `store-adopt-atomic-gate-drop`.

## Validation performed

- `yarn workspace @quereus/store run typecheck` — clean (after inline edits).
- `yarn workspace @quereus/store run test` — **649 passing** (646 + 3 new
  cross-table tests).
- `yarn workspace @quereus/plugin-indexeddb run test` — **73 passing** (atomic
  cross-table path).
- `yarn workspace @quereus/isolation run test` — **128 passing** (coordinator
  mini-transaction consumer).
- No other package constructs `TransactionCoordinator` with the old signature
  (verified; only `store-module.ts` does, plus tests).
- `yarn test:store` (LevelDB) — NOT run (see Notes).
