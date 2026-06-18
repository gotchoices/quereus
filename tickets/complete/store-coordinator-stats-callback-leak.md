description: A long-lived persistent-store process that drops, recreates, or renames tables many times used to slowly leak memory; this change makes those operations release the old table objects so memory no longer creeps up.
prereq:
files:
  - packages/quereus-store/src/common/transaction.ts                    # registerCallbacks → disposer; callbackCount getter
  - packages/quereus-store/src/common/store-table.ts                    # coordinatorDisposer field; attachCoordinator captures it; hard dispose()
  - packages/quereus-store/src/common/store-module.ts                   # tearDownTableStorage + renameTable call table.dispose()
  - packages/quereus-store/test/transaction.spec.ts                     # unit disposer/callbackCount tests
  - packages/quereus-store/test/coordinator-callback-leak.spec.ts       # integration test (drop/recreate + rename through Database/StoreModule)
difficulty: medium
----

# Complete: store coordinator deregisters stats callbacks on hard table eviction

## What shipped

The module-wide `TransactionCoordinator` accumulated `{onCommit, onRollback}`
stats-callback pairs forever — each `StoreTable` registers one on its first write,
and the closures capture `this`, so every drop+recreate / rename cycle pinned the OLD
instance for the module's lifetime (a leak bounded by DROP/CREATE/RENAME count).

The fix:
- `TransactionCoordinator.registerCallbacks` returns an identity-matched disposer;
  added a test-only `callbackCount` getter.
- `StoreTable` captures the disposer in `coordinatorDisposer` and adds a hard
  `dispose()` (flush pending stats, run disposer, null coordinator + disposer;
  idempotent).
- `StoreModule.tearDownTableStorage` (drop/reclaim) and `renameTable` (rename) call
  `table.dispose()` instead of `disconnect()`. `closeAll` (drops the whole
  coordinator) and the per-scan `disconnect()` (soft, must stay hooked mid-life) were
  correctly left alone.

Implementation commit: `1d8def4a`. See that commit message / the implement-stage
ticket for the full rationale.

## Review findings

Adversarial pass over commit `1d8def4a`, read diff-first before the handoff summary.

### Verified correct (checked, no change needed)

- **Disposer mechanics / no iterate-during-mutate.** `registerCallbacks` returns a
  closure that splices `this.callbacks` by `indexOf(callbacks)` (reference identity —
  sound, since each `attachCoordinator` registers a fresh object literal). The splice
  only ever runs at `dispose()` time, never inside `commit()`/`rollback()`'s fire
  loops. Confirmed `applyPendingStats`/`discardPendingStats` cannot synchronously
  trigger a table drop, so no callback can mutate the array mid-fire. ✓
- **Idempotency / re-attach.** After `dispose()`, `coordinatorDisposer` and
  `coordinator` are null; a double-`dispose` no-ops (disposer null, `flushStats`
  guarded by `mutationCount > 0` which `flushStats` already zeroed); a re-
  `attachCoordinator` on the same instance registers a fresh pair (guarded by
  `if (!this.coordinator)`), never double-registers. ✓
- **Never-written table.** No `attachCoordinator` ⇒ `coordinatorDisposer` is null ⇒
  `dispose()`'s deregister is a no-op. The "rename a created-but-never-written table"
  adversarial probe holds (no throw, no spurious deregister). ✓
- **All eviction sites covered.** Every `this.tables.delete`/`clear`:
  `tearDownTableStorage` → `dispose()` (shared by live `drop` and
  `reclaimDetachedTable`); `renameTable` → `existing.dispose()`; `closeAll` →
  `disconnect()` then drops the whole coordinator (deregistration would be wasted
  work — correct to leave as `disconnect`). ✓
- **No base-class collision.** `VirtualTable` defines no `dispose`/`[Symbol.dispose]`;
  the new async `dispose()` is a plain method, not a `using`/disposable protocol hook.
  No override hazard. ✓
- **Index paths.** `create/drop index` go through `markDdlSaved`/`releaseIndexStore`,
  never register coordinator callbacks (only `attachCoordinator` does, once per
  instance) — confirmed they need no deregistration. ✓
- **Call-site compatibility.** Changing `registerCallbacks`'s return from `void` to
  `() => void` is backward-compatible; the only callers are
  `StoreTable.attachCoordinator` and the tests. ✓
