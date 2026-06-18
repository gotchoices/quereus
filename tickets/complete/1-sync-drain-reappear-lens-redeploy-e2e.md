description: A new end-to-end test for reviving a retired table by re-deploying its schema uncovered that the revival could hang forever through the real engine; this fixes that deadlock so held edits replay as live rows, and the test proves it.
prereq:
files:
  - packages/quereus-sync/test/sync/sync-drain-e2e.spec.ts                 # describe block (4 tests) for the lens-redeploy revival trigger
  - packages/quereus-sync/test/sync/_peer-harness.ts                       # lens-deploy listener wiring + deploy/retire/revive helpers
  - packages/quereus-sync/src/sync/sync-manager-impl.ts                    # recordLensDeployment: reactive drain deferred when mid-statement (the deadlock fix)
  - packages/quereus/src/core/database.ts                                  # Database._isExecuting() + exec-mutex depth tracking
  - packages/quereus/src/vtab/module.ts                                    # notifyLensDeployment JSDoc: exec-mutex / re-entrancy note (review add)
  - packages/quereus/test/exec-mutex-reentrancy.spec.ts                    # NEW engine-level unit test for _isExecuting + release idempotency (review add)
  - docs/sync.md                                                           # § Revival / drain — lens-redeploy deferral + e2e coverage
  - docs/migration.md                                                      # § 4 Contract — path (2) deferral note
difficulty: medium
----

# Review complete: real-engine e2e for the lens-redeploy revival path (+ the deadlock it uncovered)

The implementation closed the real-engine parity gap for the lens-redeploy reactive drain
(4 new e2e tests) and, in writing them, surfaced + fixed a real production deadlock: the
lens-deployment listener runs *inside* the `apply schema` statement (which holds the engine
exec mutex), and the reactive drain re-enters the engine via `ingestExternalRowChanges`
(which re-acquires that same mutex). The fix adds `Database._isExecuting()` and defers the
drain to fire-and-forget when mid-statement.

This passed review. The fix is correct, the surface addition is sound, and the work applies
in production (not just under test). Two minor improvements were made inline (below).

## Review findings

### Scope of the adversarial pass
Read the full implement-stage diff (`fc4d86ba`) with fresh eyes before the handoff, then traced
the deadlock claim, the engine surface change, the deferral correctness, the `db`-identity
assumption, error handling, the type surface, production applicability, docs, and test coverage.

### Correctness — the deadlock fix (the load-bearing part) — VERIFIED, no bug
- **Re-entrancy claim is real.** Confirmed `notifyLensDeploymentAll` (`schema-declarative.ts`)
  fires from within `apply schema`'s `_withMutex`, so the mutex is held when the lens listener
  runs. The drain's `ingestExternalRowChanges` (`database-external-changes.ts:142`) re-acquires
  the chained mutex → awaiting inline deadlocks. The conditional `void`-defer breaks it.
- **Deferral is timing-robust.** The detached drain either chains its `_acquireExecMutex` after
  the still-holding statement (runs the instant it releases) or finds the mutex free if the
  statement already released — no deadlock either way.
- **`db` identity holds.** The `db` passed to `recordLensDeployment` (engine-fired hook) is the
  same `Database` instance the store-adapter captured at construction, in BOTH the harness
  (`_peer-harness.ts`) and production (`quereus.worker.ts:687-689`), so `_isExecuting()` checks
  the correct mutex.
- **Fire-and-forget is safe.** `drainReappearedTables` wraps each table in try/catch and swallows
  (logs) every failure, so the `void` cannot produce an unhandled rejection. Verified at source.
- **Release-wrapper change is transparent.** Every `_acquireExecMutex` caller uses the returned
  fn only as `releaseMutex()` in a `finally`; none depend on its identity. The new `released`
  guard makes a double-release idempotent (depth never wraps below zero).

### Production applicability — VERIFIED
The worker (`quereus.worker.ts:687-689`) wires `setLensDeploymentListener` straight to
`syncManager.recordLensDeployment` — the exact method the fix lives in. So a production redeploy
reviving a held table now defers instead of hanging the worker forever. The `Database` surface
only *gained* a method (additive), so the worker needs no change and cannot break.

