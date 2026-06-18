description: Review the new periodic sync-maintenance loop in the quoomb-web web worker that replays held sync edits (and runs the prune/evict sweeps) on a timer, since the library itself ships no timer.
prereq:
files:
  - packages/quoomb-web/src/worker/sync-maintenance.ts          # NEW: extracted, unit-tested tick runner + ticker + cadence const
  - packages/quoomb-web/src/__tests__/sync-maintenance.test.ts  # NEW: vitest (5 tests) for the runner + ticker guards
  - packages/quoomb-web/src/worker/quereus.worker.ts            # worker: timer lifecycle + drain/evict event subscriptions
  - packages/quoomb-web/src/worker/types.ts                     # SyncEventType + SyncEvent.details extended
  - packages/quereus-sync/src/sync/manager.ts                   # SyncManager sweep APIs (unchanged — reference)
  - packages/quereus-sync/src/sync/events.ts                    # HeldChangesDrainedEvent / BasisTableEvictedEvent (unchanged — reference)
  - docs/migration.md                                           # § 4 Contract — maintenance-path note added
  - docs/sync.md                                                # § Revival / drain — maintenance-path note added
difficulty: medium
----

# Review: periodic sync-maintenance loop in the quoomb-web worker

## What this delivers (and why)

`@quereus/sync` exposes four **host-driven** sweeps but ships **no timer** — the
host owns cadence:

- `drainHeldChanges(schema?, table?)` — replays held out-of-basis changes
  (quarantine + forwardable store-and-forward) into a table that has reappeared
  in the local basis, then clears them from the hold. **Headline deliverable** —
  it is what makes held edits replay within a cadence interval instead of waiting
  on horizon GC (default 30 days).
- `pruneQuarantine()` / `pruneTombstones()` — horizon-bounded GC of held
  stragglers / tombstones.
- `evictExpiredBasisTables()` — reclaims detached basis-table storage.

Before this change, **all four were dormant** in the app — a repo search found
zero production callers. The quoomb-web worker wired the oracle/callbacks so it
*could* drain/evict, but never scheduled anything. This ticket makes the worker
the periodic maintenance path that runs all four on one cadence.

Design tradeoffs were fixed by the plan and are **not** re-opened here: all four
sweeps on one loop (DRY + contract fidelity); loop owned by the sync *module* not
the *connection* (survives `disconnectSync()`, dies on `close()`); cadence a
module-level const (5 min) not a config knob; scoped lower-latency drain parked in
`backlog/sync-drain-scoped-on-reappear.md`.

## What changed

**`sync-maintenance.ts` (NEW, pure / dependency-light — no Comlink/IDB/worker):**
- `SYNC_MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000`.
- `SyncMaintenanceTarget` — minimal structural type of the four sweeps (a
  `SyncManager` is structurally assignable to it; keeps the test fake tiny).
- `runSyncMaintenancePass(target, log)` — one pass. Order **drain →
  pruneQuarantine → pruneTombstones → evict**. Each sweep is `try/catch` +
  `log`-on-throw; the pass **never rejects** and runs all four even if an earlier
  one throws.
- `createSyncMaintenanceTicker(getTarget, log)` — single-flight ticker: folds the
  re-entrancy guard (in-flight flag in the closure) **and** the null-target guard
  (`getTarget()` re-read each tick) into one testable unit.

**`quereus.worker.ts`:**
- New member `maintenanceTimer: ReturnType<typeof setInterval> | null`.
- `startSyncMaintenance()` — idempotent (no-op if timer set), arms
  `setInterval(() => void tick(), SYNC_MAINTENANCE_INTERVAL_MS)`, then fires one
  immediate `void tick()` so a prior offline session's held changes drain on
  startup. The ticker's `getTarget` is `() => this.syncManager`.
- `stopSyncMaintenance()` — idempotent clear+null.
- `startSyncMaintenance()` called at the **end of `initializeSyncModule()`**
  (after `setupSyncEventListeners()`); `stopSyncMaintenance()` called at the
  **top of `close()`** (before `syncManager` is nulled). `disconnectSync()` is
  untouched.
- `setupSyncEventListeners()` now subscribes to `onHeldChangesDrained`
  (→ `held-changes-drained` SyncEvent) and `onBasisTableEvicted`
  (→ `basis-evicted` SyncEvent), pushing mapped events to history.

**`types.ts`:** `SyncEventType` += `'held-changes-drained' | 'basis-evicted'`;
`SyncEvent.details` += `drained?`, `applied?` (`table?`/`skipped?` already there).

**Docs:** `migration.md` § 4 and `sync.md` § Revival/drain now state the
quoomb-web worker *is* the periodic maintenance path (5-min, all four sweeps), and
the relay-only coordinator deliberately has none.

