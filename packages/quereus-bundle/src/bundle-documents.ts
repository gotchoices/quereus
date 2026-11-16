import { isMap, isSeq } from 'yaml';
import type { Node, YAMLMap } from 'yaml';
import {
	BUNDLE_FORMAT_VERSION,
	DATA_KEY,
	HEADER_KEY,
	ROWS_KEY,
	TRAILER_KEY,
	type BundleHeader,
	type BundleSchemaEntry,
	type BundleTableEntry,
	type BundleTableRef,
	type BundleTrailerTable,
} from './format.js';
import { BundleError, type BundleErrorKind } from './hooks.js';
import type { BundleDocument } from './read-documents.js';
import { TO_JS_OPTIONS } from './value-codec.js';

/**
 * Reads the header, data and trailer documents of a bundle (`docs/bundle.md` § Format)
 * into typed values, refusing any document that does not have the format's shape. Each
 * refusal is a `format` (or, for an unknown version, `version`) {@link BundleError}.
 */

export type DocumentKind = 'header' | 'data' | 'trailer' | 'unknown';

/** Which document `item` is, by its identifying top-level key. */
export function documentKind(item: BundleDocument): DocumentKind {
	const contents = item.document.contents;
	if (!isMap(contents)) return 'unknown';
	if (contents.has(HEADER_KEY)) return 'header';
	if (contents.has(DATA_KEY)) return 'data';
	if (contents.has(TRAILER_KEY)) return 'trailer';
	return 'unknown';
}

/** A data document: the table it names and its row nodes, each still to be decoded. */
export interface DataDocument {
	ref: BundleTableRef;
	rows: readonly unknown[];
}

/** An error about document `item`, positioned at its YAML error when it has one, else at its start. */
export function documentError(item: BundleDocument, message: string, kind: BundleErrorKind = 'format', ref?: BundleTableRef): BundleError {
	const position = item.error?.line !== undefined ? item.error : item.locate(item.document.range[0]);
	return new BundleError(message, {
		phase: 'read', kind, documentIndex: item.index, schema: ref?.schema, table: ref?.table,
		line: position.line, column: position.column,
	});
}

/** @throws BundleError when `item` is not a version 1 header. */
export function parseHeader(item: BundleDocument): BundleHeader {
	if (item.error) throw documentError(item, `The header is not valid YAML: ${item.error.message}`);
	if (documentKind(item) !== 'header') {
		throw documentError(item, `The input does not start with a bundle header ('${HEADER_KEY}: ${BUNDLE_FORMAT_VERSION}')`);
	}
	const value = plainContents(item);
	const version = value[HEADER_KEY];
	if (version !== BigInt(BUNDLE_FORMAT_VERSION)) {
		throw documentError(item, `Bundle format version ${String(version)} is not supported; this reader reads version ${BUNDLE_FORMAT_VERSION}`, 'version');
	}
	const fail = (message: string): never => { throw documentError(item, `Malformed header: ${message}`); };
	return {
		[HEADER_KEY]: BUNDLE_FORMAT_VERSION,
		created: typeof value.created === 'string' ? value.created : '',
		...(value.schemas === undefined ? {} : { schemas: schemaEntries(value.schemas, fail) }),
		...(value.tables === undefined ? {} : { tables: tableEntries(value.tables, fail) }),
	};
}

/** @throws BundleError when `item` is not a well-formed data document. */
export function parseDataDocument(item: BundleDocument): DataDocument {
	const contents = item.document.contents as YAMLMap;
	const ref = tableRefOf(contents.get(DATA_KEY, true));
	if (!ref) throw documentError(item, `A data document's '${DATA_KEY}' must name a table as {schema, table}`);
	if (item.error) throw documentError(item, `Data document for ${ref.schema}.${ref.table} is not valid YAML: ${item.error.message}`, 'format', ref);
	const rows = contents.get(ROWS_KEY, true);
	if (!isSeq(rows)) throw documentError(item, `Data document for ${ref.schema}.${ref.table} has no '${ROWS_KEY}' sequence`, 'format', ref);
	return { ref, rows: rows.items };
}

/** The table a damaged data document names, when that much of it can still be read. */
export function damagedDataRef(item: BundleDocument): BundleTableRef | undefined {
	if (documentKind(item) !== 'data') return undefined;
	return tableRefOf((item.document.contents as YAMLMap).get(DATA_KEY, true));
}

