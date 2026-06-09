/**
 * Key builder utilities for constructing storage keys.
 *
 * Storage naming convention:
 *   {schema}.{table}              - Data store (row data)
 *   {schema}.{table}_idx_{name}   - Index store (secondary indexes)
 *   {schema}.{table}_stats        - Stats store (row count, etc.)
 *   __catalog__                   - Catalog store (DDL metadata)
 *
 * Within each store, keys are minimal:
 *   - Data store: just the encoded primary key
 *   - Index store: encoded index columns + encoded primary key
 *   - Stats store: single empty key (stats is the only value)
 *   - Catalog store: {schema}.{table} as the key
 */

import type { SqlValue } from '@quereus/quereus';
import { encodeCompositeKey, type EncodeOptions } from './encoding.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Store name suffixes for different data types.
 */
export const STORE_SUFFIX = {
	INDEX: '_idx_',
	STATS: '_stats',
} as const;

/** Reserved catalog store name. */
export const CATALOG_STORE_NAME = '__catalog__';

/** Reserved stats store name. */
export const STATS_STORE_NAME = '__stats__';

/**
 * Build the store name for a table's data.
 * Format: {schema}.{table}
 */
export function buildDataStoreName(schemaName: string, tableName: string): string {
	return `${schemaName}.${tableName}`.toLowerCase();
}

/**
 * Build the store name for a secondary index.
 * Format: {schema}.{table}_idx_{indexName}
 */
export function buildIndexStoreName(
	schemaName: string,
	tableName: string,
	indexName: string
): string {
	return `${schemaName}.${tableName}_idx_${indexName}`.toLowerCase();
}

/**
 * Build the store name for table statistics.
 * @deprecated Stats are now stored in the unified __stats__ store. Use buildStatsKey instead.
 * Format: {schema}.{table}_stats
 */
export function buildStatsStoreName(schemaName: string, tableName: string): string {
	return `${schemaName}.${tableName}_stats`.toLowerCase();
}

/**
 * Build a stats key for use in the unified __stats__ store.
 * Format: {schema}.{table}
 */
export function buildStatsKey(schemaName: string, tableName: string): Uint8Array {
	return encoder.encode(`${schemaName}.${tableName}`.toLowerCase());
}

/**
 * Build a data row key (just the encoded primary key).
 *
 * `directions[i] === true` marks PK column i as DESC — its encoded bytes are
 * bit-inverted so natural byte-lex iteration yields DESC order for that column.
 *
 * `collations[i]`, when defined, encodes PK column i under its own key collation
 * (overriding `options.collation`), so each text PK column honors its declared
 * collation in the physical key bytes. Non-text members ignore it.
 */
export function buildDataKey(
	pkValues: SqlValue[],
	options?: EncodeOptions,
	directions?: ReadonlyArray<boolean>,
	collations?: ReadonlyArray<string | undefined>,
): Uint8Array {
	return encodeCompositeKey(pkValues, options, directions, collations);
}

/**
 * Build a secondary index key.
 * Format: {encoded_index_cols}{encoded_pk}
 *
 * The index columns come first for range scans, followed by PK for uniqueness.
 * `indexDirections` and `pkDirections` independently control DESC bit-inversion
 * for each half so ordered index scans honor per-column direction.
 *
 * `pkCollations[i]`, when defined, encodes the PK-suffix column i under its own
 * key collation (overriding `options.collation`). The PK suffix MUST be encoded
 * with the same per-column collations as the data key (see `buildDataKey`), so
 * index maintenance (delete-then-insert on UPDATE/DELETE) addresses the same
 * bytes the data store keys by. Index columns keep `options.collation`.
 */
export function buildIndexKey(
	indexValues: SqlValue[],
	pkValues: SqlValue[],
	options?: EncodeOptions,
	indexDirections?: ReadonlyArray<boolean>,
	pkDirections?: ReadonlyArray<boolean>,
	pkCollations?: ReadonlyArray<string | undefined>,
): Uint8Array {
	const indexEncoded = encodeCompositeKey(indexValues, options, indexDirections);
	const pkEncoded = encodeCompositeKey(pkValues, options, pkDirections, pkCollations);
	return concatBytes(indexEncoded, pkEncoded);
}

