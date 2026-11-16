import { Document, Pair, Scalar, YAMLMap, YAMLSeq } from 'yaml';
import type { Node } from 'yaml';
import {
	ENGINE_MANAGED_TABLE_TAG,
	MisuseError,
	exportSchemaDeclaration,
	isMaintainedTable,
	orderDependenciesFirst,
	type Database,
	type Row,
	type Schema,
	type Statement,
	type TableSchema,
} from '@quereus/quereus';
import { astToString, quoteIdentifier } from '@quereus/quereus/emit';
import {
	BUNDLE_FORMAT_VERSION,
	DATA_KEY,
	DOCUMENT_SEPARATOR,
	HEADER_KEY,
	ROWS_KEY,
	TRAILER_KEY,
	type BundleTableEntry,
	type BundleTrailerTable,
} from './format.js';
import { BundleError, cancellation, notifyError, notifyProgress, type BundleHooks } from './hooks.js';
import { DOCUMENT_OPTIONS, STRINGIFY_OPTIONS, encodeString, encodeValue } from './value-codec.js';

export interface ExportOptions extends BundleHooks {
	/** Schemas to export, in order. Default `['main']`. */
	schemas?: string[];
	/** Include each schema's declaration. Default true. */
	schema?: boolean;
	/** Include table rows. Default true. */
	data?: boolean;
	/** Which tables' rows to include. Default: all. */
	tables?: (schema: string, table: string) => boolean;
	/** Rows per data document. Default 1000. */
	batchSize?: number;
	/**
	 * What a failure to read or encode a table does. `'abort'` (default) throws.
	 * `'skip-table'` reports it, keeps the rows already written, marks the table
	 * incomplete in the trailer and moves on.
	 */
	errorPolicy?: 'abort' | 'skip-table';
}

export const DEFAULT_BATCH_SIZE = 1000;

const ERROR_POLICIES: ReadonlyArray<NonNullable<ExportOptions['errorPolicy']>> = ['abort', 'skip-table'];

interface ExportSettings {
	schemaNames: readonly string[];
	schema: boolean;
	data: boolean;
	includes: (schema: string, table: string) => boolean;
	batchSize: number;
	errorPolicy: NonNullable<ExportOptions['errorPolicy']>;
	hooks: BundleHooks;
}

interface ExportedSchema {
	name: string;
	declaration?: string;
	tables: BundleTableEntry[];
}

/** Counters that run across every table of one export. */
interface RunCounters {
	totalRowsDone: number;
	batchIndex: number;
}

/**
 * The database's schemas and/or rows as bundle text (`docs/bundle.md`), one YAML document
 * per string: the header, one data document per `batchSize` rows of a table, then the
 * trailer. Nothing is read until the first string is requested.
 *
 * Rows are read in one transaction for a consistent picture: the export opens one when the
 * database is in autocommit and ends it when iteration ends, including when the consumer
 * stops early. Inside a caller's transaction it reads within that transaction and leaves it
 * open. A table's rows are streamed through one statement, which holds the database's
 * execution lock between strings: do not run statements on this database while consuming
 * the export, or they wait on the export, which waits on you.
 *
 * @throws MisuseError for invalid options, at call time.
 * @throws BundleError while iterating: a schema that cannot be exported (before any text),
 *   a table read or value encoding failure under `errorPolicy: 'abort'`, an aborted
 *   `signal`, or an `onError` hook returning `'abort'`. Every BundleError also goes to
 *   `onError` first.
 */
export function exportBundle(db: Database, options: ExportOptions = {}): AsyncIterable<string> {
	return writeBundle(db, resolveSettings(options));
}

