description: The quoomb-web web worker now runs a periodic background loop that replays held sync edits and cleans up stale sync data on a timer, since the sync library itself ships no timer.
prereq:
files:
  - packages/quoomb-web/src/worker/sync-maintenance.ts          # tick runner + ticker + cadence const
  - packages/quoomb-web/src/__tests__/sync-maintenance.test.ts  # vitest (6 tests) for the runner + ticker guards
  - packages/quoomb-web/src/worker/quereus.worker.ts            # worker: timer lifecycle + drain/evict event subscriptions
  - packages/quoomb-web/src/worker/types.ts                     # SyncEventType + SyncEvent.details extended
  - docs/migration.md                                           # § 4 Contract — maintenance-path note
  - docs/sync.md                                                # § Revival / drain — maintenance-path note
difficulty: medium
----

# Complete: periodic sync-maintenance loop in the quoomb-web worker

The quoomb-web worker is now the concrete periodic host for the four host-driven
`@quereus/sync` sweeps (`drainHeldChanges` / `pruneQuarantine` / `pruneTombstones`
/ `evictExpiredBasisTables`). The library ships no timer; the worker owns a single
5-minute loop (`SYNC_MAINTENANCE_INTERVAL_MS`) plus one immediate pass on sync-module
init so a prior offline session's held changes drain on startup. The loop is owned by
the sync *module* (armed at the end of `initializeSyncModule()`, torn down at the top
of `close()`, deliberately surviving `disconnectSync()`).

The re-entrancy + null-target guards were factored into a pure, unit-tested
`createSyncMaintenanceTicker` closure (sanctioned by the plan) rather than a worker
instance boolean. Each pass is single-flight and per-sweep error-isolated (one throwing
sweep is logged and the other three still run). Two new UI events
(`held-changes-drained`, `basis-evicted`) are mapped from the corresponding sync events
into `SyncEvent` history.

## Review findings

**Scope checked:** the full implement diff (`e76754ca`) read first with fresh eyes —
`sync-maintenance.ts`, the worker timer/event wiring, `types.ts`, both doc notes, and
the test — then cross-checked against the actual `@quereus/sync` surface
(`manager.ts`, `events.ts`) and the worker's surrounding lifecycle
(`setStorageModule` / `initializeSyncModule` / `disconnectSync` / `close`).

**Correctness / type safety — no issues.**
- `SyncMaintenanceTarget`'s no-arg sweep signatures are structurally satisfied by
  `SyncManager`'s optional-arg versions (`drainHeldChanges(schema?, table?)`,
  `evictExpiredBasisTables(now?)`); typecheck confirms assignability.
- Event→`SyncEvent` mappings line up field-for-field with the canonical interfaces:
  `HeldChangesDrainedEvent` = `{schema, table, drained, applied, skipped}` and
  `BasisTableEvictedEvent` = `{schema, table, at, quietForMs}`; the worker reads only
  fields that exist, and the `types.ts` `details` additions (`drained`, `applied`)
  match. A field typo would fail typecheck.
- Sweep order (drain → pruneQuarantine → pruneTombstones → evict) matches the
  contract: drain replays a reappeared table's held change before quarantine GC could
  remove it.
- Both the `dropLocalTable` reclaim callback (evict) and the `getTableSchema` oracle
  (drain) are wired in `initializeSyncModule()`, so all four sweeps are *live* in
  quoomb-web (not the relay-only no-op path).

**Lifecycle — verified by inspection.**
- `stopSyncMaintenance()` runs at the top of `close()`, before `syncManager` is nulled —
  no "timer fires mid-teardown after manager gone" window; and even if a tick raced in,
  the ticker's null-target guard makes it a clean no-op.
- `startSyncMaintenance()` is idempotent and `initializeSyncModule()` early-returns when
  `syncManager` already exists, so a reconnect/re-init cannot stack a second timer.

**Resource cleanup — one benign observation, no fix.** `setStorageModule()` switching
*away* from `'sync'` calls `disconnectSync()` but neither stops the loop nor nulls
`syncManager` (which is nulled only in `close()`). The loop therefore keeps ticking
against a still-valid manager until `close()`. This is consistent with the deliberate
"loop owned by the module, not the connection" design and is harmless — the sweeps are
zero-cost when nothing is held/expired and operate on still-present IndexedDB data; there
is no use-after-free (db/manager are torn down together in `close()`). Not worth a ticket.

**Tests — solid; one error-path gap closed inline (minor).** The 5 implementer tests
cover sweep order, single-failure isolation, re-entrancy, null target, and
target-cleared-mid-life. Added a 6th: **two independent sweep failures** both still run
and the logger fires once per failure with the correct `(step, error)` pair (guards
against accidental dedup/short-circuit). All 65 quoomb-web tests green.

**Accepted gaps (no ticket, with reasons):**
- *Worker-level execution test* (timer arm/disarm, init/close ordering, event mapping)
  is absent because `quereus.worker.ts` calls `Comlink.expose` at module load and is
  impractical to import under vitest. Accepted: the meaningful logic (the ticker) is
  unit-tested via the helper the worker delegates to; the mapping is a trivial typed
  object copy guarded by typecheck; real end-to-end drain coverage is the separate,
  already-planned `tickets/plan/11-sync-drain-integration-test.md`.
- *Indentation* — new files use 2-space to match every existing quoomb-web source (the
  whole package uses spaces despite the root `.editorconfig` tab default). Matching the
  package convention is correct.

**Validation:**
- `yarn workspace @quereus/quoomb-web typecheck` — **PASS** (exit 0).
- `yarn workspace @quereus/quoomb-web test` — **PASS** (65 tests, the 6 sync-maintenance
  cases green; the zustand-persist stderr noise from `settingsStore.test.ts` is
  pre-existing and unrelated).
- `yarn workspace @quereus/quoomb-web lint` — **could not run**: ESLint v9 aborts with
  "couldn't find an eslint.config file" (no flat config anywhere in the repo). This is a
  pre-existing repo-wide tooling gap affecting all quoomb-web files, untouched by this
  ticket, and was **already triaged** by the runner into
  `tickets/backlog/quoomb-web-lint-no-eslint-config.md`. Style/unused-import nits were
  vetted by manual read instead.

**Disposition:** no major findings; no new fix/plan tickets filed. One minor inline
improvement (the extra error-path test). Ready to complete.