/**
 * Build a catalog key for DDL storage.
 * Format: {schema}.{table}
 */
export function buildCatalogKey(schemaName: string, tableName: string): Uint8Array {
	return encoder.encode(`${schemaName}.${tableName}`.toLowerCase());
}

/**
 * Reserved key-prefix strings for view / materialized-view catalog entries.
 *
 * Table entries keep their existing **unprefixed** key `{schema}.{table}` (a UTF-8
 * encoding of an identifier, whose bytes are all printable — never `0x00`). View and
 * MV entries are given a leading-`0x00` reserved prefix (`"\x00view\x00"` /
 * `"\x00mview\x00"`) so they can never collide with a same-named table entry — a view
 * (or MV) and a table may legally share a name. A leading `0x00` byte is a valid KV
 * key byte for every provider (in-memory, LevelDB, and IndexedDB all accept arbitrary
 * `Uint8Array` keys).
 *
 * Classification rule: {@link buildCatalogScanBounds} (no schema arg) is a full range
 * scan (`gte: []`, `lt: [0xff]`) and so returns these prefixed view/MV entries
 * alongside the unprefixed table entries (every prefix byte `0x00` < `0xff`).
 * {@link classifyCatalogKey} routes each loaded entry to the correct rehydration phase
 * by testing for these prefixes; the two prefixes are mutually exclusive ('v' vs 'm'
 * after the leading `0x00`) and neither is a prefix of a table key.
 */
const VIEW_KEY_PREFIX = '\x00view\x00';
const MVIEW_KEY_PREFIX = '\x00mview\x00';
const VIEW_KEY_PREFIX_BYTES = encoder.encode(VIEW_KEY_PREFIX);
const MVIEW_KEY_PREFIX_BYTES = encoder.encode(MVIEW_KEY_PREFIX);

/** Kind of a loaded catalog entry, determined by its key prefix. */
export type CatalogEntryKind = 'table' | 'view' | 'materializedView';

/**
 * Build a catalog key for a (non-materialized) view's DDL.
 * Format: `\x00view\x00{schema}.{view}` (reserved prefix — never collides with a
 * same-named table entry).
 */
export function buildViewCatalogKey(schemaName: string, viewName: string): Uint8Array {
	return encoder.encode(`${VIEW_KEY_PREFIX}${`${schemaName}.${viewName}`.toLowerCase()}`);
}

/**
 * Build a catalog key for a materialized view's DDL.
 * Format: `\x00mview\x00{schema}.{mv}` (reserved prefix — never collides with a
 * same-named table entry).
 */
export function buildMaterializedViewCatalogKey(schemaName: string, mvName: string): Uint8Array {
	return encoder.encode(`${MVIEW_KEY_PREFIX}${`${schemaName}.${mvName}`.toLowerCase()}`);
}

/**
 * Classify a loaded catalog key by its reserved prefix so `rehydrateCatalog` can
 * route each entry to the correct phase. A view/MV entry must never be fed to the
 * table-phase `importCatalog` (which would fail-loud or mis-handle it).
 */
export function classifyCatalogKey(key: Uint8Array): CatalogEntryKind {
	if (startsWithBytes(key, VIEW_KEY_PREFIX_BYTES)) return 'view';
	if (startsWithBytes(key, MVIEW_KEY_PREFIX_BYTES)) return 'materializedView';
	return 'table';
}

/**
 * Recover the qualified `{schema}.{name}` from a materialized-view catalog key
 * (strips the reserved `\x00mview\x00` prefix). Used by `rehydrateCatalog` to name
 * a re-materialized MV in its result — the re-exec path (`db.exec`) returns no name.
 */
export function decodeMaterializedViewCatalogKey(key: Uint8Array): string {
	return decoder.decode(key).slice(MVIEW_KEY_PREFIX.length);
}

/** True when `key` begins with the byte sequence `prefix`. */
function startsWithBytes(key: Uint8Array, prefix: Uint8Array): boolean {
	if (key.length < prefix.length) return false;
	for (let i = 0; i < prefix.length; i++) {
		if (key[i] !== prefix[i]) return false;
	}
	return true;
}

