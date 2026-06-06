/**
 * Cross-platform high-resolution timer returning nanoseconds as bigint.
 *
 * Detection runs once at import time; subsequent calls use the cached fast-path.
 *
 * Precision varies by platform:
 * - Node: nanosecond (process.hrtime.bigint)
 * - Browser / modern runtimes: microsecond (performance.now)
 * - Fallback: millisecond (Date.now)
 */

type HrtimeFn = () => bigint;

function selectTimer(): HrtimeFn {
	// Node.js — nanosecond precision
	if (typeof process !== 'undefined' && typeof process.hrtime?.bigint === 'function') {
		return () => process.hrtime.bigint();
	}

	// Browser / modern runtimes — microsecond precision via performance.now()
	if (typeof globalThis.performance?.now === 'function') {
		const perf = globalThis.performance;
		return () => BigInt(Math.round(perf.now() * 1e6));
	}

	// Last resort — millisecond precision
	return () => BigInt(Date.now()) * 1_000_000n;
}

/** Returns the current high-resolution time in nanoseconds as a bigint. */
export const hrtimeNs: HrtimeFn = selectTimer();
