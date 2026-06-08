---
description: Fixes ROLLBACK TO landing on lazily-attached vtab connections by replaying the active savepoint stack onto any connection registered mid-transaction. Affects every vtab module that registers connections lazily (memory, isolation overlay, store).
files:
  packages/quereus/src/core/database.ts              # registerConnection replay loop
  packages/quereus/src/core/database-transaction.ts  # getActiveSavepointDepth
  packages/quereus-isolation/src/isolated-table.ts   # removed double-push from ensureOverlay
  packages/quereus/test/logic/04a-savepoint-lazy-attach.sqllogic  # new regression file
  packages/quereus-isolation/test/isolation-layer.spec.ts         # new regression test
  packages/quereus/test/logic.spec.ts                # un-excluded 04-transactions.sqllogic from MEMORY_ONLY_FILES
  docs/module-authoring.md                           # registerConnection table entry now mentions savepoint replay (review)
---

## Summary

`Database.registerConnection` called `connection.begin()` when registering a
`VirtualTableConnection` mid-transaction but did **not** replay the active
savepoint stack onto the freshly-registered connection. Any SAVEPOINTs taken
before the connection existed were invisible to it, so a subsequent
`ROLLBACK TO` / `RELEASE` targeting one of those depths silently no-op'd
out-of-range on the new connection (memory module) or threw
`StatusCode.NOTFOUND` (store module).

This affected every vtab module that registers connections lazily on first
read/write:

1. Memory module's `MemoryVirtualTableConnection` (`MemoryTable.ensureConnection`).
2. Isolation layer's covering `IsolatedConnection` (`IsolatedTable.ensureConnection`).
3. The overlay's `MemoryVirtualTableConnection` registered by
   `IsolatedTable.ensureOverlay`'s pre-alignment path.
4. Store module's `StoreConnection` (`StoreTable.ensureCoordinator`).

## Implementation

- **`TransactionManager.getActiveSavepointDepth()`** (new, `database-transaction.ts:163`) —
  depth-only API; no name leakage.

- **`Database.registerConnection`** (`database.ts:1452-1465`) — after the successful
  `connection.begin()` branch, replay each savepoint depth `i ∈ [0, activeDepth)`
  by calling `await connection.createSavepoint(i)`. Errors are logged and
  replay continues, matching the `begin()` path's robustness.

- **`IsolatedTable.ensureOverlay`** (`isolated-table.ts:147-156`) — removed the
  explicit `createSavepoint(depth)` loop over `savepointsBeforeOverlay`. With
  the replay in `Database.registerConnection`, the loop becomes a double-push
  and corrupts the overlay's `MemoryVirtualTableConnection.savepointStack`
  (broke the existing `mixed pre/post-overlay savepoints` test in the
  implement-stage prototype). We still pre-register the `preAlignedConn` so
  `MemoryTable.ensureConnection` reuses it instead of creating a fresh one on
  the first `overlay.update()`.

- **`logic.spec.ts`** — `04-transactions.sqllogic` removed from
  `MEMORY_ONLY_FILES`. Now passes in store mode.

- **`test/logic/04a-savepoint-lazy-attach.sqllogic`** (new) — four sqllogic
  cases exercising the bug at the SQL level:
  1. SAVEPOINT before any access → INSERT → ROLLBACK TO undoes it.
  2. Nested savepoints before any access → INSERT inside → ROLLBACK TO outer
     + RELEASE outer.
  3. Prior committed write + nested savepoints inside tx → ROLLBACK TO inner
     keeps outer-era write, ROLLBACK TO outer clears it, committed base
     intact.
  4. SELECT-before-SAVEPOINT (validates the pre-existing
     `savepointsBeforeOverlay` path remains correct alongside the new
     `registerConnection` replay).

- **`isolation-layer.spec.ts`** (new test) — `savepoint before any access:
  rollback to savepoint undoes lazy-registered connection writes`. Focused
  regression for Case 1 using the IsolationModule + MemoryTable harness.

## Review findings

### What I checked

- The full diff in `b1009e96` (implement) — re-read with fresh eyes before
  the handoff notes.
