import { PhysicalType, type LogicalType, compareNulls } from './logical-type.js';
import { safeJsonParse } from '../func/builtins/json-helpers.js';
import type { JSONValue } from '../common/json-types.js';

/**
 * JSON type - stores JSON values as native JS objects/arrays/primitives.
 * Uses PhysicalType.OBJECT for in-memory representation.
 * Serialize/deserialize hooks convert between native objects and JSON strings for storage.
 */
export const JSON_TYPE: LogicalType = {
	name: 'JSON',
	physicalType: PhysicalType.OBJECT,

	validate: (v) => {
		if (v === null) return true;
		// Native objects/arrays are always valid JSON values
		if (typeof v === 'object' && !(v instanceof Uint8Array)) return true;
		// JSON-compatible primitives (including strings — they represent JSON scalars)
		if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return true;
		return false;
	},

	parse: (v) => {
		if (v === null) return null;
		// Already a native object/array — pass through
		if (typeof v === 'object' && !(v instanceof Uint8Array)) return v;
		// JSON-compatible primitives — pass through as native values
		if (typeof v === 'number') return v;
		if (typeof v === 'boolean') return v;
		// Parse JSON strings into native objects
		if (typeof v === 'string') {
			const parsed = safeJsonParse(v);
			if (parsed === null && v !== 'null') {
				throw new TypeError(`Cannot convert '${v}' to JSON: invalid JSON syntax`);
			}
			return parsed;
		}
		if (typeof v === 'bigint') return Number(v);
		throw new TypeError(`Cannot convert ${typeof v} to JSON`);
	},

	serialize: (v) => {
		// Native object → JSON string for storage
		if (v === null) return null;
		return JSON.stringify(v);
	},

	deserialize: (v) => {
		// JSON string from storage → native object
		if (v === null) return null;
		if (typeof v === 'string') return JSON.parse(v) as JSONValue;
		return v; // Already native
	},

	compare: (a, b) => {
		const nullCmp = compareNulls(a, b);
		if (nullCmp !== undefined) return nullCmp;

		// Ensure both are in native form for comparison
		const parsedA = typeof a === 'string' ? safeJsonParse(a) : a as JSONValue;
		const parsedB = typeof b === 'string' ? safeJsonParse(b) : b as JSONValue;

		if (parsedA === null || parsedB === null) {
			const strA = typeof a === 'string' ? a : JSON.stringify(a);
			const strB = typeof b === 'string' ? b : JSON.stringify(b);
			return strA < strB ? -1 : strA > strB ? 1 : 0;
		}

		return deepCompareJson(parsedA, parsedB);
	},

	supportedCollations: [],

	isNumeric: false,
	isTextual: false,
	isTemporal: false,
};

/** Ordering rank for JSON value types: null < boolean < number < string < array < object */
function jsonTypeOrder(v: JSONValue): number {
	if (v === null) return 0;
	switch (typeof v) {
		case 'boolean': return 1;
		case 'number': return 2;
		case 'string': return 3;
		default: return Array.isArray(v) ? 4 : 5;
	}
}

/**
 * Deep comparison of JSON values.
 * Returns -1, 0, or 1 for ordering.
 */
function deepCompareJson(a: JSONValue, b: JSONValue): number {
	if (a === b) return 0;

	const orderA = jsonTypeOrder(a);
	const orderB = jsonTypeOrder(b);
	if (orderA !== orderB) return orderA < orderB ? -1 : 1;

	if (a === null) return 0;

	if (typeof a === 'boolean' || typeof a === 'number' || typeof a === 'string') {
		return a < (b as typeof a) ? -1 : a > (b as typeof a) ? 1 : 0;
	}

	if (Array.isArray(a) && Array.isArray(b)) {
		const minLen = Math.min(a.length, b.length);
		for (let i = 0; i < minLen; i++) {
			const cmp = deepCompareJson(a[i], b[i]);
			if (cmp !== 0) return cmp;
		}
		return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
	}

	if (typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
		const objA = a as Record<string, JSONValue>;
		const objB = b as Record<string, JSONValue>;
		const keysA = Object.keys(objA).sort();
		const keysB = Object.keys(objB).sort();

		const minKeys = Math.min(keysA.length, keysB.length);
		for (let i = 0; i < minKeys; i++) {
			if (keysA[i] < keysB[i]) return -1;
			if (keysA[i] > keysB[i]) return 1;
		}
		if (keysA.length !== keysB.length) return keysA.length < keysB.length ? -1 : 1;

		for (const key of keysA) {
			const cmp = deepCompareJson(objA[key], objB[key]);
			if (cmp !== 0) return cmp;
		}
		return 0;
	}

	return 0;
}