- **Tests are a genuine floor.** Unit specs cover disposer-removes-exact-pair,
  double-dispose-no-op, disposed-callback-silent-on-commit-AND-rollback, and
  O(live)-not-O(N) over 50 cycles. The integration spec drives the REAL drop/recreate
  and ping-pong-rename paths through `Database`+`StoreModule` and asserts
  `callbackCount` returns to baseline. Re-ran green (see below).

### Major — filed as follow-up (NOT fixed here)

- **Residual `StoreTable` leak for MV-using-store backings via `StoreConnection.owner`.**
  The handoff's "the instance becomes GC-eligible" claim is true for REGULAR tables
  (their connection's `owner` is undefined, so deregistering the coordinator callback
  is sufficient — the integration test exercises exactly this and is fully effective).
  But `StoreBackingHost.connect()` stamps `owner = this.table` on the connection, and
  store connections are **never removed from `Database.activeConnections`** until db
  close: `unregisterConnection` is defined-but-never-called, and the per-table
  `removeConnectionsForTable` matches on the *qualified* name while `StoreConnection`
  carries the *simple* name (`StoreTable` supers with `tableSchema.name`). So for a
  dropped/renamed `create materialized view … using store`, the evicted `StoreTable`
  stays pinned `Database → activeConnections → StoreConnection.owner → StoreTable`,
  for the db lifetime — a parallel leak this ticket's coordinator fix does not reach.
  Same root cause (module-wide-coordinator refactor moved incarnation identity onto
  the instance), pre-existing, and engine-side (connection lifecycle + name matching),
  so it needs its own investigation/design rather than an inline fix.
  → **`tickets/fix/store-backing-host-connection-owner-leak.md`**.

### Minor — noted, deliberately not changed

- **`renameTable` disposes `existing` BEFORE `this.tables.delete(oldKey)`**, whereas
  `tearDownTableStorage` deletes from `this.tables` synchronously (pre-`await`) so a
  concurrent reconnect can't observe a stale instance mid-teardown. The rename
  ordering is asymmetric, but it is **pre-existing** (the prior code also `await
  existing.disconnect()`-ed before the delete) and not a regression from this diff;
  rename runs under schema serialization and a reconnect that did grab the disposed
  instance self-heals (next write re-`attachCoordinator`s). Left as-is.
- **`dispose()` flushes stats to a store about to be deleted** (drop path:
  `dispose()` runs before `deleteTableStores`). Wasteful but harmless, and identical
  to the teardown-time `disconnect()` it replaces. Left as-is.

### Docs

- Touched files have no user-facing doc that describes coordinator callback
  registration/teardown; `docs/` has no stale claim about this internal mechanism.
  The in-code doc comments (`attachCoordinator`, `dispose`, `registerCallbacks`,
  `tearDownTableStorage`/`renameTable` eviction notes) were updated by the implement
  diff and now reflect the new reality (verified the old "old instance is evicted and
  GC'd" comment — which was the bug — is gone). No doc change required.

### Validation (re-run during review)

- `yarn workspace @quereus/store typecheck` (`tsc --noEmit`) → **exit 0**.
- `yarn workspace @quereus/store test` → **656 passing** (includes the new specs; the
  stderr noise is from intentional negative-path tests).
- **Lint:** the `@quereus/store` package has no eslint script (per AGENTS.md, only
  `packages/quereus` does); `tsc` is the type-safety gate for this package and passed.
- `yarn test:store` (LevelDB provider path) was **NOT run** — it routinely exceeds the
  ~10-min agent idle budget; deferred to CI (carried over from the implement handoff).
  The `dispose()` change sits on the drop/rename teardown path `test:store` exercises;
  risk is low (dispose subsumes disconnect) but it has not been validated against the
  real provider.

## Known gaps carried forward

- No GC/heap-snapshot assertion (the test asserts the deregistration that makes
  reclamation possible, an in-memory `callbackCount` proxy — faithful for the
  coordinator path).
- `dispose()` interleaved with a concurrent reconnect mid-teardown is not directly
  covered.
- The MV-using-store residual leak (above) is tracked separately in
  `store-backing-host-connection-owner-leak`.
