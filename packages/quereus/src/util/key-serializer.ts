/**
 * Shared key serialization for hash-based operations (bloom join, window partitioning, etc.).
 *
 * Produces type-tagged, collation-aware string keys suitable for Map/Set lookups.
 * The serialization is designed so that two SQL values compare as equal (under their
 * declared collation) if and only if their serialized keys are identical strings.
 */
import type { Row, SqlValue } from '../common/types.js';

/** Identity normalizer for BINARY collation (no-op). */
const IDENTITY_NORMALIZER = (s: string) => s;

/** Strip trailing ASCII space (0x20) only, matching `RTRIM_COLLATION`'s
 *  comparator. `s.trimEnd()` would also strip tabs, NBSP, and other Unicode
 *  whitespace — disagreeing with the comparator and producing wrong index keys. */
const RTRIM_NORMALIZER = (s: string): string => {
	let end = s.length;
	while (end > 0 && s.charCodeAt(end - 1) === 0x20) end--;
	return end === s.length ? s : s.slice(0, end);
};

const NOCASE_NORMALIZER = (s: string): string => s.toLowerCase();

/** Map a collation name to a string normalizer for key serialization. */
export function resolveKeyNormalizer(collationName: string | undefined): (s: string) => string {
	if (!collationName || collationName === 'BINARY') return IDENTITY_NORMALIZER;
	switch (collationName.toUpperCase()) {
		case 'NOCASE': return NOCASE_NORMALIZER;
		case 'RTRIM':  return RTRIM_NORMALIZER;
		default:       return IDENTITY_NORMALIZER;
	}
}

/** Built-in normalizers, exported so the `Database` collation registry can seed
 *  them alongside the comparators. Keys match the SQL canonical names. */
export const BUILTIN_NORMALIZERS: Readonly<Record<string, (s: string) => string>> = {
	BINARY: IDENTITY_NORMALIZER,
	NOCASE: NOCASE_NORMALIZER,
	RTRIM: RTRIM_NORMALIZER,
};

/**
 * Core serialization of a single SQL value with type tag and optional collation normalizer.
 * Appends to the key accumulator.  Returns false if the value is NULL (caller decides semantics).
 */
function appendValue(val: SqlValue, normalizer: (s: string) => string): string | null {
	if (val === null || val === undefined) return null;
	if (typeof val === 'string') {
		return 's:' + normalizer(val);
	} else if (typeof val === 'number') {
		return 'n:' + val;
	} else if (typeof val === 'bigint') {
		return 'b:' + val;
	} else if (val instanceof Uint8Array) {
		return 'x:' + Array.from(val).join(',');
	} else {
		return 'o:' + String(val);
	}
}

/**
 * Serialize a composite key from an array of pre-evaluated SQL values.
 * Returns null if any value is NULL (SQL NULL ≠ NULL semantics).
 *
 * For window PARTITION BY where NULLs should group together, the caller
 * should use {@link serializeKeyNullGrouping} instead.
 */
export function serializeKey(
	values: readonly SqlValue[],
	normalizers: readonly ((s: string) => string)[]
): string | null {
	let key = '';
	for (let i = 0; i < values.length; i++) {
		const part = appendValue(values[i], normalizers[i]);
		if (part === null) return null;
		if (i > 0) key += '\0';
		key += part;
	}
	return key;
}

/**
 * Serialize a composite key where NULLs are treated as a grouping value
 * rather than causing the entire key to be null.
 *
 * Used by window PARTITION BY (SQL standard: NULLs group together).
 */
export function serializeKeyNullGrouping(
	values: readonly SqlValue[],
	normalizers: readonly ((s: string) => string)[]
): string {
	let key = '';
	for (let i = 0; i < values.length; i++) {
		if (i > 0) key += '\0';
		const part = appendValue(values[i], normalizers[i]);
		if (part === null) {
			key += 'N:';
		} else {
			key += part;
		}
	}
	return key;
}

/**
 * Row-indexed variant: extracts values from a Row by column indices, then serializes.
 * Returns null if any extracted value is NULL.
 *
 * Used by bloom join where keys come from specific row positions.
 */
export function serializeRowKey(
	row: Row,
	indices: readonly number[],
	normalizers: readonly ((s: string) => string)[]
): string | null {
	let key = '';
	for (let i = 0; i < indices.length; i++) {
		const val = row[indices[i]];
		const part = appendValue(val, normalizers[i]);
		if (part === null) return null;
		if (i > 0) key += '\0';
		key += part;
	}
	return key;
}
