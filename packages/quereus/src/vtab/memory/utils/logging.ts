import { createLogger } from '../../../common/logger.js';
import { safeJsonStringify } from '../../../util/serialization.js';

/**
 * Factory for creating standardized memory table loggers with consistent namespacing
 */
export function createMemoryTableLoggers(subModule: string) {
	const log = createLogger(`vtab:memory:${subModule}`);

	const warnLog = log.extend('warn');
	const errorLog = log.extend('error');
	const debugLog = log.extend('debug');

	return {
		info: log,
		warnLog,
		errorLog,
		debugLog,

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		operation: (operation: string, tableName: string, details?: any) => {
			log(`[${tableName}] ${operation}${details ? `: ${safeJsonStringify(details)}` : ''}`);
		},

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		warn: (operation: string, tableName: string, message: string, details?: any) => {
			warnLog(`[${tableName}] ${operation}: ${message}${details ? ` - ${safeJsonStringify(details)}` : ''}`);
		},

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		error: (operation: string, tableName: string, innerError: unknown, details?: any) => {
			const errorMessage = innerError instanceof Error ? innerError.message : innerError;
			errorLog(`[${tableName}] ${operation} failed: ${errorMessage}${details ? ` - ${safeJsonStringify(details)}` : ''}`);
		},
	};
}
