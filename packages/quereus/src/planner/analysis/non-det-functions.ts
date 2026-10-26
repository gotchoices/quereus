/**
 * The one mapping from a non-deterministic function's name to the kind of
 * non-determinism it introduces. Shared by the change-scope analyzer and the
 * written-value provenance classifier so the two never disagree on which
 * builtin is a clock.
 */
import type { NonDetSource } from './change-scope.js';

const KNOWN_TIME_FUNCS = new Set([
	'now', 'current_timestamp', 'current_time', 'current_date',
	'date', 'time', 'datetime', 'julianday',
	'epoch_s', 'epoch_ms', 'epoch_s_frac',
	'strftime',
]);
const KNOWN_RANDOM_FUNCS = new Set(['random', 'randomblob']);

/** Classify a function already known to be non-deterministic, by name (case-insensitive). */
export function classifyNonDetFunction(name: string): NonDetSource {
	const lowered = name.toLowerCase();
	if (KNOWN_TIME_FUNCS.has(lowered)) return { kind: 'time' };
	if (KNOWN_RANDOM_FUNCS.has(lowered)) return { kind: 'random' };
	return { kind: 'volatileUdf', name: lowered };
}
