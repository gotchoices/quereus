import type { Row, SqlValue } from '../common/types.js';
import { createLogger } from '../common/logger.js';
import type { LogicalType, CollationFunction } from '../types/logical-type.js';
import { StatusCode } from '../common/types.js';
import { QuereusError } from '../common/errors.js';


const log = createLogger('util:comparison');
const warnLog = log.extend('warn');

export type { CollationFunction };

// Map to store registered collations
const collations = new Map<string, CollationFunction>();

/**
 * Binary (default) collation function.
 * Performs standard lexicographical comparison of strings.
 */
export const BINARY_COLLATION: CollationFunction = (a, b) => {
	return a < b ? -1 : a > b ? 1 : 0;
};

/**
 * Case-insensitive collation function.
 * Compares strings after converting them to lowercase.
 */
export const NOCASE_COLLATION: CollationFunction = (a, b) => {
	const lowerA = a.toLowerCase();
	const lowerB = b.toLowerCase();
	return lowerA < lowerB ? -1 : lowerA > lowerB ? 1 : 0;
};

/**
 * Right-trim collation function.
 * Compares strings after removing trailing spaces.
 */
export const RTRIM_COLLATION: CollationFunction = (a, b) => {
	let lenA = a.length;
	let lenB = b.length;

	while (lenA > 0 && a[lenA - 1] === ' ') lenA--;
	while (lenB > 0 && b[lenB - 1] === ' ') lenB--;

	const minLen = Math.min(lenA, lenB);
	for (let i = 0; i < minLen; i++) {
		if (a[i] !== b[i]) {
			return a[i] < b[i] ? -1 : 1;
		}
	}

	return lenA - lenB;
};

// Register built-in collations
collations.set('BINARY', BINARY_COLLATION);
collations.set('NOCASE', NOCASE_COLLATION);
collations.set('RTRIM', RTRIM_COLLATION);

/**
 * Registers a collation function in the global registry.
 * @deprecated Use `db.registerCollation(name, func)` for per-database collation registration.
 * This global registry is retained for standalone utility use and built-in collation fallback.
 * @param name The name of the collation (case-insensitive)
 * @param func The collation function to register
 */
export function registerCollation(name: string, func: CollationFunction): void {
    const upperName = name.toUpperCase();
    if (collations.has(upperName)) {
        warnLog(`Overwriting existing collation: %s`, upperName);
    }
    collations.set(upperName, func);
}

/**
 * Gets a collation function from the global registry.
 * @deprecated Use `db._getCollation(name)` or `EmissionContext.getCollation()` for per-database lookup.
 * @param name The collation name (case-insensitive)
 * @returns The collation function, or undefined if not found
 */
export function getCollation(name: string): CollationFunction | undefined {
	return collations.get(name.toUpperCase());
}

/**
 * Resolves a collation name to its function from the global registry.
 * @deprecated Use `EmissionContext.resolveCollation()` for per-database resolution during emission.
 * This global version is retained for standalone comparison utilities and vtab internals.
 * @param collationName The collation name
 * @returns The collation function (defaults to BINARY if not found)
 */
export function resolveCollation(collationName: string): CollationFunction {
	if (collationName === 'BINARY') return BINARY_COLLATION; // Fast path for most common case
	const func = collations.get(collationName.toUpperCase());
	if (!func) {
		warnLog(`Unknown collation requested: %s. Falling back to BINARY.`, collationName);
		return BINARY_COLLATION;
	}
	return func;
}

/**
 * Normalizes a collation name to its canonical form (trimmed, uppercase).
 * SQLite treats collation names case-insensitively; the registry and resolvers
 * all key on the uppercase name, so this yields the SQLite-canonical spelling
 * used for DDL validation and downstream comparisons.
 * @param name The collation name as written
 * @returns The canonical (trimmed, uppercase) collation name
 */
export function normalizeCollationName(name: string): string {
	return name.trim().toUpperCase();
}

/** Represents SQLite storage classes for comparison purposes */
enum StorageClass {
	NULL = 0,
	NUMERIC = 1, // INTEGER or REAL
	TEXT = 2,
	BLOB = 3,
	OBJECT = 4, // JSON objects/arrays
	UNKNOWN = 99
}

/**
 * Determines the effective storage class for comparison, converting boolean to numeric.
 * Optimized with early returns for common cases.
 */
