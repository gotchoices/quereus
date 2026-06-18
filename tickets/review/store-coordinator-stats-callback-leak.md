description: A long-lived persistent-store process that drops, recreates, or renames tables many times used to slowly leak memory; this change makes those operations release the old table objects so memory no longer creeps up.
prereq:
files:
  - packages/quereus-store/src/common/transaction.ts                    # registerCallbacks → disposer; callbackCount getter
  - packages/quereus-store/src/common/store-table.ts                    # coordinatorDisposer field; attachCoordinator captures it; hard dispose()
  - packages/quereus-store/src/common/store-module.ts                   # tearDownTableStorage + renameTable call table.dispose()
  - packages/quereus-store/test/transaction.spec.ts                     # unit disposer/callbackCount tests
  - packages/quereus-store/test/coordinator-callback-leak.spec.ts       # NEW integration test (drop/recreate + rename through Database/StoreModule)
difficulty: medium
----

# Review: store coordinator deregisters stats callbacks on hard table eviction

## What was wrong

The module-wide `TransactionCoordinator` (`StoreModule.moduleCoordinator`, cleared
only by `closeAll`) accumulated `{onCommit, onRollback}` callback pairs forever.
Each `StoreTable` registers one pair the first time `attachCoordinator()` runs (on
its first write). The closures capture `this` (the `StoreTable`), so every
drop+recreate / rename cycle that minted a fresh `StoreTable` for the same logical
table left the OLD instance pinned on the coordinator — a leak bounded by
DROP/CREATE/RENAME count over the module's lifetime, not by data size. Harmless to
correctness (a stale callback's `applyPendingStats` early-returns on a zero delta)
but unbounded for migration-/test-heavy long-lived processes.

## What changed

**`transaction.ts`**
- `registerCallbacks(callbacks)` now returns a disposer `() => void` that splices
  out that EXACT pair (identity-matched via `indexOf`). The splice runs only at
  teardown, never inside the commit/rollback fire loops, so there is no
  iterate-during-mutate hazard.
- Added `get callbackCount(): number` — introspection for tests only (documented
  as not part of the transactional contract).

**`store-table.ts`**
- New `private coordinatorDisposer: (() => void) | null`, captured from the
  `registerCallbacks` return inside `attachCoordinator()`.
- New hard `async dispose()`: best-effort flush of pending stats (same posture as
  the teardown-time `disconnect()` it replaces), run the disposer, then null both
  `coordinatorDisposer` and `coordinator`. Idempotent (double-dispose no-ops; a
  re-`attachCoordinator` after dispose registers a fresh pair, never double-registers).
- Refreshed the stale `attachCoordinator` doc comment (the old "old instance is
  evicted and GC'd" claim was exactly the gap).

**`store-module.ts`**
- `tearDownTableStorage` (the drop / reclaim eviction site): `table.disconnect()`
  → `table.dispose()`.
- `renameTable` (the rename eviction site): `existing.disconnect()` →
  `existing.dispose()`, keeping the existing try/catch (dispose failures must not
  block the physical rename).
- `closeAll` and the per-scan `StoreTable.disconnect()` were intentionally NOT
  touched (closeAll drops the whole coordinator; disconnect is the soft per-scan
  path that must keep stats hooked mid-life).

## Why it's safe

`dispose()` is a strict superset of the teardown-time `disconnect()` it replaces:
same best-effort stats flush, PLUS deregistration. The only behavioral delta is
that the evicted instance's callback pair leaves the coordinator's array — which is
the whole point. A table that was never written (never attached) has a null
disposer, so dispose's deregister step is a no-op — correct.

## How to validate / what to test (reviewer: treat tests as a floor)

Use cases the tests cover:
- **Disposer mechanics** (`transaction.spec.ts` → `callback disposer` describe):
  disposer removes exactly its pair; double-dispose is a no-op (doesn't splice an
  unrelated pair); a disposed callback no longer fires on commit OR rollback;
  `callbackCount` returns to baseline after 50 register→dispose cycles (asserts
  O(live), not O(N)).
- **End-to-end leak path** (`coordinator-callback-leak.spec.ts`): drives the REAL
  eviction path through `Database` + `StoreModule` over an in-memory persistent
  provider —
  - 10× `create table churn … / insert / drop table churn` → `getCoordinator().callbackCount`
    equals the pre-churn baseline (a long-lived `keep` sibling holds the baseline > 0).
  - 6× ping-pong `alter table a rename to b` / write / rename back → callbackCount
    equals the single post-create count (each rename disposes the evicted instance;
    the renamed table re-registers exactly once).

Suggested reviewer probes / adversarial angles:
- Confirm the in-memory `callbackCount` assertion is a faithful proxy for the real
  leak: deregistration is the necessary+sufficient condition for the captured
  `StoreTable` closures to become GC-eligible; the test asserts deregistration, not
  GC itself.
- Drop a table that participated in an OPEN multi-table transaction, then check
  sibling tables still commit/rollback cleanly (dispose splices only the dropped
  table's pair).
- Rename a table that was created but NEVER written (no attach): `existing` may be
  null or have a null disposer — confirm no throw and no spurious deregister.
- CREATE INDEX / DROP INDEX paths call `markDdlSaved`/`releaseIndexStore`, not
  dispose — confirm they don't accidentally need deregistration (indexes don't
  register coordinator callbacks; only the table's stats pair does).

## Known gaps / deferrals (honest handoff)

- **`yarn test:store` (LevelDB store path) was NOT run** — it re-runs the quereus
  logic suite against the real LevelDB provider and routinely exceeds the
  ~10-minute agent idle budget, so it is deferred to CI per the ticket's
  long-running-validation guidance. The `dispose()` change sits squarely on the
  drop/rename teardown path that `test:store` exercises; risk is low (dispose
  subsumes disconnect) but it has NOT been validated against the real provider.
- The integration test uses an in-memory provider; it does not assert actual heap
  reclamation (no GC/heap-snapshot assertion) — it asserts the deregistration that
  makes reclamation possible.
- No test exercises dispose() interleaved with a concurrent reconnect mid-teardown;
  `tearDownTableStorage` evicts from `this.tables` synchronously before any await,
  so a concurrent `getOrReconnectTable` mints a fresh instance — but this race is
  not directly covered here.

## Validation run (all green)

- `yarn workspace @quereus/store test` → **656 passing** (includes the new specs;
  the stderr noise in the log is from intentional negative-path tests).
- New specs run in isolation → 58 passing, 0 failing.
- `yarn workspace @quereus/store typecheck` (`tsc --noEmit`) → exit 0.
- `yarn build` (full sequential repo build) → exit 0.