function resolveSettings(options: ExportOptions): ExportSettings {
	const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
	if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
		throw new MisuseError(`batchSize must be a positive integer, got ${batchSize}`);
	}
	const schema = options.schema ?? true;
	const data = options.data ?? true;
	if (!schema && !data) {
		throw new MisuseError('An export needs schema, data, or both');
	}
	const errorPolicy = options.errorPolicy ?? 'abort';
	if (!ERROR_POLICIES.includes(errorPolicy)) {
		throw new MisuseError(`errorPolicy must be one of ${ERROR_POLICIES.join(', ')}, got ${String(errorPolicy)}`);
	}
	const schemaNames = options.schemas ?? ['main'];
	if (schemaNames.length === 0) {
		throw new MisuseError('An export needs at least one schema');
	}
	const seen = new Set<string>();
	for (const name of schemaNames) {
		if (seen.has(name.toLowerCase())) throw new MisuseError(`Schema '${name}' is listed twice`);
		seen.add(name.toLowerCase());
	}
	return {
		schemaNames,
		schema,
		data,
		includes: options.tables ?? (() => true),
		batchSize,
		errorPolicy,
		hooks: { onProgress: options.onProgress, onError: options.onError, signal: options.signal },
	};
}

async function* writeBundle(db: Database, settings: ExportSettings): AsyncGenerator<string> {
	const schemas = settings.schemaNames.map(name => exportedSchema(db, name, settings));
	const tables = settings.data ? schemas.flatMap(s => s.tables) : [];
	yield headerText(schemas, tables, settings);
	const trailer = tables.length > 0 ? yield* readTables(db, tables, settings) : [];
	yield DOCUMENT_SEPARATOR + documentText(trailerNode(trailer));
}

function exportedSchema(db: Database, name: string, settings: ExportSettings): ExportedSchema {
	const schema = db.schemaManager.getSchema(name);
	if (!schema || schema.kind === 'logical') {
		const reason = schema ? 'it is a logical schema' : 'it does not exist';
		fail(settings.hooks, new BundleError(`Cannot export schema '${name}': ${reason}`, { phase: 'schema', kind: 'schema', schema: name }));
	}
	const exported: ExportedSchema = {
		name: schema.name,
		declaration: settings.schema ? declarationOf(db, schema.name, settings.hooks) : undefined,
		tables: settings.data ? exportedTables(schema, settings.includes) : [],
	};
	if (settings.schema) {
		notifyProgress(settings.hooks, { phase: 'schema', schema: schema.name, rowsDone: 0, totalRowsDone: 0 });
	}
	return exported;
}

function declarationOf(db: Database, schemaName: string, hooks: BundleHooks): string {
	try {
		return astToString(exportSchemaDeclaration(db, schemaName));
	} catch (e) {
		return fail(hooks, new BundleError(`Cannot export the declaration of schema '${schemaName}': ${messageOf(e)}`, {
			phase: 'schema', kind: 'schema', schema: schemaName, cause: e,
		}));
	}
}

/**
 * The tables of `schema` whose rows are exported, parents before children along
 * same-schema foreign keys so an importer's intermediate states stay coherent. The input
 * order is the declaration's (by name), which is also the order a cycle keeps.
 */
function exportedTables(schema: Schema, includes: ExportSettings['includes']): BundleTableEntry[] {
	const candidates = sortedByName([...schema.getAllTables()].filter(t => holdsOwnRows(t) && includes(schema.name, t.name)));
	const ordered = orderDependenciesFirst(candidates, t => t.name.toLowerCase(), sameSchemaParents);
	return ordered.map(t => ({
		schema: schema.name,
		table: t.name,
		// A generated column cannot be inserted; the importing table computes it.
		// NOTE: a table whose every column is generated leaves no columns, so its select is
		// invalid and the table fails as a `batch` error. The format has no way to carry such
		// rows; if such tables become legitimate, give them a row count the importer replays.
		columns: t.columns.filter(c => !c.generated).map(c => c.name),
	}));
}

/**
 * A view has no rows, a maintained table's rows are derived (`apply schema` refills it),
 * and an engine-managed table is not part of the schema.
 */
function holdsOwnRows(table: TableSchema): boolean {
	return !table.isView && !isMaintainedTable(table) && table.tags?.[ENGINE_MANAGED_TABLE_TAG] !== true;
}