### Type surface — VERIFIED
`Database._isExecuting()` is deliberately not `@internal`; confirmed it survives `stripInternal`
into the built `dist/src/core/database.d.ts` (line 144), and `@quereus/sync` typechecks against it.

### Minor findings — FIXED INLINE
1. **No engine-level test for the new surface.** `_isExecuting()` and the release-wrapper depth
   tracking were only exercised transitively through the sync e2e. Added
   `packages/quereus/test/exec-mutex-reentrancy.spec.ts` (3 tests) pinning: `_isExecuting()` is
   false at rest / true mid-`apply-schema` (observed via a `notifyLensDeployment` probe — the
   exact re-entrancy point), true/false across an explicit acquire/release, and double-release
   idempotency. All pass.
2. **Engine hook contract under-documented for future module authors.** The `notifyLensDeployment`
   JSDoc in `vtab/module.ts` documented "the engine awaits the result" but not that the hook fires
   with the exec mutex held — the precise trap this ticket hit. Added a "Fires while the exec mutex
   is held" bullet cross-referencing `Database._isExecuting`, so the next module author who
   re-enters the engine from this hook is warned at the contract.

### Test coverage assessment — adequate
The 4 e2e tests cover: headline reactive revival (row materializes, origin HLC/siteId preserved,
hold clears, one drained event, no spurious echo, second-order relay) + idempotent re-deploy;
schema drift (drift-drop of an absent column, siblings apply); MV + `Database.watch` maintenance
on revival; and `store-and-forward` forwardable-hold emptying. The load-bearing `detached`
precondition (drop-before-empty-redeploy ordering) is explicitly asserted, guarding against a
silently-vacuous test. `settle()` (25ms) reliably covers the one-event-loop-turn deferred drain
(all in-memory). Engine-level gap closed by finding #1.

### Docs — VERIFIED current
`docs/sync.md` § Revival/drain and `docs/migration.md` § 4 accurately describe the deferral and the
inbound-vs-lens-redeploy asymmetry, consistent with the implementation. `module.ts` hook doc updated
(finding #2).

### Noted, no action (acceptable residuals, not bugs)
- **Fire-and-forget lifecycle race:** if the `Database` closes between `apply schema` committing and
  the deferred drain running, the drain's `ingestExternalRowChanges` throws and is swallowed by
  `drainReappearedTables` — a logged advisory warning, held entries simply stay for the next sweep.
  No data loss. Not worth a ticket.
- **Conditional defer vs. always-defer:** the inline-await path for the no-live-statement case keeps
  the in-memory stub tests green unmodified. A reasonable design choice; the `_isExecuting` coupling
  is a documented engine signal, not a leak.
- **`execMutexDepth` is effectively 0/1** (the mutex is non-reentrant/chained), so the counter is
  defensive rather than strictly necessary — harmless, and the `released` guard relies on it being a
  counter. Left as-is.

### Validation (all green on `view-updates-lens`)
```
yarn workspace @quereus/quereus build                                          # exit 0 (REQUIRED first — dist is gitignored)
yarn workspace @quereus/sync test                                             # 429 passing
yarn workspace @quereus/sync typecheck                                        # exit 0
node_modules/.bin/tsc -p packages/quereus-sync/tsconfig.test.json --noEmit    # exit 0
yarn workspace @quereus/quereus lint                                          # exit 0 (eslint + test typecheck, incl. new spec)
yarn workspace @quereus/quereus test                                          # 6364 passing, 9 pending (+3 new = engine suite green)
```
The sync-run log noise (`recordLensDeployment … hash drifted`, oversized-transaction, failing-KV
stubs, the advisory `drainReappearedTables failed … (test)` swallow line) is pre-existing test
scaffolding, not failures. `test:store` was not run (test-code + additive engine signal; LevelDB
path not implicated — slow, deferred to CI).