- Cross-tree consistency of `createSavepoint(depth)` semantics:
  - `MemoryVirtualTableConnection` → `MemoryTableConnection.createSavepoint`
    (`vtab/memory/layer/connection.ts:87`) lazily creates `pendingTransactionLayer`
    and pushes an empty snapshot — safe to replay on a fresh connection.
  - `StoreConnection` → `Transaction.createSavepoint`
    (`quereus-store/src/common/transaction.ts:178`) starts an implicit
    transaction if needed and pushes a `{opIndex: 0, eventIndex: 0}`
    snapshot — also safe to replay.
  - `IsolatedConnection.createSavepoint`
    (`quereus-isolation/src/isolated-connection.ts:72`) fires
    `onConnectionSavepoint` (populates `savepointsBeforeOverlay`) and
    forwards to overlay/underlying sub-connections (both undefined at
    lazy-register time) — safe to replay.
- The replay's tolerance to a failed `begin()` (logged, replay still
  attempted) is intentional and matches the existing register-flow
  robustness pattern.
- `getActiveSavepointDepth()` correctly snapshots the depth synchronously
  before the loop; the `_withMutex`-wrapped batch executor prevents
  intervening savepoint mutations.
- Lint passes (`yarn workspace @quereus/quereus run lint`, exit 0).
- `yarn test` (root) — 3099 passing in quereus, 68 passing in isolation,
  plus all other packages. The only failure is the unrelated, pre-existing
  `Comprehensive Demo Plugin` delete/update test (module-level `Map` shared
  state in sample-plugins).
- `yarn test:store` — 654 passing, 1 failing
  (`41.4-alter-add-column-constraints.sqllogic` —
  `StoreModule.alterTable` NOT-NULL backfill); confirmed pre-existing on
  `main` by the implementer.
- `04-transactions.sqllogic` now passes in store mode (was excluded).
- Documentation sweep: `docs/design-isolation-layer.md`,
  `docs/runtime.md`, `docs/architecture.md` — none describe the
  connection-registration replay at the level this change touches; only
  `docs/module-authoring.md` has a `registerConnection` description that
  was silent on savepoint replay.

### Findings

#### Minor — fixed in this pass

- **Doc gap on `registerConnection`**. `docs/module-authoring.md` listed
  `registerConnection(conn)` with "If a transaction is already active,
  `begin()` is called on the connection," but said nothing about the
  savepoint replay that now also fires. Updated that table row to
  describe the replay so future module authors writing lazy-registration
  code know the framework takes care of alignment.

#### Minor — left as-is (rationale)

- **Test docstring nit (Case 4 of `04a-savepoint-lazy-attach.sqllogic`)**.
  The comment claims "The SELECT registers an IsolatedConnection for t1
  before the savepoint, so onConnectionSavepoint fires." In isolation
  mode the SELECT takes the fast path
  (`!overlayTable || !hasChanges`) in `IsolatedTable.query` and does
  **not** call `ensureConnection`; what actually pre-registers the
  `IsolatedConnection` is the autocommit INSERT in the prior step (which
  survives across autocommit since `disconnect` is not auto-called).
  Net effect on the test is identical — the IsolatedConnection IS
  registered before the savepoint, so the pre-overlay path still fires
  exactly as intended. Left the comment alone to keep the diff focused;
  noting here for whoever next touches the file.

#### Major — none

No findings warranting a follow-up ticket.

### What I did NOT check

- No new tests added for **store-direct** lazy registration outside the
  sqllogic file (already runs under both modes after un-excluding
  `04-transactions.sqllogic`). A store-specific edge case, if it ever
  emerges, should land next to the isolation regression tests.
- I did not audit every other vtab module in the repo for lazy
  registration — the change is at the `Database.registerConnection`
  layer so it benefits all of them uniformly, but bespoke connection
  implementations that maintain savepoint state via something other than
  `createSavepoint(depth)` would not auto-benefit.

### Known gaps inherited from implement (still valid, still acceptable)

- The `savepointsBeforeOverlay` set is now partially redundant with the
  `registerConnection` replay: the replay handles overlay-connection
  alignment, but the set still drives (a) the
  `ensureOverlay`-time pre-registration guard and (b) the
  `onConnectionRollbackToSavepoint` "clear the IsolationModule's
  connection-scoped overlay state" signal. Removing the set would
  require redesigning that signal — explicitly out of scope.
- The replay loop swallows per-depth `createSavepoint` failures. Matches
  the existing `begin()` failure handling; stricter behavior would be a
  whole-flow change.
