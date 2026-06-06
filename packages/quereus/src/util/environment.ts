/**
 * Cross-platform environment variable utilities
 * Works in Node.js, browsers, and React Native
 */

/**
 * Cross-platform environment variable accessor
 * Works in Node.js, browsers, and React Native
 *
 * @param key The environment variable name
 * @returns The environment variable value or undefined if not found
 */
export function getEnvVar(key: string): string | undefined {
	// Node.js environment
	if (typeof process !== 'undefined' && process.env) {
		return process.env[key];
	}

	// Browser environment - check if globalThis has the variable
	// This allows setting environment variables like: globalThis.DEBUG = "quereus:*"
	if (typeof globalThis !== 'undefined' && (globalThis as Record<string, unknown>)[key]) {
		return (globalThis as Record<string, unknown>)[key] as string;
	}

	// React Native or other environments might set environment variables differently
	// For now, return undefined for unsupported environments
	return undefined;
}

/**
 * Check if a feature flag is enabled
 *
 * @param flagName The feature flag name
 * @returns true if the flag is set to 'true'
 */
export function isFeatureEnabled(flagName: string): boolean {
	return getEnvVar(flagName) === 'true';
}