/** How many rows a damaged data document holds, when its row sequence can still be read. */
export function damagedRowCount(item: BundleDocument): number | undefined {
	if (documentKind(item) !== 'data') return undefined;
	const rows = (item.document.contents as YAMLMap).get(ROWS_KEY, true);
	return isSeq(rows) ? rows.items.length : undefined;
}

/** @throws BundleError when `item` is not a well-formed trailer. */
export function parseTrailer(item: BundleDocument): BundleTrailerTable[] {
	if (item.error) throw documentError(item, `The trailer is not valid YAML: ${item.error.message}`);
	const fail = (message: string): never => { throw documentError(item, `Malformed trailer: ${message}`); };
	const end = plainContents(item)[TRAILER_KEY];
	if (!isRecord(end) || !Array.isArray(end.tables)) return fail(`'${TRAILER_KEY}.tables' must be a sequence`);
	return end.tables.map((entry: unknown, i: number) => {
		if (!isRecord(entry)) return fail(`entry ${i} is not a map`);
		const ref = plainTableRef(entry) ?? fail(`entry ${i} must name a table as {schema, table}`);
		const rows = entry.rows;
		if (typeof rows !== 'bigint' || rows < 0n || rows > BigInt(Number.MAX_SAFE_INTEGER)) return fail(`entry ${i} has no row count`);
		if (entry.error !== undefined && typeof entry.error !== 'string') return fail(`entry ${i}'s error is not a string`);
		return { ...ref, rows: Number(rows), ...(entry.error === undefined ? {} : { error: entry.error }) };
	});
}

/** A lowercased key for a table, safe for names containing dots. */
export function tableKey(ref: BundleTableRef): string {
	return JSON.stringify([ref.schema.toLowerCase(), ref.table.toLowerCase()]);
}

function schemaEntries(value: unknown, fail: (message: string) => never): BundleSchemaEntry[] {
	if (!Array.isArray(value)) return fail('schemas must be a sequence');
	const seen = new Set<string>();
	return value.map((entry: unknown, i: number) => {
		if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.declaration !== 'string') {
			return fail(`schemas entry ${i} must have a string name and declaration`);
		}
		if (seen.has(entry.name.toLowerCase())) fail(`schema '${entry.name}' is listed twice`);
		seen.add(entry.name.toLowerCase());
		return { name: entry.name, declaration: entry.declaration };
	});
}

function tableEntries(value: unknown, fail: (message: string) => never): BundleTableEntry[] {
	if (!Array.isArray(value)) return fail('tables must be a sequence');
	const seen = new Set<string>();
	return value.map((entry: unknown, i: number) => {
		if (!isRecord(entry)) return fail(`tables entry ${i} is not a map`);
		const ref = plainTableRef(entry) ?? fail(`tables entry ${i} must name a table as {schema, table}`);
		const columns = entry.columns;
		if (!Array.isArray(columns) || !columns.every(c => typeof c === 'string')) {
			return fail(`${ref.schema}.${ref.table} must list its columns as strings`);
		}
		if (new Set(columns.map(c => c.toLowerCase())).size !== columns.length) fail(`${ref.schema}.${ref.table} lists a column twice`);
		if (seen.has(tableKey(ref))) fail(`table ${ref.schema}.${ref.table} is listed twice`);
		seen.add(tableKey(ref));
		return { ...ref, columns };
	});
}

/** The document's contents as plain values: ints are `bigint`, and an alias is refused. */
function plainContents(item: BundleDocument): Record<string, unknown> {
	let value: unknown;
	try {
		value = item.document.toJS(TO_JS_OPTIONS);
	} catch (e) {
		throw documentError(item, `Cannot read document ${item.index}: ${e instanceof Error ? e.message : String(e)}`);
	}
	if (!isRecord(value)) throw documentError(item, `Document ${item.index} is not a map`);
	return value;
}

function tableRefOf(node: Node | unknown): BundleTableRef | undefined {
	if (!isMap(node)) return undefined;
	const schema = node.get('schema');
	const table = node.get('table');
	return typeof schema === 'string' && typeof table === 'string' ? { schema, table } : undefined;
}

function plainTableRef(entry: Record<string, unknown>): BundleTableRef | undefined {
	return typeof entry.schema === 'string' && typeof entry.table === 'string' ? { schema: entry.schema, table: entry.table } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