function sameSchemaParents(table: TableSchema): string[] {
	const own = table.schemaName.toLowerCase();
	return (table.foreignKeys ?? [])
		.filter(fk => (fk.referencedSchema ?? table.schemaName).toLowerCase() === own)
		.map(fk => fk.referencedTable.toLowerCase());
}

/** By lowercased name, exact name as tie-break, as `exportSchemaDeclaration` orders tables. */
function sortedByName(tables: TableSchema[]): TableSchema[] {
	const compare = (a: string, b: string) => (a === b ? 0 : a < b ? -1 : 1);
	return tables.sort((a, b) => compare(a.name.toLowerCase(), b.name.toLowerCase()) || compare(a.name, b.name));
}

/**
 * Reads every table inside one transaction and answers the trailer entries. The
 * transaction this opens is ended in `finally`, which also runs when the consumer stops
 * iterating early.
 */
async function* readTables(db: Database, tables: readonly BundleTableEntry[], settings: ExportSettings): AsyncGenerator<string, BundleTrailerTable[]> {
	const ownsTransaction = db.getAutocommit();
	if (ownsTransaction) await db.exec('begin');
	let failed = false;
	try {
		const trailer: BundleTrailerTable[] = [];
		const counters: RunCounters = { totalRowsDone: 0, batchIndex: 0 };
		for (const [tableIndex, table] of tables.entries()) {
			const cancelled = cancellation(settings.hooks.signal, 'data');
			if (cancelled) fail(settings.hooks, cancelled);
			trailer.push(yield* readTable(db, table, { tableIndex, tableCount: tables.length }, settings, counters));
		}
		return trailer;
	} catch (e) {
		failed = true;
		throw e;
	} finally {
		if (ownsTransaction) await endReadTransaction(db, failed);
	}
}

/** Commits a read that finished or was stopped early, or rolls back one that failed without hiding its error. */
async function endReadTransaction(db: Database, failed: boolean): Promise<void> {
	// A failed read leaves the transaction open, but never end one that is not there.
	if (db.getAutocommit()) return;
	if (!failed) {
		await db.exec('commit');
		return;
	}
	try {
		await db.exec('rollback');
	} catch (e) {
		console.error('Bundle export could not roll back its read transaction:', e);
	}
}

/**
 * Streams one table's rows as data documents of `batchSize` rows and answers its trailer
 * entry. A read or encoding failure ends the table: thrown under `'abort'`, otherwise
 * reported, with the rows read before it still written and the entry carrying the error.
 */
async function* readTable(
	db: Database,
	table: BundleTableEntry,
	position: { tableIndex: number; tableCount: number },
	settings: ExportSettings,
	counters: RunCounters,
): AsyncGenerator<string, BundleTrailerTable> {
	let written = 0;
	let pending: YAMLSeq[] = [];
	const reportProgress = (batchIndex?: number) => notifyProgress(settings.hooks, {
		phase: 'data', schema: table.schema, table: table.table, ...position,
		rowsDone: written, totalRowsDone: counters.totalRowsDone, batchIndex,
	});
	const flush = (): string => {
		const text = DOCUMENT_SEPARATOR + documentText(dataNode(table, pending));
		written += pending.length;
		counters.totalRowsDone += pending.length;
		pending = [];
		return text;
	};

	reportProgress();
	let failure: BundleError | undefined;
	let cancelled: BundleError | undefined;
	let statement: Statement | undefined;
	try {
		statement = db.prepare(selectSql(table));
		for await (const row of statement.iterateRows()) {
			pending.push(encodeRow(table, row, written + pending.length));
			if (pending.length < settings.batchSize) continue;
			yield flush();
			reportProgress(counters.batchIndex++);
			cancelled = cancellation(settings.hooks.signal, 'data');
			if (cancelled) break;
		}
	} catch (e) {
		failure = tableFailure(e, table);
	} finally {
		await statement?.finalize();
	}
	if (cancelled) fail(settings.hooks, cancelled);

	if (failure) {
		const stop = notifyError(settings.hooks, failure) === 'abort' || settings.errorPolicy === 'abort';
		if (stop) throw failure;
	}
	if (pending.length > 0) {
		yield flush();
		reportProgress(counters.batchIndex++);
	}
	return { schema: table.schema, table: table.table, rows: written, ...(failure ? { error: failure.message } : {}) };
}

