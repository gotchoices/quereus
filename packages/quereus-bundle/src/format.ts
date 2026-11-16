/**
 * The bundle file format, version 1: a multi-document YAML 1.2 stream holding one header
 * document, zero or more data documents (one batch of one table's rows each), and one
 * trailer document. The authoritative description is `docs/bundle.md`.
 */

/** The `quereus-bundle` value this package writes, and the only one it reads. */
export const BUNDLE_FORMAT_VERSION = 1;

/** Top-level key of the header document; its value is the format version. */
export const HEADER_KEY = 'quereus-bundle';
/** Top-level key of a data document; its value names the table. */
export const DATA_KEY = 'data';
/** Top-level key of a data document holding its rows. */
export const ROWS_KEY = 'rows';
/** Top-level key of the trailer document. */
export const TRAILER_KEY = 'end';

/** Separates documents in the stream. */
export const DOCUMENT_SEPARATOR = '---\n';

/** One schema's declaration: a single `declare schema <name> { … }` statement. */
export interface BundleSchemaEntry {
	name: string;
	declaration: string;
}

/** Names a table. Schema and table are separate fields because either may contain dots. */
export interface BundleTableRef {
	schema: string;
	table: string;
}

/** A table whose rows follow, with the column order every data row is positional against. */
export interface BundleTableEntry extends BundleTableRef {
	columns: string[];
}

export interface BundleHeader {
	[HEADER_KEY]: number;
	/** ISO 8601 time the export started. */
	created: string;
	/** Present when the export included the schema. */
	schemas?: BundleSchemaEntry[];
	/** Present when the export included data. */
	tables?: BundleTableEntry[];
}

/** Per exported table: how many rows the data documents carry, and why that is short if it is. */
export interface BundleTrailerTable extends BundleTableRef {
	rows: number;
	/** Present when the export gave up on the table partway; its rows are then incomplete. */
	error?: string;
}

export interface BundleTrailer {
	[TRAILER_KEY]: {
		tables: BundleTrailerTable[];
	};
}