function getStorageClass(v: SqlValue): StorageClass {
	if (v === null) return StorageClass.NULL; // Most common null check

	const type = typeof v;
	// Fast path for numbers (most common non-null case)
	if (type === 'number') return StorageClass.NUMERIC;
	if (type === 'string') return StorageClass.TEXT;
	if (type === 'boolean' || type === 'bigint') return StorageClass.NUMERIC;
	if (type === 'object') {
		if (v instanceof Uint8Array) return StorageClass.BLOB;
		return StorageClass.OBJECT;
	}

	return StorageClass.UNKNOWN;
}

/**
 * Returns the SQLite fundamental datatype name of a value.
 * @param v The value
 * @returns The datatype name as a string
 */
export function getSqlDataTypeName(v: SqlValue): 'null' | 'integer' | 'real' | 'text' | 'blob' | 'json' {
	if (v === null || v === undefined) return 'null';
	const type = typeof v;
	if (type === 'boolean') return 'integer';
	if (type === 'number') {
		return Number.isInteger(v) ? 'integer' : 'real';
	}
	if (type === 'bigint') return 'integer';
	if (type === 'string') return 'text';
	if (type === 'object') {
		if (v instanceof Uint8Array) return 'blob';
		return 'json';
	}
	return 'null';
}

/**
 * Fast path comparison for two numbers (most common case).
 * @param a First number
 * @param b Second number
 * @returns -1 if a < b, 0 if a === b, 1 if a > b
 */
function compareNumbers(a: number | bigint, b: number | bigint): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Optimized comparison for same-type values.
 * @param a First value
 * @param b Second value
 * @param storageClass The storage class of both values
 * @param collationFunc The collation function (for TEXT types)
 * @returns -1 if a < b, 0 if a === b, 1 if a > b
 */
function compareSameType(a: SqlValue, b: SqlValue, storageClass: StorageClass, collationFunc: CollationFunction): number {
	switch (storageClass) {
		case StorageClass.NUMERIC: {
			// Convert booleans to numbers inline for efficiency
			const valA = typeof a === 'boolean' ? (a ? 1 : 0) : a as number | bigint;
			const valB = typeof b === 'boolean' ? (b ? 1 : 0) : b as number | bigint;
			return compareNumbers(valA, valB);
		}
		case StorageClass.TEXT: {
			return collationFunc(a as string, b as string);
		}
		case StorageClass.BLOB: {
			const blobA = a as Uint8Array;
			const blobB = b as Uint8Array;
			const len = Math.min(blobA.length, blobB.length);
			for (let i = 0; i < len; i++) {
				if (blobA[i] !== blobB[i]) {
					return blobA[i] < blobB[i] ? -1 : 1;
				}
			}
			return blobA.length < blobB.length ? -1 : blobA.length > blobB.length ? 1 : 0;
		}
		case StorageClass.OBJECT: {
			// Compare JSON objects by their stringified representation
			const strA = JSON.stringify(a);
			const strB = JSON.stringify(b);
			return strA < strB ? -1 : strA > strB ? 1 : 0;
		}
		default: {
			return 0;
		}
	}
}

/**
 * Compares two SQLite values based on SQLite's comparison rules.
 * Follows SQLite's type ordering: NULL < Numeric < TEXT < BLOB
 *
 * @param a First value
 * @param b Second value
 * @param collationName The collation to use for text comparison (defaults to BINARY)
 * @returns -1 if a < b, 0 if a === b, 1 if a > b
 */
export function compareSqlValues(a: SqlValue, b: SqlValue, collationName: string = 'BINARY'): number {
	const collationFunc = collationName === 'BINARY' ? BINARY_COLLATION : resolveCollation(collationName);
	return compareSqlValuesFast(a, b, collationFunc);
}

/**
 * Byte-faithful row value-identity: per-column {@link compareSqlValues} under the
 * default BINARY collation — numeric-storage-class tolerant (a bigint `5n` equals a
 * number `5`, so equal values of differing JS identity are not spuriously treated as
 * changed) but byte-exact for text. Rows of differing width are never identical.
 *
 * This is the skip-identical comparison for value-identical maintenance-upsert
 * suppression (the normative contract in `vtab/backing-host.ts`). It is deliberately
 * collation-UNAWARE: a collation-equal / byte-different write (e.g. a case-only
 * rewrite under a NOCASE column) is a real, observable change — `select` returns the
 * stored bytes — that must replace the stored value and report an `update`, never be
 * suppressed. Collation governs key *identity* (which row an upsert replaces); value
 * *fidelity* is binary.
 */
