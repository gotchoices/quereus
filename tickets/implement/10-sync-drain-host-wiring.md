description: Make the app actually replay held sync edits when a deleted table comes back, by running a periodic sync-maintenance loop in the web worker that sweeps the held edits (today nothing runs, so the edits sit until they expire).
prereq:
files:
  - packages/quoomb-web/src/worker/quereus.worker.ts          # QuereusWorker: owns syncManager; add the loop + telemetry here
  - packages/quoomb-web/src/worker/types.ts                   # SyncEventType union + SyncEvent.details — extend for drain telemetry
  - packages/quoomb-web/src/worker/sync-maintenance.ts        # NEW: extracted, unit-testable tick runner
  - packages/quoomb-web/src/__tests__/sync-maintenance.test.ts # NEW: vitest for the tick runner
  - packages/quereus-sync/src/sync/manager.ts                 # SyncManager: drainHeldChanges / pruneTombstones / pruneQuarantine / evictExpiredBasisTables (the APIs to call)
  - packages/quereus-sync/src/sync/events.ts                  # HeldChangesDrainedEvent / onHeldChangesDrained (the event to surface)
difficulty: medium
----

# Run a periodic sync-maintenance loop in the quoomb-web worker (incl. `drainHeldChanges`)

## Context

`sync-held-change-drain-on-reappear` delivered the host-driven primitive
`SyncManager.drainHeldChanges(schema?, table?)` — it replays held out-of-basis changes
(`quarantine` + forwardable `store-and-forward`) into a table that has reappeared in the
local basis, then clears them from the hold (`docs/migration.md` § 4 Contract → Revival /
drain; `docs/sync.md` § Unknown-Table Disposition). By deliberate design the library adds
**no timer** and never drains inline — the host owns cadence.

