import debug from 'debug';

// Base namespace for the project
const BASE_NAMESPACE = 'quereus';

/**
 * Creates a namespaced debug logger instance.
 *
 * Example: createLogger('compiler') -> returns a debugger for 'quereus:compiler'
 * Example: createLogger('vtab:memory') -> returns a debugger for 'quereus:vtab:memory'
 *
 * Usage:
 * const log = createLogger('compiler');
 * log('Compiling statement: %s', sql);
 * const errorLog = log.extend('error'); // Creates 'quereus:compiler:error'
 * errorLog('Compilation failed: %O', error);
 *
 * @param subNamespace The specific subsystem namespace (e.g., 'parser', 'vdbe:runtime', 'vtab:memory')
 * @returns A debug instance.
 */
export function createLogger(subNamespace: string): debug.Debugger {
	return debug(`${BASE_NAMESPACE}:${subNamespace}`);
}

/**
 * Enable Quereus debug logging programmatically.
 *
 * This is particularly useful in environments like React Native where
 * environment variables are not available at runtime.
 *
 * @param pattern - Debug pattern to enable (default: 'quereus:*')
 *   Examples:
 *   - 'quereus:*' - all Quereus logs
 *   - 'quereus:vtab:*' - virtual table operations
 *   - 'quereus:vtab:memory' - memory table operations only
 *   - 'quereus:planner' - query planner logs
 *   - 'quereus:runtime' - VDBE execution (very verbose)
 *   - 'quereus:*,-quereus:runtime' - all except verbose runtime
 * @param logFn - Optional custom log function. Defaults to console.log.
 *   Useful in environments where console.debug may be filtered.
 *
 * @example
 * ```typescript
 * import { enableLogging } from '@quereus/quereus';
 *
 * // Enable all Quereus logs
 * enableLogging();
 *
 * // Enable only memory table logs
 * enableLogging('quereus:vtab:memory');
 *
 * // Enable all logs with custom output (e.g., React Native)
 * enableLogging('quereus:*', console.log.bind(console));
 * ```
 */
export function enableLogging(
	pattern: string = `${BASE_NAMESPACE}:*`,
	logFn?: (...args: unknown[]) => void
): void {
	if (logFn) {
		debug.log = logFn;
	}
	debug.enable(pattern);
}

/**
 * Disable all Quereus debug logging.
 *
 * @example
 * ```typescript
 * import { disableLogging } from '@quereus/quereus';
 *
 * disableLogging();
 * ```
 */
export function disableLogging(): void {
	debug.disable();
}

/**
 * Check if logging is enabled for a specific namespace.
 *
 * @param namespace - The namespace to check (without 'quereus:' prefix)
 * @returns true if logging is enabled for this namespace
 *
 * @example
 * ```typescript
 * import { isLoggingEnabled } from '@quereus/quereus';
 *
 * if (isLoggingEnabled('vtab:memory')) {
 *   // Perform expensive debug operations
 * }
 * ```
 */
export function isLoggingEnabled(namespace: string): boolean {
	return debug.enabled(`${BASE_NAMESPACE}:${namespace}`);
}
