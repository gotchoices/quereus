import { createLogger } from '../../common/logger.js';
import type { SqlValue, JSONValue } from '../../common/types.js';

const log = createLogger('func:builtins:json-helpers');

/**
 * Safely parses a JSON string into a JavaScript value
 *
 * @param jsonString The string to parse as JSON
 * @returns The parsed value or null if parsing failed
 */
export function safeJsonParse(jsonString: SqlValue): JSONValue | null {
	if (typeof jsonString !== 'string') {
		return null;
	}
	try {
		return JSON.parse(jsonString) as JSONValue;
	} catch {
		return null;
	}
}

/**
 * Coerces a SqlValue to a JSONValue, accepting both native objects and JSON strings.
 * This is the primary entry point for json_* functions that accept JSON input.
 *
 * Returns `undefined` on parse/conversion failure (to distinguish from JSON null).
 *
 * @param input The SQL value to coerce
 * @returns The JSON value (including null for SQL NULL / JSON null), or undefined on failure
 */
export function coerceToJsonValue(input: SqlValue): JSONValue | undefined {
	if (input === null) return null;
	if (typeof input === 'string') {
		try { return JSON.parse(input) as JSONValue; } catch { return undefined; }
	}
	if (typeof input === 'object' && !(input instanceof Uint8Array)) return input as JSONValue;
	if (typeof input === 'number' || typeof input === 'boolean') return input;
	return undefined;
}

/**
 * Parses a JSON path and returns information needed for modification
 *
 * Handles standard JSON path syntax ($, $.key, $[0], etc.) and optionally
 * creates intermediate objects/arrays for operations like json_set.
 *
 * @param data The JSON data structure to traverse
 * @param path The JSON path string
 * @param createParents Whether to create missing intermediate objects/arrays
 * @returns Path resolution information or null if the path is invalid
 */