export function rowsValueIdentical(a: readonly SqlValue[], b: readonly SqlValue[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (compareSqlValuesFast(a[i], b[i], BINARY_COLLATION) !== 0) return false;
	}
	return true;
}

/**
 * Optimized version of compareSqlValues that takes a pre-resolved collation function.
 * This avoids the collation lookup on every call.
 *
 * @param a First value
 * @param b Second value
 * @param collationFunc Pre-resolved collation function
 * @returns -1 if a < b, 0 if a === b, 1 if a > b
 */
export function compareSqlValuesFast(a: SqlValue, b: SqlValue, collationFunc: CollationFunction): number {
	const classA = getStorageClass(a);
	const classB = getStorageClass(b);

	// Fast path: NULL comparisons
	if (classA === StorageClass.NULL) {
		return classB === StorageClass.NULL ? 0 : -1;
	}
	if (classB === StorageClass.NULL) {
		return 1;
	}

	// Fast path: same type comparison
	if (classA === classB) {
		return compareSameType(a, b, classA, collationFunc);
	}

	// Different types: compare by storage class ordering
	return classA - classB;
}

/**
 * Direction flags for optimized comparisons (avoids string comparison in hot path)
 */
export const enum SortDirection {
	ASC = 0,
	DESC = 1
}

/**
 * NULL ordering flags for optimized comparisons
 */
export const enum NullsOrdering {
	DEFAULT = 0,  // Use SQLite default (nulls first for ASC, nulls last for DESC)
	FIRST = 1,
	LAST = 2
}

/**
 * Highly optimized comparison function for ORDER BY operations.
 * Takes pre-resolved collation function and numeric flags to avoid string comparisons.
 *
 * @param a First value
 * @param b Second value
 * @param direction Sort direction (SortDirection.ASC or SortDirection.DESC)
 * @param nullsOrdering NULL ordering (NullsOrdering enum)
 * @param collationFunc Pre-resolved collation function
 * @returns -1 if a < b, 0 if a === b, 1 if a > b (after applying direction and null ordering)
 */
export function compareWithOrderByFast(
	a: SqlValue,
	b: SqlValue,
	direction: SortDirection,
	nullsOrdering: NullsOrdering,
	collationFunc: CollationFunction
): number {
	let comparison: number;

	// Fast path: both values are non-NULL (most common case)
	if (a !== null && b !== null) {
		comparison = compareSqlValuesFast(a, b, collationFunc);
	} else if (a === null && b === null) {
		comparison = 0;
	} else if (a === null) {
		// Explicit NULLS ordering is absolute — not affected by ASC/DESC
		if (nullsOrdering === NullsOrdering.FIRST) return -1;
		if (nullsOrdering === NullsOrdering.LAST) return 1;
		// Default behavior: nulls always first (both ASC and DESC)
		comparison = direction === SortDirection.DESC ? 1 : -1;
	} else { // b === null
		// Explicit NULLS ordering is absolute — not affected by ASC/DESC
		if (nullsOrdering === NullsOrdering.FIRST) return 1;
		if (nullsOrdering === NullsOrdering.LAST) return -1;
		// Default behavior: nulls always first (both ASC and DESC)
		comparison = direction === SortDirection.DESC ? -1 : 1;
	}

	// Apply DESC direction (branchless when direction is ASC)
	return direction === SortDirection.DESC ? -comparison : comparison;
}

/**
 * Compares two SQL values with ORDER BY semantics including direction and NULL ordering.
 * This consolidates the comparison logic used by both sort and window operations.
 *
 * @param a First value
 * @param b Second value
 * @param direction Sort direction ('asc' or 'desc')
 * @param nullsOrdering Explicit NULLS ordering ('first', 'last', or undefined for default)
 * @param collationName The collation to use for text comparison (defaults to BINARY)
 * @returns -1 if a < b, 0 if a === b, 1 if a > b (after applying direction and null ordering)
 */
export function compareWithOrderBy(
	a: SqlValue,
	b: SqlValue,
	direction: 'asc' | 'desc' = 'asc',
	nullsOrdering?: 'first' | 'last',
	collationName: string = 'BINARY'
): number {
	// Convert to optimized flags and use fast path
	const directionFlag = direction === 'desc' ? SortDirection.DESC : SortDirection.ASC;
	const nullsFlag = nullsOrdering === 'first'
		? NullsOrdering.FIRST
		: nullsOrdering === 'last'
			? NullsOrdering.LAST
			: NullsOrdering.DEFAULT;
	const collationFunc = collationName === 'BINARY' ? BINARY_COLLATION : resolveCollation(collationName);

	return compareWithOrderByFast(a, b, directionFlag, nullsFlag, collationFunc);
}

