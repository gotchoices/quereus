description: ROLLBACK TO SAVEPOINT through overlay hits misaligned savepoint stack — fixed
files:
  packages/quereus-isolation/src/isolation-module.ts
  packages/quereus-isolation/src/isolated-table.ts
  packages/quereus-isolation/test/isolation-layer.spec.ts
  packages/quereus/src/vtab/memory/layer/transaction.ts
  packages/quereus/test/logic.spec.ts
----

## What was built

### Root cause

The original ticket described a crash (`TransactionLayer` with undefined schema). Investigation revealed the actual failure mode is subtler: when an overlay `MemoryVirtualTableConnection` is registered with the DB **after** one or more savepoints have already been created, its internal savepoint stack starts at index 0 while the DB's depth counter is already at N. The DB then calls `rollbackToSavepoint(N)` on the connection and `N >= savepointStack.length` → the rollback is silently skipped, leaving overlay data that should have been rolled back intact.

A secondary bug: `savepointsBeforeOverlay` was an instance-level field on `IsolatedTable`, but the runtime creates a **fresh** `IsolatedTable` instance per statement (via `module.connect()`). The savepoint callback fires on instance A; `ensureOverlay()` runs on instance B — B's set was always empty so the alignment code never triggered.

### Changes

**`packages/quereus-isolation/src/isolation-module.ts`**
- Added `preOverlaySavepoints: Map<string, Set<number>>` — connection-scoped set of savepoint depths that pre-dated the overlay, keyed identically to `connectionOverlays`.
- Added `getPreOverlaySavepoints()`, `clearPreOverlaySavepoints()` accessors.
- `closeAll()` also clears `preOverlaySavepoints`.

**`packages/quereus-isolation/src/isolated-table.ts`**
- Replaced the instance-level `savepointsBeforeOverlay: Set<number>` field with a computed getter that delegates to `isolationModule.getPreOverlaySavepoints(this.db, ...)`. All instances for the same connection now see the same set.
- In `ensureOverlay()`: when `savepointsBeforeOverlay` is non-empty, pre-register the overlay's connection with the DB and call `createSavepoint(depth)` on it for each pre-overlay depth (in ascending order). This pads the overlay's savepoint stack so that subsequent `rollbackToSavepoint(N)` broadcasts land on the correct index.
- `onConnectionCommit` / `onConnectionRollback` now call `clearPreOverlaySavepoints` instead of `savepointsBeforeOverlay.clear()`.

**`packages/quereus/src/vtab/memory/layer/transaction.ts`**
- `TransactionLayer` constructor now validates `parent.getSchema()` and throws a clear `QuereusError` (INTERNAL) rather than silently setting `tableSchemaAtCreation = undefined`.

**`packages/quereus-isolation/test/isolation-layer.spec.ts`**
- Added two new `savepoints` tests:
  - `pre-overlay savepoint: rollback to savepoint created before first write clears overlay`
  - `mixed pre/post-overlay savepoints: rollback to post-overlay sp2 keeps first write, rollback to pre-overlay sp1 wipes all`

**`packages/quereus/test/logic.spec.ts`**
- Removed `101-transaction-edge-cases.sqllogic` from `MEMORY_ONLY_FILES`; the test now passes in store mode.

## Test coverage

- `yarn workspace @quereus/isolation test` — 62 passing (was 60). Re-verified at completion.
- `yarn test:store` — 2432 passing, 13 pending (was 2431 passing, 14 pending; extra pass is `101`).
- `yarn test` (memory mode) — no regressions; pre-existing fuzz test failure unchanged.

## Usage / verification scenarios

1. `BEGIN; SAVEPOINT sp1; INSERT …; ROLLBACK TO sp1; SELECT` → empty result (pre-overlay sp1 clears overlay entirely).
2. `BEGIN; SAVEPOINT sp1; INSERT a; SAVEPOINT sp2; INSERT b; ROLLBACK TO sp2; SELECT` → only `a` visible (post-overlay sp2 rolls back correctly).
3. `BEGIN; SAVEPOINT sp1; INSERT a; SAVEPOINT sp2; INSERT b; ROLLBACK TO sp1; SELECT` → nothing visible (pre-overlay sp1 wipes all).
4. `101-transaction-edge-cases.sqllogic` passes end-to-end in store mode (deeply nested savepoints, mutation types across savepoints, etc.).
