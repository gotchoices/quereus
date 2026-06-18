description: When a persistent-store table is dropped, recreated, or renamed many times, the old table objects are never fully released, so memory slowly grows in long-lived processes with heavy schema churn.
prereq:
files:
  - packages/quereus-store/src/common/transaction.ts          # registerCallbacks: make it return a disposer; splice on dispose
  - packages/quereus-store/src/common/store-table.ts           # attachCoordinator stores the disposer; add hard dispose()
  - packages/quereus-store/src/common/store-module.ts          # tearDownTableStorage / renameTable call StoreTable.dispose() at the real eviction points
  - packages/quereus-store/test/transaction.spec.ts            # add regression test for disposer + callback-count baseline
difficulty: medium
----

# Store coordinator: deregister stats callbacks on hard table eviction

## Problem (confirmed)

The module-wide `TransactionCoordinator` (`StoreModule.moduleCoordinator`, cleared
only by `closeAll`) accumulates `{onCommit, onRollback}` callback pairs that are
never removed. Each `StoreTable` registers one pair the first time
`attachCoordinator()` runs:

```
// store-table.ts:520
attachCoordinator(): TransactionCoordinator {
  if (!this.coordinator) {
    this.coordinator = this.storeModule.getCoordinator();
    this.coordinator.registerCallbacks({
      onCommit: () => this.applyPendingStats(),
      onRollback: () => this.discardPendingStats(),
    });
  }
  return this.coordinator;
}
```

`TransactionCoordinator.registerCallbacks` (transaction.ts:135) only pushes onto a
`private callbacks: TransactionCallbacks[]` that nothing prunes. Each closure
captures `this` (the `StoreTable`), so every drop+recreate / rename / reconnect
cycle that mints a fresh `StoreTable` for the same logical table leaves the OLD
instance pinned on the coordinator. Verified leak path:

- `tearDownTableStorage` (store-module.ts:643) does `this.tables.delete(tableKey)`
  + `await table.disconnect()` but never deregisters the callback pair. The inline
  comment already flags the gap ("the coordinator is module-wide … must NOT evict
  it").
- `renameTable` (store-module.ts:1607) likewise `this.tables.delete(oldKey)` +
  `existing.disconnect()` with no deregistration.
- `disconnect()` (store-table.ts:1849) is the **per-scan soft** disconnect (called
  after every query) — it only flushes stats. It is NOT a teardown hook, so it is
  the wrong site to deregister.

Result: a leak bounded by DROP/CREATE/RENAME count over a module's lifetime, not
by data size. Harmless to correctness (a stale callback's `applyPendingStats`
early-returns on a zero `pendingStatsDelta`, and an evicted instance's delta is
always 0), but unbounded for migration-/test-heavy long-lived processes.

## Expected behavior

After N drop/recreate (or rename) cycles, the coordinator's callback array holds
O(live tables) pairs, not O(N). Hard eviction of a `StoreTable` must drop both the
`this.tables` reference (already done) and its coordinator callback pair.

## Design

Give `registerCallbacks` a disposer return, store it on the `StoreTable`, and call
it from a new hard-teardown method invoked at the genuine eviction sites.

### TransactionCoordinator (transaction.ts)

- `registerCallbacks(callbacks): () => void` — push as today, return a disposer
  that removes that exact pair: `const i = this.callbacks.indexOf(callbacks); if (i >= 0) this.callbacks.splice(i, 1);`. Splicing happens at teardown, never
  inside the commit/rollback fire loops, so no iterate-during-mutate hazard.
- Add a test-visible count accessor (e.g. `get callbackCount(): number` returning
  `this.callbacks.length`) so the regression test can assert the baseline without
  reaching into a private field. Keep it minimal and documented as
  introspection-for-tests.

### StoreTable (store-table.ts)

- Hold `private coordinatorDisposer: (() => void) | null = null;` and set it from
  the `registerCallbacks` return inside `attachCoordinator()`.
- Add a hard `dispose()` (distinct from the per-scan `disconnect()`): flush any
  pending stats if appropriate, call `this.coordinatorDisposer?.()`, then null out
  `coordinatorDisposer` and `this.coordinator` so the instance is fully detached
  and a re-attach can't double-register. Make it idempotent (safe to call twice).
- Update the now-stale `attachCoordinator` doc comment (store-table.ts:514-518) —
  the "the old instance is evicted and GC'd" claim is exactly the gap being fixed;
  reword to point at the dispose contract.

### StoreModule (store-module.ts)

- `tearDownTableStorage`: replace the bare `await table.disconnect()` with the hard
  `await table.dispose()` (dispose subsumes the stats flush). The store is deleted
  immediately after, so the teardown-time flush is best-effort like today.
- `renameTable`: the renamed instance is evicted (`this.tables.delete(oldKey)`), so
  swap its `existing.disconnect()` (already wrapped in try/catch) for
  `existing.dispose()`. The next `connect()`/`getOrReconnectTable` mints a fresh
  instance that re-registers against the shared coordinator.
- Do NOT touch `closeAll` — it already drops the whole coordinator
  (`moduleCoordinator = undefined`), so its callbacks die with it; calling
  `disconnect()` per table there is fine and out of scope.

Leave `StoreConnection.disconnect` and the per-scan `StoreTable.disconnect()`
untouched — they are the soft path and must keep stats hooked mid-life.

## Regression test (transaction.spec.ts)

Unit-level is sufficient and matches the existing spec style (a bare
`new TransactionCoordinator(emitter)` with `registerCallbacks`):

- `registerCallbacks` returns a disposer; calling it removes the pair and
  decrements `callbackCount` back to baseline; double-dispose is a no-op.
- A disposed callback no longer fires on commit/rollback (register two pairs,
  dispose one, begin+commit, assert only the survivor's `onCommit` ran).
- Optional but recommended: drive several attach→dispose cycles of real
  `StoreTable` instances over the in-memory provider (see
  `test/memory-store.spec.ts` / `test/reclaim-detached-table.spec.ts` for module
  setup) and assert the coordinator's `callbackCount` returns to O(live tables)
  after N drop/recreate cycles, not O(N).

## Validation

- `yarn workspace @quereus/store test` (or `yarn test` from root) — the store
  package's mocha specs including the new ones.
- `yarn workspace @quereus/quereus lint` is the type-check gate for signature drift
  if the `registerCallbacks` return-type change ripples; the store package has no
  lint script of its own, so rely on `tsc`/build for it.
- `yarn build` to confirm the cross-package types still compile.

## TODO

- [ ] `transaction.ts`: `registerCallbacks` returns a disposer that splices the pair; add `callbackCount` accessor.
- [ ] `store-table.ts`: store the disposer in `attachCoordinator`; add idempotent hard `dispose()`; refresh the stale doc comment.
- [ ] `store-module.ts`: `tearDownTableStorage` and `renameTable` call `table.dispose()` at the eviction points (rename keeps its try/catch).
- [ ] `transaction.spec.ts`: disposer + callback-count baseline + disposed-callback-doesn't-fire tests.
- [ ] Run store tests, build, and the quereus lint/type-check; confirm baseline returns to O(live tables).
