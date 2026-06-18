/**
 * Periodic sync-maintenance tick runner for the quoomb-web worker.
 *
 * The `@quereus/sync` library is deliberately timer-free: it exposes the four
 * host-driven sweeps (`drainHeldChanges` / `pruneQuarantine` / `pruneTombstones`
 * / `evictExpiredBasisTables`) but never schedules them — the host owns cadence
 * (`docs/migration.md` § 4 Contract, `docs/sync.md` § Unknown-Table Disposition).
 * This module is that cadence's tick body, extracted from the worker so the
 * re-entrancy and error-isolation logic is unit-testable without Comlink /
 * IndexedDB / a real worker.
 */

/**
 * Default cadence for the worker's sync-maintenance loop (5 minutes).
 *
 * The latency-sensitive sweep is `drainHeldChanges` (held edits replay within
 * one interval once a table reappears); prune/evict act only at horizon
 * granularity (default 30 days) so are latency-insensitive. Every sweep is
 * zero-cost when nothing is held/expired, so minutes is ample. Kept a documented
 * constant rather than a config knob until a host needs to tune it.
 */
export const SYNC_MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Minimal structural view of the four host-driven sweeps the loop calls. Avoids
 * importing the full `SyncManager` surface and keeps the test fake tiny — a
 * `SyncManager` is structurally assignable to this.
 */
export interface SyncMaintenanceTarget {
  drainHeldChanges(): Promise<number>;
  pruneQuarantine(): Promise<number>;
  pruneTombstones(): Promise<number>;
  evictExpiredBasisTables(): Promise<number>;
}

/**
 * Reports a failed sweep. Called once per failing step; the remaining sweeps
 * still run. `error` is the thrown value verbatim.
 */
export type MaintenanceLogger = (step: string, error: unknown) => void;

/** Run one sweep, isolating its failure: a throw is logged, never re-thrown. */
async function runStep(
  step: string,
  run: () => Promise<number>,
  log: MaintenanceLogger,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    log(step, error);
  }
}

/**
 * One maintenance pass. Runs every sweep even if an earlier one throws (each is
 * wrapped + logged); never rejects.
 *
 * Order: `drainHeldChanges` first — it replays held out-of-basis changes into
 * tables that have reappeared in the local basis — THEN `pruneQuarantine` GCs
 * the truly-expired remainder, then `pruneTombstones`, then
 * `evictExpiredBasisTables`. Draining before pruning means a held change for a
 * table that has come back is replayed rather than GC'd out from under it.
 */
export async function runSyncMaintenancePass(
  target: SyncMaintenanceTarget,
  log: MaintenanceLogger,
): Promise<void> {
  await runStep('drainHeldChanges', () => target.drainHeldChanges(), log);
  await runStep('pruneQuarantine', () => target.pruneQuarantine(), log);
  await runStep('pruneTombstones', () => target.pruneTombstones(), log);
  await runStep('evictExpiredBasisTables', () => target.evictExpiredBasisTables(), log);
}

/**
 * Build a single-flight maintenance ticker with the re-entrancy and null-target
 * guards folded in, so the worker holds no separate boolean and the guard logic
 * is drivable from a test.
 *
 * - `getTarget` returns the live maintenance target, or null when there is no
 *   sync module yet / after `close()`. A null target is a clean no-op (the timer
 *   can fire once between `close()` nulling the manager and `clearInterval`).
 * - While a pass is in flight, a concurrent tick is a clean no-op until the
 *   first settles — a pass slower than the interval must not overlap itself. The
 *   in-flight flag lives in the returned closure.
 */
export function createSyncMaintenanceTicker(
  getTarget: () => SyncMaintenanceTarget | null,
  log: MaintenanceLogger,
): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) return;
    const target = getTarget();
    if (!target) return;
    running = true;
    try {
      await runSyncMaintenancePass(target, log);
    } finally {
      running = false;
    }
  };
}
