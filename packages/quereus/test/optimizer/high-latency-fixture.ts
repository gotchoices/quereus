/**
 * Synthetic slow-storage table types for the optimizer specs. No in-tree module
 * reports a non-zero first-row latency, so the latency-gated rules (the parallel
 * gather / zip-by-key / prefetch-probe rewrites, the batched-outer flip, fan-out
 * recognition, and the join latency charges) would stay inert without them.
 *
 * Not registered with the `test/plan/` golden sweep — goldens run on plain
 * `MemoryTableModule`.
 */
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import { DEFAULT_TUNING } from '../../src/planner/optimizer-tuning.js';

/**
 * First-row latency of the fixtures. `batchedOuterThresholdMs`,
 * `gatherThresholdMs` and `prefetchProbeThresholdMs` share one default, so
 * sitting exactly at it clears all three `>=` gates.
 */
export const HIGH_LATENCY_MS = DEFAULT_TUNING.parallel.gatherThresholdMs;

/** Memory-backed table type that declares a slow first row. */
export class HighLatencyMemoryModule extends MemoryTableModule {
	readonly expectedLatencyMs = HIGH_LATENCY_MS;
}

/** The same first-row delay plus a per-row rate: storage that answers one row per request. */
export class PerRowLatencyMemoryModule extends MemoryTableModule {
	readonly expectedLatencyMs = HIGH_LATENCY_MS;
	readonly expectedRowLatencyMs = 1;
}