/**
 * Factory function to create optimized comparison functions for repeated use.
 * Pre-resolves collation and converts string flags to numeric for maximum performance.
 *
 * @param direction Sort direction ('asc' or 'desc')
 * @param nullsOrdering Explicit NULLS ordering ('first', 'last', or undefined for default)
 * @param collationName The collation to use for text comparison (defaults to BINARY)
 * @returns An optimized comparison function
 */
export function createOrderByComparator(
	direction: 'asc' | 'desc' = 'asc',
	nullsOrdering?: 'first' | 'last',
	collationName: string = 'BINARY'
): (a: SqlValue, b: SqlValue) => number {
	const collationFunc = collationName === 'BINARY' ? BINARY_COLLATION : resolveCollation(collationName);
	return createOrderByComparatorFast(direction, nullsOrdering, collationFunc);
}

/**
 * Optimized factory function that takes a pre-resolved collation function.
 * This is the most efficient option when the collation function is already available.
 *
 * @param direction Sort direction ('asc' or 'desc')
 * @param nullsOrdering Explicit NULLS ordering ('first', 'last', or undefined for default)
 * @param collationFunc Pre-resolved collation function
 * @returns An optimized comparison function
 */
export function createOrderByComparatorFast(
	direction: 'asc' | 'desc' = 'asc',
	nullsOrdering?: 'first' | 'last',
	collationFunc: CollationFunction = BINARY_COLLATION
): (a: SqlValue, b: SqlValue) => number {
	const directionFlag = direction === 'desc' ? SortDirection.DESC : SortDirection.ASC;
	const nullsFlag = nullsOrdering === 'first'
		? NullsOrdering.FIRST
		: nullsOrdering === 'last'
			? NullsOrdering.LAST
			: NullsOrdering.DEFAULT;

	// Return a closure that captures the pre-resolved values
	return (a: SqlValue, b: SqlValue): number => {
		return compareWithOrderByFast(a, b, directionFlag, nullsFlag, collationFunc);
	};
}

/**
 * Determines if a SqlValue is truthy for filter purposes.
 * In SQL semantics (numeric truthiness):
 * - NULL is falsy
 * - booleans: false/true
 * - numbers: 0 is falsy, non-zero is truthy
 * - bigint: 0n is falsy, non-zero is truthy
 * - strings: trimmed numeric conversion is used; non-numeric converts to 0 (falsy)
 * - blobs: convert to 0 (falsy)
 */
export function isTruthy(value: SqlValue): boolean {
	if (value === null) return false;

	switch (typeof value) {
		case 'boolean':
			return value;
		case 'number':
			return value !== 0;
		case 'bigint':
			return value !== 0n;
		case 'string': {
			const trimmed = value.trim();
			if (trimmed === '') return false;
			const n = Number(trimmed);
			return !Number.isNaN(n) && n !== 0;
		}
		default:
			break;
	}

	if (value instanceof Uint8Array) return false;

	return false;
}
/**
 * Compares two rows for SQL DISTINCT semantics.
 * Returns -1, 0, or 1 for BTree ordering.
 */
export function compareRows(a: Row, b: Row): number {
	// Let's assume correct rows
	// if (a.length !== b.length) {
	// 	return a.length - b.length;
	// }
	// Compare each value using SQL semantics
	for (let i = 0; i < a.length; i++) {
		const comparison = compareSqlValues(a[i], b[i]);
		if (comparison !== 0) {
			return comparison;
		}
	}
	return 0;
}

/**
 * Check two SQL values for equality, with proper handling of BLOBs (Uint8Array).
 * Unlike compareSqlValues, this performs byte-wise comparison for BLOBs.
 */
export function sqlValuesEqual(a: SqlValue, b: SqlValue): boolean {
	if (a instanceof Uint8Array && b instanceof Uint8Array) {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (a[i] !== b[i]) return false;
		}
		return true;
	}
	// JSON object comparison by value
	if (typeof a === 'object' && a !== null && !(a instanceof Uint8Array) &&
		typeof b === 'object' && b !== null && !(b instanceof Uint8Array)) {
		return JSON.stringify(a) === JSON.stringify(b);
	}
	return a === b;
}