function selectSql(table: BundleTableEntry): string {
	return `select ${table.columns.map(quoteIdentifier).join(', ')} from ${quoteIdentifier(table.schema)}.${quoteIdentifier(table.table)}`;
}

function encodeRow(table: BundleTableEntry, row: Row, rowIndex: number): YAMLSeq {
	const seq = new YAMLSeq();
	seq.flow = true;
	seq.items = row.map((value, i) => {
		try {
			return encodeValue(value);
		} catch (e) {
			throw new BundleError(
				`Cannot export column '${table.columns[i]}' of row ${rowIndex} in ${table.schema}.${table.table}: ${messageOf(e)}`,
				{ phase: 'data', kind: 'value', schema: table.schema, table: table.table, rowIndex, cause: e },
			);
		}
	});
	return seq;
}

function tableFailure(e: unknown, table: BundleTableEntry): BundleError {
	if (e instanceof BundleError) return e;
	return new BundleError(`Reading ${table.schema}.${table.table} failed: ${messageOf(e)}`, {
		phase: 'data', kind: 'batch', schema: table.schema, table: table.table, cause: e,
	});
}

function headerText(schemas: readonly ExportedSchema[], tables: readonly BundleTableEntry[], settings: ExportSettings): string {
	const entries: Array<[string, Node]> = [
		[HEADER_KEY, new Scalar(BUNDLE_FORMAT_VERSION)],
		['created', encodeString(new Date().toISOString())],
	];
	if (settings.schema) {
		entries.push(['schemas', seqNode(schemas.map(s => mapNode([
			['name', encodeString(s.name)],
			['declaration', literalBlock(s.declaration ?? '')],
		])))]);
	}
	if (settings.data) {
		entries.push(['tables', seqNode(tables.map(t => mapNode([
			...tableRefEntries(t),
			['columns', seqNode(t.columns.map(encodeString), true)],
		])))]);
	}
	return documentText(mapNode(entries));
}

function dataNode(table: BundleTableEntry, rows: YAMLSeq[]): YAMLMap {
	return mapNode([
		[DATA_KEY, mapNode(tableRefEntries(table), true)],
		[ROWS_KEY, seqNode(rows)],
	]);
}

function trailerNode(tables: readonly BundleTrailerTable[]): YAMLMap {
	const entries = tables.map(t => mapNode([
		...tableRefEntries(t),
		['rows', new Scalar(t.rows)],
		...(t.error === undefined ? [] : [['error', encodeString(t.error)] as [string, Node]]),
	], true));
	return mapNode([[TRAILER_KEY, mapNode([['tables', seqNode(entries)]])]]);
}

function tableRefEntries(ref: { schema: string; table: string }): Array<[string, Node]> {
	return [['schema', encodeString(ref.schema)], ['table', encodeString(ref.table)]];
}

function literalBlock(text: string): Scalar {
	const node = new Scalar(text);
	node.type = Scalar.BLOCK_LITERAL;
	return node;
}

function mapNode(entries: ReadonlyArray<readonly [string, Node]>, flow = false): YAMLMap {
	const map = new YAMLMap();
	map.flow = flow;
	for (const [key, value] of entries) map.items.push(new Pair(new Scalar(key), value));
	return map;
}

function seqNode(items: Node[], flow = false): YAMLSeq {
	const seq = new YAMLSeq();
	// An empty block sequence is written as `[]` on a line of its own; flow keeps it beside its key.
	seq.flow = flow || items.length === 0;
	seq.items = items;
	return seq;
}

function documentText(contents: Node): string {
	const doc = new Document(null, DOCUMENT_OPTIONS);
	doc.contents = contents;
	return doc.toString(STRINGIFY_OPTIONS);
}

/** Reports `error` to `onError` and throws it. */
function fail(hooks: BundleHooks, error: BundleError): never {
	notifyError(hooks, error);
	throw error;
}

function messageOf(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
