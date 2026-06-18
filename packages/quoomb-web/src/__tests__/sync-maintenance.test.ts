import { describe, it, expect, vi } from 'vitest';

import {
  runSyncMaintenancePass,
  createSyncMaintenanceTicker,
  type SyncMaintenanceTarget,
} from '../worker/sync-maintenance.js';

/** A manually-settled promise, for modeling a long-running sweep. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type SweepName = keyof SyncMaintenanceTarget;

const ALL_SWEEPS: SweepName[] = [
  'drainHeldChanges',
  'pruneQuarantine',
  'pruneTombstones',
  'evictExpiredBasisTables',
];

/**
 * Fake maintenance target that records the order sweeps were invoked in. Each
 * sweep resolves 0 by default; an override lets a single sweep reject or hang.
 * The call is recorded *before* the override runs, so `calls` reflects
 * invocation order even for a sweep that never resolves.
 */
function makeFakeTarget(
  overrides: Partial<Record<SweepName, () => Promise<number>>> = {},
): { target: SyncMaintenanceTarget; calls: SweepName[] } {
  const calls: SweepName[] = [];
  const sweep = (name: SweepName) => () => {
    calls.push(name);
    return overrides[name]?.() ?? Promise.resolve(0);
  };
  return {
    calls,
    target: {
      drainHeldChanges: sweep('drainHeldChanges'),
      pruneQuarantine: sweep('pruneQuarantine'),
      pruneTombstones: sweep('pruneTombstones'),
      evictExpiredBasisTables: sweep('evictExpiredBasisTables'),
    },
  };
}

describe('runSyncMaintenancePass', () => {
  it('runs all four sweeps once, in order (drain → pruneQuarantine → pruneTombstones → evict)', async () => {
    const { target, calls } = makeFakeTarget();
    const log = vi.fn();

    await runSyncMaintenancePass(target, log);

    expect(calls).toEqual(ALL_SWEEPS);
    expect(log).not.toHaveBeenCalled();
  });

  it('isolates a failing sweep: the other three still run, the pass resolves, the failure is logged once', async () => {
    const boom = new Error('quarantine boom');
    const { target, calls } = makeFakeTarget({
      pruneQuarantine: () => Promise.reject(boom),
    });
    const log = vi.fn();

    await expect(runSyncMaintenancePass(target, log)).resolves.toBeUndefined();

    // All four were still invoked despite the second one rejecting.
    expect(calls).toEqual(ALL_SWEEPS);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('pruneQuarantine', boom);
  });

  it('isolates each failing sweep independently: two failures both run and both log', async () => {
    const boom1 = new Error('drain boom');
    const boom2 = new Error('evict boom');
    const { target, calls } = makeFakeTarget({
      drainHeldChanges: () => Promise.reject(boom1),
      evictExpiredBasisTables: () => Promise.reject(boom2),
    });
    const log = vi.fn();

    await expect(runSyncMaintenancePass(target, log)).resolves.toBeUndefined();

    // Both failing sweeps and the two healthy ones in between all ran.
    expect(calls).toEqual(ALL_SWEEPS);
    // One log per failure, with the right (step, error) pair — no dedup / short-circuit.
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith('drainHeldChanges', boom1);
    expect(log).toHaveBeenCalledWith('evictExpiredBasisTables', boom2);
  });
});

describe('createSyncMaintenanceTicker', () => {
  it('guards re-entrancy: a second tick is a no-op until the first settles', async () => {
    const gate = deferred<number>();
    const { target, calls } = makeFakeTarget({
      drainHeldChanges: () => gate.promise, // first pass parks here
    });
    const log = vi.fn();
    const tick = createSyncMaintenanceTicker(() => target, log);

    const first = tick();  // starts a pass, hangs on drainHeldChanges
    const second = tick(); // re-entrant — must short-circuit immediately
    await second;

    // While the first pass is parked, only its first sweep has run; the second
    // tick added nothing.
    expect(calls).toEqual(['drainHeldChanges']);

    gate.resolve(0); // release the first pass
    await first;

    // The first pass completed all four sweeps exactly once.
    expect(calls).toEqual(ALL_SWEEPS);

    // Once settled, the guard re-arms: a fresh tick runs a full pass again.
    await tick();
    expect(calls).toEqual([...ALL_SWEEPS, ...ALL_SWEEPS]);
    expect(log).not.toHaveBeenCalled();
  });

  it('is a clean no-op when the target is null (no sync module / after close)', async () => {
    const log = vi.fn();
    const tick = createSyncMaintenanceTicker(() => null, log);

    await expect(tick()).resolves.toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });

  it('re-reads the target each tick: goes no-op once the target is cleared', async () => {
    let current: SyncMaintenanceTarget | null = null;
    const { target, calls } = makeFakeTarget();
    current = target;
    const log = vi.fn();
    const tick = createSyncMaintenanceTicker(() => current, log);

    await tick();
    expect(calls).toEqual(ALL_SWEEPS);

    // Simulate close() nulling the manager: a later timer firing must no-op.
    current = null;
    await tick();
    expect(calls).toEqual(ALL_SWEEPS); // unchanged — no new sweeps ran
  });
});