/**
 * Build range bounds for scanning all rows in a data store.
 *
 * Data stores are per-table so any non-empty key belongs to this table — an
 * unbounded scan is safe and avoids the trap that a leading 0xff byte (produced
 * by inverted NULL type prefix 0x00 ^ 0xff for DESC columns) would be excluded
 * by an `lt: [0xff]` upper bound.
 */
export function buildFullScanBounds(): { gte: Uint8Array } {
	return {
		gte: new Uint8Array(0),
	};
}

/**
 * Build range bounds for scanning an index with a prefix.
 *
 * `directions[i] === true` flips bytes of prefix component i to match DESC
 * encoding in the stored index keys.
 */
export function buildIndexPrefixBounds(
	prefixValues: SqlValue[],
	options?: EncodeOptions,
	directions?: ReadonlyArray<boolean>,
): { gte: Uint8Array; lt: Uint8Array } {
	if (prefixValues.length === 0) {
		return { gte: new Uint8Array(0), lt: new Uint8Array([0xff]) };
	}

	const prefixEncoded = encodeCompositeKey(prefixValues, options, directions);
	return {
		gte: prefixEncoded,
		lt: incrementLastByte(prefixEncoded),
	};
}

/**
 * Build range bounds for scanning catalog entries.
 * Optionally filter by schema prefix.
 */
export function buildCatalogScanBounds(schemaName?: string): { gte: Uint8Array; lt: Uint8Array } {
	if (schemaName) {
		const prefix = `${schemaName}.`.toLowerCase();
		return {
			gte: encoder.encode(prefix),
			lt: incrementLastByte(encoder.encode(prefix)),
		};
	}
	return {
		gte: new Uint8Array(0),
		lt: new Uint8Array([0xff]),
	};
}

/**
 * Increment the last byte of a key to create an exclusive upper bound.
 */
function incrementLastByte(key: Uint8Array): Uint8Array {
	const result = new Uint8Array(key.length);
	result.set(key);

	// Increment from the end, handling overflow
	for (let i = result.length - 1; i >= 0; i--) {
		if (result[i] < 0xff) {
			result[i]++;
			return result;
		}
		result[i] = 0;
	}

	// All bytes were 0xff, append 0x00
	const extended = new Uint8Array(result.length + 1);
	extended.set(result);
	return extended;
}

/**
 * Concatenate multiple byte arrays.
 */
function concatBytes(...arrays: Uint8Array[]): Uint8Array {
	const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
	const result = new Uint8Array(totalLength);
	let offset = 0;
	for (const arr of arrays) {
		result.set(arr, offset);
		offset += arr.length;
	}
	return result;
}

// ============================================================================
// Legacy exports for backwards compatibility during migration
// These will be removed after all consumers are updated.
// ============================================================================

/** @deprecated Use buildDataStoreName instead */
export const KEY_PREFIX = {
	DATA: encoder.encode('d:'),
	INDEX: encoder.encode('i:'),
	META: encoder.encode('m:'),
} as const;

/** @deprecated Use buildDataKey instead */
export function buildTablePrefix(
	_prefix: 'd' | 'i' | 'm',
	schemaName: string,
	tableName: string
): Uint8Array {
	return encoder.encode(`${schemaName}.${tableName}`.toLowerCase());
}

/** @deprecated Use buildFullScanBounds instead */
export function buildTableScanBounds(
	_schemaName: string,
	_tableName: string,
): { gte: Uint8Array } {
	return buildFullScanBounds();
}

/** @deprecated Use buildIndexPrefixBounds instead */
export function buildIndexScanBounds(
	_schemaName: string,
	_tableName: string,
	_indexName: string,
	prefixValues?: SqlValue[],
	options?: EncodeOptions
): { gte: Uint8Array; lt: Uint8Array } {
	return buildIndexPrefixBounds(prefixValues || [], options);
}

/** @deprecated Use buildCatalogKey instead */
export function buildMetaKey(
	_metaType: 'ddl' | 'stats' | 'index',
	schemaName: string,
	objectName: string,
	_subName?: string
): Uint8Array {
	return buildCatalogKey(schemaName, objectName);
}

/** @deprecated Use buildCatalogScanBounds instead */
export function buildMetaScanBounds(
	_metaType: 'ddl' | 'stats' | 'index',
	schemaName?: string
): { gte: Uint8Array; lt: Uint8Array } {
	return buildCatalogScanBounds(schemaName);
}
