import { MisuseError, type Database } from '@quereus/quereus';
import { documentError, documentKind, parseHeader } from './bundle-documents.js';
import type { BundleHeader } from './format.js';
import { BundleError } from './hooks.js';
import { DataLoader } from './import-data.js';
import { ImportRun, messageOf, resolveImportSettings, type ImportOptions, type ImportReport } from './import-run.js';
import { importSchemas } from './import-schema.js';
import { verifyForeignKeys } from './import-verify.js';
import { readDocuments, type BundleDocument, type BundleSource } from './read-documents.js';

/**
 * Loads a bundle (`docs/bundle.md`) into `db`: applies (or verifies) the header's schema
 * declarations, loads each data document in its own transaction with `foreign_keys` off,
 * checks the trailer's row counts, and then checks the foreign keys of every table that
 * received rows. Not all-or-nothing across the file: a document that commits stays
 * committed whatever happens after it.
 *
 * `source` is the whole text or its chunks in order. A Node `fs.createReadStream(path, 'utf8')`
 * and a browser `ReadableStream` piped through `TextDecoderStream` are both `AsyncIterable<string>`.
 *
 * Problems with the bundle or with applying it never throw: each is a {@link BundleError}
 * delivered to `onError` as it happens and listed in the report.
 *
 * @throws MisuseError for invalid options, when `db` is inside a transaction (the import
 *   manages its own), or when `source` yields something other than strings.
 */
export async function importBundle(db: Database, source: BundleSource, options: ImportOptions = {}): Promise<ImportReport> {
	const settings = resolveImportSettings(options);
	if (!db.getAutocommit()) {
		throw new MisuseError('importBundle runs its own transactions; call it when the database is not inside one');
	}
	const run = new ImportRun(db, settings);
	const documents = readDocuments(source);
	try {
		await runImport(run, new DocumentStream(run, documents));
	} finally {
		await closeSource(documents);
	}
	return run.result();
}

async function runImport(run: ImportRun, documents: DocumentStream): Promise<void> {
	const header = await readHeader(run, documents);
	if (!header) return;
	await importSchemas(run, header);
	if (run.stopped) return;
	await importData(run, header, documents);
}

async function readHeader(run: ImportRun, documents: DocumentStream): Promise<BundleHeader | undefined> {
	const item = await documents.next();
	if (!item) {
		if (!documents.failed) run.fail(new BundleError('The input is empty: a bundle starts with a header', { phase: 'read', kind: 'format' }));
		return undefined;
	}
	try {
		return parseHeader(item);
	} catch (e) {
		run.fail(e as BundleError);
		return undefined;
	}
}

/**
 * Loads the data documents with `foreign_keys` off, then restores it and, when it was on,
 * verifies the foreign keys the load could have broken. Batches commit independently and
 * the engine judges a child's foreign key at commit, so with it on a child row whose
 * parent sits in a later batch would fail although the bundle is consistent.
 */
async function importData(run: ImportRun, header: BundleHeader, documents: DocumentStream): Promise<void> {
	const options = run.db.options;
	const foreignKeys = options.getBooleanOption('foreign_keys');
	const loader = new DataLoader(run, header.tables ?? []);
	options.setOption('foreign_keys', false);
	try {
		await loadDocuments(run, loader, documents);
	} finally {
		await loader.close();
		options.setOption('foreign_keys', foreignKeys);
	}
	const loaded = loader.tablesWithRows();
	if (foreignKeys && loaded.size > 0 && !run.cancelled && !run.abortRequested) {
		await verifyForeignKeys(run, loaded);
	}
}

/** Data documents until the trailer, which must be the last document. */
async function loadDocuments(run: ImportRun, loader: DataLoader, documents: DocumentStream): Promise<void> {
	while (!run.stopped && !run.isCancelled('data')) {
		const item = await documents.next();
		if (!item) {
			if (!documents.failed) run.report(new BundleError('The bundle has no trailer: it is truncated', { phase: 'read', kind: 'truncated' }));
			return;
		}
		switch (documentKind(item)) {
			case 'data':
				await loader.load(item);
				break;
			case 'trailer':
				loader.checkTrailer(item);
				await expectEnd(run, documents);
				return;
			default:
				loader.damaged(item, item.error
					? documentError(item, `Document ${item.index} is not valid YAML: ${item.error.message}`)
					: documentError(item, `Document ${item.index} is neither a data document nor the trailer`));
		}
	}
}

async function expectEnd(run: ImportRun, documents: DocumentStream): Promise<void> {
	const extra = await documents.next();
	if (extra) run.report(documentError(extra, `Document ${extra.index} follows the trailer`));
}

/** The reader's documents, with a failure of the source itself reported once as a `truncated` error. */
class DocumentStream {
	/** Set once reading the source failed; the run has then stopped. */
	failed = false;

	constructor(private readonly run: ImportRun, private readonly documents: AsyncGenerator<BundleDocument>) {}

	async next(): Promise<BundleDocument | undefined> {
		if (this.failed) return undefined;
		try {
			const result = await this.documents.next();
			return result.done ? undefined : result.value;
		} catch (e) {
			if (e instanceof MisuseError) throw e;
			this.failed = true;
			this.run.fail(new BundleError(`Reading the bundle failed: ${messageOf(e)}`, { phase: 'read', kind: 'truncated', cause: e }));
			return undefined;
		}
	}
}

/** Stops reading the source, so a file stream is closed even when the import ended early. */
async function closeSource(documents: AsyncGenerator<BundleDocument>): Promise<void> {
	try {
		await documents.return(undefined);
	} catch (e) {
		console.error('Bundle import could not close its source:', e);
	}
}