**Investigation finding that resizes this ticket.** The original plan assumed a host
maintenance loop already exists ("the hosts that already call `pruneTombstones` /
`pruneQuarantine` / `evictExpiredBasisTables`"). It does **not**. A repo-wide search for
call sites (`\.(pruneTombstones|pruneQuarantine|evictExpiredBasisTables|drainHeldChanges)\(`
outside docs/tickets/specs) found **zero** production callers. All four host-driven sweeps
are dormant:

- `packages/quoomb-web/src/worker/quereus.worker.ts` wires the `getTableSchema` oracle,
  `applyToStore`, and `dropLocalTable` callbacks (so it *can* drain/evict) — but never
  schedules a sweep of any kind.
- `packages/sync-coordinator/src/service/store-manager.ts:343` builds its manager with
  `createSyncModule(store, this.config.syncConfig)` — **no `getTableSchema` oracle, no
  store callbacks**. It is relay-only; drain/evict are documented no-ops there. Leave it
  untouched.

So the real work is: **create the periodic sync-maintenance loop in the quoomb-web worker.**
Since the prune/evict siblings are equally dormant and the design (`docs/migration.md` § 4,
`docs/sync.md`) explicitly describes all four as sharing *one* maintenance path, the loop
runs **all four** sweeps on one cadence — wiring only `drainHeldChanges` while leaving
tombstone/quarantine GC dormant would let those stores grow unbounded and would not match
the documented contract. `drainHeldChanges` remains the headline deliverable (it is what
unblocks the end-user value: held edits replay within one cadence interval instead of
waiting on horizon GC).

### Tradeoffs already decided (do not re-litigate)

- **All four sweeps, one loop** (vs. drain-only): chosen for DRY + contract fidelity; the
  prune/evict siblings have no other caller and the docs co-locate them. Drain is the
  reason the ticket exists; the siblings ride the same tick.
- **Loop lives with the sync *module*, not the *connection***: a table can reappear locally
  (app re-creates it, or an `apply schema` lens redeploy re-maps a basis table) and held
  changes should drain even while offline; tombstone/quarantine GC is purely local. So the
  loop starts in `initializeSyncModule()` and stops in `close()`. `disconnectSync()` tears
  down only the `SyncClient` and must **not** stop the loop.
- **Cadence = a module-level constant, default 5 min** (`SYNC_MAINTENANCE_INTERVAL_MS`).
  Prune/evict act only at horizon granularity (default 30 days) so are latency-insensitive;
  drain is the latency-sensitive one and the sweep is its safety net, so minutes is ample
  and the sweeps are zero-cost when nothing is held/expired. Not exposing a config knob yet
  (keep it a documented const); revisit if a host needs it.
- **Lower-latency scoped drain** (calling `drainHeldChanges(schema, table)` the instant a
  table reappears, rather than on the next tick) is parked in
  `backlog/sync-drain-scoped-on-reappear.md` — it requires hooking the inbound
  `create_table` / lens-redeploy paths and is a separate, more invasive change. The
  periodic sweep here is the correctness floor it would optimize, not replace.

## Design

Extract the tick body into a small, dependency-light module so the re-entrancy and
error-isolation logic is unit-testable without Comlink / IndexedDB / a real worker. The
worker owns the timer and lifecycle; it delegates each tick to the extracted runner.

```
packages/quoomb-web/src/worker/sync-maintenance.ts  (NEW)

  // Minimal structural type — just the four host-driven sweeps the loop calls.
  // (Avoids importing the full SyncManager surface and keeps the test fake tiny.)
  export interface SyncMaintenanceTarget {
    drainHeldChanges(): Promise<number>;
    pruneQuarantine(): Promise<number>;
    pruneTombstones(): Promise<number>;
    evictExpiredBasisTables(): Promise<number>;
  }

  // One maintenance pass. Runs every sweep even if an earlier one throws (each is
  // wrapped + logged); never rejects. Order: drain first (replays held changes into
  // reappeared tables) THEN pruneQuarantine (GCs the truly-expired remainder) then
  // pruneTombstones then evictExpiredBasisTables.
  export async function runSyncMaintenancePass(
    target: SyncMaintenanceTarget,
    log: (step: string, error: unknown) => void,
  ): Promise<void>
```

Worker wiring (`quereus.worker.ts`):

- New members: `private maintenanceTimer: ReturnType<typeof setInterval> | null = null;`
  and `private maintenanceRunning = false;`
- `private startSyncMaintenance()` — no-op if `maintenanceTimer` already set; arm
  `setInterval(() => void this.tickSyncMaintenance(), SYNC_MAINTENANCE_INTERVAL_MS)`; then
  kick one immediate pass `void this.tickSyncMaintenance()` so held changes from a prior
  offline session drain on startup.
- `private async tickSyncMaintenance()` — re-entrancy guard: bail if
  `this.maintenanceRunning` or `!this.syncManager`; set the flag; in `finally` clear it;
  call `runSyncMaintenancePass(this.syncManager, (step, err) => console.warn(...))`. The
  guard prevents a slow pass from overlapping the next interval.
- `private stopSyncMaintenance()` — `clearInterval` + null the timer.
- Call `startSyncMaintenance()` at the end of `initializeSyncModule()` (after
  `setupSyncEventListeners()`); call `stopSyncMaintenance()` in `close()` (before nulling
  `syncManager`). Do **not** touch the timer in `disconnectSync()`.

Telemetry (`setupSyncEventListeners()` in `quereus.worker.ts`):

- Subscribe to `this.syncEvents.onHeldChangesDrained((e: HeldChangesDrainedEvent) => …)`
  and push a `SyncEvent` to history via `addSyncEvent({ type: 'held-changes-drained',
  timestamp: Date.now(), message: \`Drained \${e.drained} held change(s) into \${e.table}
  (applied \${e.applied}, skipped \${e.skipped})\`, details: { table: e.table, drained:
  e.drained, applied: e.applied, skipped: e.skipped } })`. Import the event type from
  `@quereus/sync`.
- Also surface `onBasisTableEvicted` the same way (type `'basis-evicted'`) — the loop now
  triggers evictions, so the event becomes reachable and the UI history should reflect it.

Types (`packages/quoomb-web/src/worker/types.ts`):

- Extend `SyncEventType` with `'held-changes-drained' | 'basis-evicted'`.
- Add `drained?: number; applied?: number;` to `SyncEvent.details` (`skipped?` and `table?`
  already exist).

## Edge cases & interactions

- **No sync module yet / after `close()`** — `tickSyncMaintenance` must early-return when
  `this.syncManager` is null (timer may fire once between `close()` clearing the manager and
  `clearInterval` if ordering slips). `stopSyncMaintenance()` before nulling `syncManager`
  in `close()` closes the window.
- **Re-entrancy** — a pass slower than the interval must not overlap itself; the
  `maintenanceRunning` guard makes a second concurrent tick a clean no-op (assert in test).
- **One sweep throws** — must be caught, logged (`console.warn`, never swallowed silently
  per AGENTS.md), and must **not** abort the remaining sweeps nor kill the timer. Assert all
  four still run when an earlier one rejects.
- **Idempotent / empty passes** — `drainHeldChanges()` returns 0 and fires no event when
  nothing is held; prune/evict return 0 when nothing is expired. A no-op pass must be silent
  (no spurious history entries) and cheap.
- **Relay-only path stays a no-op** — the coordinator never gets this loop; even if it did,
  `drainHeldChanges`/`evictExpiredBasisTables` return 0 without the oracle/callback. Do not
  wire anything into `sync-coordinator`.
- **`disconnectSync()` vs `close()`** — loop survives a disconnect (module still alive),
  stops on `close()`. A reconnect must not arm a second timer (the `startSyncMaintenance`
  guard handles the re-init-without-close case; `initializeSyncModule` already early-returns
  if `syncManager` exists).
- **Initial startup pass** — the kick-off `void this.tickSyncMaintenance()` must not block
  or throw out of `initializeSyncModule()` (fire-and-forget with `void`; errors are handled
  inside the tick).
- **Drained event ordering** — `drainHeldChanges` fires `onRemoteChange` for applied changes
  (driving MV maintenance / `Database.watch` / UI) **and** `onHeldChangesDrained` per table;
  both already flow through the existing listener set — just add the drained/evicted
  subscriptions. `applied + skipped === drained` per the event contract.

## Testing

Mirror the existing vitest setup (`packages/quoomb-web/src/__tests__/*.test.ts`). Add
`packages/quoomb-web/src/__tests__/sync-maintenance.test.ts` exercising
`runSyncMaintenancePass` + the worker's tick guard against a fake target:

- **All four sweeps run, in order** — fake records call order; assert
  `['drainHeldChanges','pruneQuarantine','pruneTombstones','evictExpiredBasisTables']`.
- **Error isolation** — fake's `pruneQuarantine` rejects; assert the other three still ran
  and `log` was called once for the failing step; the pass resolves (never rejects).
- **Re-entrancy guard** — model a long-running pass (a sweep that awaits a deferred promise);
  fire the tick twice; assert the second is a no-op until the first settles. (Test the guard
  at the worker level, or factor the guard into a tiny helper the test can drive.)
- **Null target** — tick with no manager is a clean no-op (no calls, no throw).
- (Optional) **drained → history** — a fake `onHeldChangesDrained` emission produces one
  `SyncEvent` of type `'held-changes-drained'` with matching `details`.

Full real-store end-to-end drain coverage is **out of scope here** — it is
`tickets/plan/11-sync-drain-integration-test.md`'s job (real `Database` + `StoreModule`).

## Validation

- `yarn workspace @quereus/quoomb-web typecheck`
- `yarn workspace @quereus/quoomb-web lint`
- `yarn workspace @quereus/quoomb-web test`

Stream long output per AGENTS.md (`… 2>&1 | tee /tmp/qw.log; tail -n 80 /tmp/qw.log`).

## Docs

Update `docs/migration.md` § 4 Contract and/or `docs/sync.md` § Unknown-Table Disposition
where they say the sweeps are "called from the same periodic maintenance path": note that
the quoomb-web worker now *is* that path (periodic loop, 5-min default cadence, all four
sweeps), and that the relay-only coordinator deliberately has no such loop.

## TODO

- Add `sync-maintenance.ts` with `SyncMaintenanceTarget` + `runSyncMaintenancePass` (drain →
  pruneQuarantine → pruneTombstones → evict; per-step try/catch + log; never rejects).
- Add worker timer state + `startSyncMaintenance` / `tickSyncMaintenance` (re-entrancy +
  null guard) / `stopSyncMaintenance`; define `SYNC_MAINTENANCE_INTERVAL_MS` (5 min).
- Start the loop at the end of `initializeSyncModule()` (with an immediate kick-off pass);
  stop it in `close()` before nulling `syncManager`; leave `disconnectSync()` alone.
- Subscribe to `onHeldChangesDrained` (and `onBasisTableEvicted`) in
  `setupSyncEventListeners()`; push mapped `SyncEvent`s to history.
- Extend `SyncEventType` (`'held-changes-drained' | 'basis-evicted'`) and
  `SyncEvent.details` (`drained?`, `applied?`).
- Add the vitest covering order, error isolation, re-entrancy, null target, (optional)
  drained→history.
- Update `docs/migration.md` / `docs/sync.md` maintenance-path wording.
- Run typecheck + lint + test for `@quereus/quoomb-web`.