## Deliberate deviation from the plan (please sanity-check)

The plan sketched a `maintenanceRunning` boolean instance member + an inline
`tickSyncMaintenance()` method on the worker. Instead the re-entrancy + null
guards live in the **`createSyncMaintenanceTicker` closure**, and the worker holds
no `maintenanceRunning` field — it just owns `maintenanceTimer` and delegates to
the ticker. The plan **explicitly sanctioned this** ("factor the guard into a tiny
helper the test can drive"); the payoff is that the guard logic is unit-tested in
isolation. Behaviour is identical to the sketch. Flagging so the reviewer isn't
surprised by the missing `maintenanceRunning` member / `tickSyncMaintenance`
method.

## Tests added

`src/__tests__/sync-maintenance.test.ts` — 5 vitest cases, all green:

- **Order** — all four sweeps run once, in `[drain, pruneQuarantine,
  pruneTombstones, evict]` order; `log` not called.
- **Error isolation** — `pruneQuarantine` rejects; the other three still run, the
  pass resolves, `log` called exactly once with `('pruneQuarantine', boom)`.
- **Re-entrancy** — `drainHeldChanges` parks on a deferred promise; a second
  `tick()` is a no-op (only `drainHeldChanges` recorded) until the first settles,
  then the guard re-arms and a fresh tick runs a full pass again.
- **Null target** — `getTarget` returns null → clean no-op, no throw, no log.
- **Target cleared mid-life** — ticker re-reads the target each tick: works while
  present, goes no-op once `getTarget` returns null (models `close()`).

## Validation run

- `yarn workspace @quereus/quoomb-web typecheck` — **PASS** (strict `tsc --noEmit`,
  exit 0).
- `yarn workspace @quereus/quoomb-web test` — **PASS** (exit 0; the 5 new tests
  green; unrelated zustand-persist stderr noise from other suites is pre-existing).
- `yarn workspace @quereus/quoomb-web lint` — **could not run**: ESLint v9 aborts
  with "couldn't find an eslint.config file" — there is **no** eslint flat config
  anywhere in the repo and `package.json` was not touched. Pre-existing tooling
  gap (AGENTS.md: "Only `packages/quereus` has a lint script"). Flagged in
  `tickets/.pre-existing-error.md`. **Reviewer: lint did not vet these files** —
  rely on typecheck + manual read for style/unused-import nits.

## Known gaps / what to scrutinize (tests are a floor)

- **Worker wiring is verified by typecheck + inspection, not by an executing
  test.** `quereus.worker.ts` calls `Comlink.expose(worker)` at module load
  (needs a worker `self`), so importing it into vitest is impractical. The
  re-entrancy/null **logic** is covered via the extracted ticker the worker
  delegates to, but the actual timer arm/disarm, the `initializeSyncModule()` /
  `close()` lifecycle ordering, and the `onHeldChangesDrained` →
  `held-changes-drained` SyncEvent mapping are **not** exercised by a running
  test. Worth a careful read:
  - `stopSyncMaintenance()` is at the **top** of `close()`, before `syncManager`
    is nulled — confirm the ordering closes the "timer fires mid-teardown" window.
  - `startSyncMaintenance()` is idempotent and `initializeSyncModule()` early-
    returns if `syncManager` already exists — confirm a reconnect cannot arm a
    second timer.
  - The drained/evicted event→`SyncEvent` mapping (message string + `details`
    fields) — confirm field names match `HeldChangesDrainedEvent` /
    `BasisTableEvictedEvent` and the new `types.ts` `details` shape.
- **Optional "drained → history" test was skipped** for the same
  worker-unimportable reason. If desired, a follow-up could extract the
  event→SyncEvent mapping into a pure helper and test it.
- **No real-store end-to-end drain coverage here** — that is
  `tickets/plan/11-sync-drain-integration-test.md` (real `Database` + `StoreModule`
  + store adapter). This ticket's tests use a fake target only.
- **Indentation note:** the new files use 2-space indent to match the existing
  quoomb-web sources (which use spaces), even though the root `.editorconfig`
  declares tabs. Consistent with neighbours; flagging in case the reviewer's
  formatter disagrees.

## Suggested reviewer checklist

- Read `quereus.worker.ts` diff: timer lifecycle ordering in
  `initializeSyncModule()` / `close()`, `disconnectSync()` left alone, the two new
  event subscriptions.
- Confirm `runSyncMaintenancePass` sweep **order** matches the contract (drain
  before prune so a reappeared table's held change is replayed, not GC'd).
- Confirm the event→`SyncEvent` mappings and the `types.ts` additions line up.
- Spot-check the two doc edits for accuracy.
- Decide whether the missing worker-level execution test (vs. the extracted-helper
  tests) is acceptable for merge or warrants a fix-ticket to make the mapping
  testable.