/**
 * Type-aware comparison function that uses logical type information.
 * This eliminates runtime type detection and uses type-specific comparison logic.
 *
 * @param a First value
 * @param b Second value
 * @param typeA Logical type of first value
 * @param typeB Logical type of second value (should match typeA for strict typing)
 * @param collation Optional collation function for TEXT types
 * @returns -1 if a < b, 0 if a === b, 1 if a > b
 * @throws QuereusError if types don't match (strict typing)
 */
export function compareTypedValues(
	a: SqlValue,
	b: SqlValue,
	typeA: LogicalType,
	typeB: LogicalType,
	collation?: CollationFunction
): number {
	// NULL handling
	if (a === null && b === null) return 0;
	if (a === null) return -1;
	if (b === null) return 1;

	// Type mismatch error (strict typing)
	if (typeA !== typeB) {
		throw new QuereusError(
			`Type mismatch in comparison: ${typeA.name} vs ${typeB.name}`,
			StatusCode.MISMATCH
		);
	}

	// Use type-specific comparison if available
	if (typeA.compare) {
		return typeA.compare(a, b, collation);
	}

	// Fallback to default comparison based on physical type
	// This shouldn't happen for built-in types, but provides safety for custom types
	return compareSqlValuesFast(a, b, collation ?? BINARY_COLLATION);
}

/**
 * Create a type-aware comparator function for a specific logical type.
 * This is optimized for use in indexes and sorts where the type is known at creation time.
 *
 * @param type The logical type
 * @param collation Optional collation function for TEXT types
 * @returns A comparator function
 */
export function createTypedComparator(
	type: LogicalType,
	collation?: CollationFunction
): (a: SqlValue, b: SqlValue) => number {
	// Pre-resolve the comparison function
	const compareFunc = type.compare;
	const collationFunc = collation ?? BINARY_COLLATION;

	if (compareFunc) {
		// Type has custom comparison
		return (a: SqlValue, b: SqlValue) => {
			if (a === null && b === null) return 0;
			if (a === null) return -1;
			if (b === null) return 1;
			// Per-type compare assumes both args share the declared logical type.
			// When a caller probes with a different storage class (e.g., an IN-list
			// multi-seek with integer literals against a BLOB index), the per-type
			// compare can silently treat unrelated values as equal, causing index
			// seeks to surface false matches. Fall back to SQLite cross-type
			// ordering on storage-class mismatch.
			const classA = getStorageClass(a);
			const classB = getStorageClass(b);
			if (classA !== classB) return classA - classB;
			return compareFunc(a, b, collation);
		};
	}

	// Fallback to default comparison
	return (a: SqlValue, b: SqlValue) => compareSqlValuesFast(a, b, collationFunc);
}

/**
 * Create a type-aware row comparator that pre-resolves per-column comparators.
 * Use only when runtime types are guaranteed to match declared types
 * (e.g., GROUP BY keys from typed expressions, index keys).
 *
 * @param types Logical types for each column position
 * @param collations Optional collation functions per column
 * @returns A row comparator function
 */
export function createTypedRowComparator(
	types: readonly LogicalType[],
	collations?: readonly (CollationFunction | undefined)[]
): (a: Row, b: Row) => number {
	const comparators = types.map((type, i) =>
		createTypedComparator(type, collations?.[i])
	);
	const len = comparators.length;

	return (a: Row, b: Row): number => {
		for (let i = 0; i < len; i++) {
			const cmp = comparators[i](a[i], b[i]);
			if (cmp !== 0) return cmp;
		}
		return 0;
	};
}

/**
 * Create a row comparator with pre-resolved per-column collation functions.
 * Safe for mixed-type rows (DISTINCT, SET OPERATIONS) where runtime types may
 * differ from declared types. Uses compareSqlValuesFast (which handles cross-type
 * comparison via storage class ordering) but avoids the collation lookup overhead.
 *
 * @param collations Pre-resolved collation functions per column
 * @returns A row comparator function
 */
export function createCollationRowComparator(
	collations: readonly CollationFunction[]
): (a: Row, b: Row) => number {
	const len = collations.length;

	return (a: Row, b: Row): number => {
		for (let i = 0; i < len; i++) {
			const cmp = compareSqlValuesFast(a[i], b[i], collations[i]);
			if (cmp !== 0) return cmp;
		}
		return 0;
	};
}