export function resolveJsonPathForModify(
	data: JSONValue,
	path: string,
	createParents: boolean = false
): { parent: JSONValue | null; key: string | number; value: JSONValue | undefined; exists: boolean } | null {
	if (!path || typeof path !== 'string') return null;

	let current: JSONValue | undefined = data;
	let parent: JSONValue | null = null;
	let finalKey: string | number | null = null;
	let remainingPath = path.startsWith('$') ? path.substring(1) : path;

	if (remainingPath === '') {
		return { parent: null, key: '', value: data, exists: true };
	}

	while (remainingPath.length > 0) {
		parent = current as JSONValue;
		finalKey = null;

		if (current === undefined || current === null) return null;

		if (remainingPath.startsWith('.')) {
			remainingPath = remainingPath.substring(1);
			let keyStr: string;
			if (remainingPath.startsWith('"')) {
				const endQuote = remainingPath.indexOf('"', 1);
				if (endQuote === -1) return null;
				keyStr = remainingPath.substring(1, endQuote);
				remainingPath = remainingPath.substring(endQuote + 1);
			} else {
				const match = remainingPath.match(/^([^[.\s]+)/);
				if (!match) return null;
				keyStr = match[1];
				remainingPath = remainingPath.substring(keyStr.length);
			}
			if (typeof current !== 'object' || current === null || Array.isArray(current)) {
				if (!createParents || typeof parent !== 'object' || parent === null || Array.isArray(parent) || typeof finalKey !== 'string') {
					return { parent, key: keyStr, value: undefined, exists: false };
				}
				log(`JSON Path: Creating intermediate object for key "%s"`, finalKey);
				(parent as Record<string, JSONValue>)[finalKey] = {};
				current = (parent as Record<string, JSONValue>)[finalKey];
				parent = current;
				finalKey = keyStr;
				current = (current as Record<string, JSONValue>)[keyStr];
			} else {
				finalKey = keyStr;
				current = (current as Record<string, JSONValue>)[keyStr];
			}

		} else if (remainingPath.startsWith('[')) {
			const endBracket = remainingPath.indexOf(']');
			if (endBracket === -1) return null;
			const indexStr = remainingPath.substring(1, endBracket).trim();
			const index = parseInt(indexStr, 10);
			remainingPath = remainingPath.substring(endBracket + 1);

			if (!Number.isInteger(index) || index < 0) return null;

			if (!Array.isArray(current)) {
				if (!createParents || parent === null || finalKey === null) {
					return { parent, key: index, value: undefined, exists: false };
				}
				const newParentArray: JSONValue[] = [];
				if (Array.isArray(parent) && typeof finalKey === 'number') {
					log(`JSON Path: Creating intermediate array for index %d`, finalKey);
					parent[finalKey] = newParentArray;
				} else if (typeof parent === 'object' && parent !== null && !Array.isArray(parent) && typeof finalKey === 'string') {
					log(`JSON Path: Creating intermediate array for key "%s"`, finalKey);
					(parent as Record<string, JSONValue>)[finalKey] = newParentArray;
				} else {
					return { parent, key: index, value: undefined, exists: false };
				}
				current = newParentArray;
				parent = current;
				finalKey = index;
				current = index < current.length ? current[index] : undefined;
			} else {
				finalKey = index;
				current = index < current.length ? current[index] : undefined;
			}
		} else {
			return null;
		}
	}

	if (finalKey === null) return null;
	return { parent, key: finalKey, value: current, exists: current !== undefined };
}

/**
 * Converts an SQL value to a JSON-compatible value for insertion or modification
 *
 * Handles type conversion for SQL types that don't directly map to JSON:
 * - BigInt: Converts to number if in safe range, otherwise to string
 * - Blob: Converts to null as blobs can't be represented in JSON
 * - NaN/Infinity: Converts to null
 * - JSON strings: Parses into actual objects/arrays
 *
 * @param value The SQL value to convert
 * @returns A JSON-compatible value
 */
export function prepareJsonValue(value: SqlValue): JSONValue {
	if (typeof value === 'bigint') {
		if (value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER) {
			return Number(value);
		}
		return value.toString();
	}
	if (value instanceof Uint8Array) {
		return null;
	}
	if (typeof value === 'number' && !Number.isFinite(value)) {
		return null;
	}
	if (typeof value === 'string') {
		try {
			return JSON.parse(value);
		} catch {
			return value;
		}
	}
	return value;
}

/**
 * Creates a deep copy of JSON-compatible data
 *
 * @param data The data to copy
 * @returns A deep copy of the input data
 */
export function deepCopyJson(data: JSONValue): JSONValue {
	if (data === null || typeof data !== 'object') {
		return data;
	}
	if (Array.isArray(data)) {
		return data.map(deepCopyJson);
	}
	const copy: Record<string, JSONValue> = {};
	for (const key in data) {
		if (Object.prototype.hasOwnProperty.call(data, key)) {
			copy[key] = deepCopyJson((data as Record<string, JSONValue>)[key]);
		}
	}
	return copy;
}

/**
 * Determines the SQLite JSON type name for a JavaScript value
 *
 * @param value The value to check
 * @returns The SQLite JSON type name ('null', 'true', 'false', 'integer', 'real', 'text', 'array', 'object')
 */
export function getJsonType(value: JSONValue): string {
	if (value === null) return 'null';
	switch (typeof value) {
		case 'boolean': return value ? 'true' : 'false';
		case 'number': return Number.isInteger(value) ? 'integer' : 'real';
		case 'string': return 'text';
		case 'object':
			if (Array.isArray(value)) return 'array';
			return 'object';
		default: return 'null';
	}
}

/**
 * Evaluates a simple JSON path against data
 *
 * A simplified version of path evaluation that handles basic paths
 * but doesn't support all features of resolveJsonPathForModify.
 *
 * @param data The JSON data to query
 * @param path The path to evaluate
 * @returns The value at the path or undefined if not found
 */
export function evaluateJsonPathBasic(data: JSONValue, path: string): JSONValue | undefined {
	if (!path || path === '$') return data;

	const parts = path.startsWith('$.') ? path.substring(2).split('.') :
					path.startsWith('$') ? path.substring(1).split('.') :
					path.split('.');

	let current = data;
	for (const part of parts) {
		if (current === null || current === undefined) return undefined;

		const arrayMatch = part.match(/^\s*\[(\d+)\]\s*$/);
		if (arrayMatch) {
			const index = parseInt(arrayMatch[1], 10);
			if (Array.isArray(current) && index >= 0 && index < current.length) {
				current = current[index];
			} else {
				return undefined;
			}
		} else if (typeof current === 'object' && current !== null && !Array.isArray(current) && Object.prototype.hasOwnProperty.call(current, part)) {
			current = (current as Record<string, JSONValue>)[part];
		} else {
			return undefined;
		}
	}
	return current;
}
