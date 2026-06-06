/**
 * Debug namespace utilities for the Titan optimizer
 * Provides standardized logger creation and debug conventions
 */

import { createLogger } from '../../common/logger.js';

/**
 * Create a logger for optimizer rules
 * @param ruleName The name of the optimization rule
 * @returns A debug logger with the standard optimizer:rule namespace
 */
export function ruleLog(ruleName: string) {
	return createLogger(`optimizer:rule:${ruleName}`);
}

/**
 * Create a logger for optimizer validation
 * @param component The validation component (e.g., 'plan', 'attributes', 'ordering')
 * @returns A debug logger with the standard optimizer:validate namespace
 */
export function validateLog(component: string = '') {
	const namespace = component ? `optimizer:validate:${component}` : 'optimizer:validate';
	return createLogger(namespace);
}

/**
 * Create a logger for runtime statistics
 * @param component The stats component (e.g., 'metrics', 'summary', 'cache')
 * @returns A debug logger with the standard runtime:stats namespace
 */
export function statsLog(component: string = '') {
	const namespace = component ? `runtime:stats:${component}` : 'runtime:stats';
	return createLogger(namespace);
}

/**
 * Create a logger for constant folding operations
 * @param component The folding component (e.g., 'evaluation', 'binary-ops', 'functions')
 * @returns A debug logger with the standard optimizer:folding namespace
 */
export function foldingLog(component: string = '') {
	const namespace = component ? `optimizer:folding:${component}` : 'optimizer:folding';
	return createLogger(namespace);
}

/**
 * Create a logger for plan emission
 * @param emitterName The name of the emitter
 * @returns A debug logger with the standard runtime:emit namespace
 */
export function emitLog(emitterName: string) {
	return createLogger(`runtime:emit:${emitterName}`);
}





/**
 * Examples of debug namespace usage
 *
 * Enable all optimizer rules: DEBUG=optimizer:rule:* yarn test
 * Enable plan validation: DEBUG=optimizer:validate yarn test
 * Enable runtime stats: DEBUG=runtime:stats yarn test
 * Enable specific rule: DEBUG=optimizer:rule:aggregate-streaming yarn test
 * Enable everything: DEBUG=* yarn test
 */
