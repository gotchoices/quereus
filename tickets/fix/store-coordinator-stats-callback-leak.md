description: When a persistent-store table is dropped, recreated, or renamed many times, the old table objects are never fully released, so memory slowly grows in long-lived processes with heavy schema churn.
prereq:
files:
  - packages/quereus-store/src/common/transaction.ts          # registerCallbacks pushes onto a never-pruned array
  - packages/quereus-store/src/common/store-table.ts           # attachCoordinator registers {onCommit,onRollback}; disconnect() is per-scan (NOT a teardown hook)
  - packages/quereus-store/src/common/store-module.ts          # tearDownTableStorage / renameTable evict the StoreTable but never deregister its callbacks
difficulty: medium
----

# Store coordinator: stats-callback accumulation leak under DDL churn

## Problem

The transaction coordinator is now **module-wide** and lives for the module's
entire lifetime (`StoreModule.moduleCoordinator`, cleared only by `closeAll`).
Each `StoreTable` instance registers exactly one `{onCommit, onRollback}` pair on
that shared coordinator the first time `attachCoordinator()` runs
(`store-table.ts`, guarded by `if (!this.coordinator)`).

Nothing ever **de**registers a pair. `TransactionCoordinator.registerCallbacks`
just pushes onto a `private callbacks: TransactionCallbacks[]` that is never
pruned. So every drop+recreate, rename, or reconnect cycle that produces a fresh
`StoreTable` for the same logical table leaves the **old** instance's callback
pair on the coordinator — and because each pair closes over
`() => this.applyPendingStats()` / `() => this.discardPendingStats()`, the closure
retains the evicted `StoreTable` instance, defeating GC.

The result: a slow memory leak bounded by **DDL-churn count** (not data size) over
a module's lifetime. The ticket that introduced the module-wide coordinator
(`store-module-wide-coordinator`) called the "old instance is evicted and GC'd"
claim slightly optimistic — this is that gap.

## Severity / scope

- **Not a correctness bug.** A stale callback's `applyPendingStats` early-returns
  when its `pendingStatsDelta` is 0, and an evicted instance's delta is always 0
  by the time it is evicted (teardown rolls back / commits first, zeroing it). So
  stale callbacks firing on commit/rollback are harmless no-ops.
- **Leak only**, bounded by number of DROP/CREATE/RENAME of store tables within
  one module open — low for typical apps, but unbounded for migration- or
  test-heavy long-lived processes.
- The old per-table coordinator avoided this only incidentally: it was evicted
  together with the table, so its callbacks died with it.

## Expected behavior

Dropping, recreating, or renaming a store-backed table should not retain the old
`StoreTable` instance or its callback pair on the module coordinator. After N
drop/recreate cycles the coordinator's callback array should hold O(live tables)
pairs, not O(N).

## Notes for the implementer

- `registerCallbacks` should return a disposer (or accept a handle) so the pair
  can be removed; `TransactionCoordinator` then splices it out of `callbacks`.
- The deregistration site is **not** `StoreTable.disconnect()` — that is the
  per-scan soft disconnect (called after every query), so deregistering there
  would unhook stats mid-life. The correct sites are the genuine eviction points:
  `StoreModule.tearDownTableStorage` (drop / reclaim) and `renameTable`, which
  already `this.tables.delete(...)` the instance. Consider a dedicated hard
  `StoreTable.dispose()`/`teardown()` that those call, distinct from the
  per-scan `disconnect()`.
- Add a regression test: register a coordinator, attach/detach several StoreTable
  instances (or drive drop+recreate over the in-memory provider), and assert the
  coordinator's callback count returns to baseline.
