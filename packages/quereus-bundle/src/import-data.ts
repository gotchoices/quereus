import { isNode, isSeq } from 'yaml';
import {
	ANY_TYPE,
	isMaintainedTable,
	quoteIdentifier,
	type Database,
	type ScalarType,
	type SqlValue,
	type Statement,
	type TableSchema,
} from '@quereus/quereus';
import {
	damagedDataRef,
	damagedRowCount,
	documentError,
	parseDataDocument,
	parseTrailer,
	tableKey,
	type DataDocument,
} from './bundle-documents.js';
import type { BundleTableEntry, BundleTableRef } from './format.js';
import { BundleError, notifyProgress } from './hooks.js';
import { messageOf, type ImportRun, type ImportSettings, type ImportTableReport } from './import-run.js';
import type { BundleDocument } from './read-documents.js';
import { decodeValue } from './value-codec.js';

/** One manifest table being loaded. */
interface TableLoad {
	entry: BundleTableEntry;
	report: ImportTableReport;
	/** Position in the header's `tables` manifest. */
	position: number;
	statement?: Statement;
	/** Set once the table has been found unfit to load; its documents are skipped. */
	rejected?: boolean;
}

/** What went wrong in a transaction, and at which row when a row's statement failed. */
interface TransactionFailure {
	error: unknown;
	rowIndex?: number;
	/** Set when the rollback after the failure failed too: the transaction state is then unknown. */
	rollbackError?: unknown;
}

/**
 * Loads data documents, one transaction per document, into the tables the header's
 * manifest lists, and checks the trailer's row counts against what it read. Holds one
 * prepared insert per table until {@link close}.
 */
export class DataLoader {
	private readonly loads = new Map<string, TableLoad>();
	private readonly filtered = new Set<string>();
	private readonly unlisted = new Set<string>();
	private batchIndex = 0;

	constructor(private readonly run: ImportRun, private readonly manifest: readonly BundleTableEntry[]) {
		for (const [position, entry] of manifest.entries()) {
			if (!run.settings.includes(entry.schema, entry.table)) {
				this.filtered.add(tableKey(entry));
				continue;
			}
			const report: ImportTableReport = { schema: entry.schema, table: entry.table, rowsRead: 0, rowsApplied: 0, rowsFailed: 0, batchesFailed: 0 };
			run.tables.push(report);
			this.loads.set(tableKey(entry), { entry, report, position });
		}
	}

	/** Tables that received at least one committed row. */
	tablesWithRows(): ReadonlySet<string> {
		return new Set([...this.loads].filter(([, load]) => load.report.rowsApplied > 0).map(([key]) => key));
	}

	/** Loads one data document under the error policy. */
	async load(item: BundleDocument): Promise<void> {
		let data: DataDocument;
		try {
			data = parseDataDocument(item);
		} catch (e) {
			this.damaged(item, e as BundleError);
			return;
		}
		const load = this.loadFor(data.ref, item);
		if (!load) return;
		load.report.rowsRead += data.rows.length;
		this.run.totalRowsRead += data.rows.length;
		const statement = this.statementFor(load);
		if (statement) {
			await this.applyDocument(load, statement, data.rows, item);
		} else {
			load.report.rowsFailed += data.rows.length;
		}
		this.reportProgress(load);
	}

	/**
	 * A document that cannot be loaded at all: invalid YAML, or not shaped like a data
	 * document. It costs its batch; under `errorPolicy: 'abort'` it ends the run.
	 */
	damaged(item: BundleDocument, error: BundleError): void {
		const ref = damagedDataRef(item);
		if (ref && this.filtered.has(tableKey(ref))) return;
		const load = ref ? this.loads.get(tableKey(ref)) : undefined;
		if (load) {
			const rows = damagedRowCount(item) ?? 0;
			load.report.rowsRead += rows;
			load.report.rowsFailed += rows;
			load.report.batchesFailed++;
			this.run.totalRowsRead += rows;
		}
		this.reportFailure(error);
	}

	/** Checks the trailer's per-table row counts against the rows read, and reports what the export left out. */
	checkTrailer(item: BundleDocument): void {
		let entries;
		try {
			entries = parseTrailer(item);
		} catch (e) {
			this.run.report(e as BundleError);
			return;
		}
		const seen = new Set<string>();
		for (const entry of entries) {
			const key = tableKey(entry);
			if (this.filtered.has(key)) continue;
			const load = this.loads.get(key);
			if (!load) {
				this.run.report(documentError(item, `The trailer counts ${entry.schema}.${entry.table}, which the header's tables manifest does not list`, 'format', entry));
				continue;
			}
			seen.add(key);
			load.report.expectedRows = entry.rows;
			if (entry.error !== undefined) {
				this.run.report(documentError(item, `The bundle holds only part of ${entry.schema}.${entry.table}: the export stopped after ${entry.rows} rows: ${entry.error}`, 'truncated', entry));
			}
			if (entry.rows !== load.report.rowsRead) {
				this.run.report(documentError(item, `The trailer counts ${entry.rows} rows for ${entry.schema}.${entry.table}, but the bundle carried ${load.report.rowsRead}`, 'count-mismatch', entry));
			}
		}
		for (const [key, load] of this.loads) {
			if (!seen.has(key)) {
				this.run.report(documentError(item, `The trailer has no entry for ${load.entry.schema}.${load.entry.table}`, 'format', load.entry));
			}
		}
	}

	async close(): Promise<void> {
		for (const load of this.loads.values()) {
			try {
				await load.statement?.finalize();
			} catch (e) {
				console.error(`Bundle import could not finalize its insert into ${load.entry.schema}.${load.entry.table}:`, e);
			}
		}
	}

	/** The manifest table `ref` names; reports a table the manifest does not list, once. */
	private loadFor(ref: BundleTableRef, item: BundleDocument): TableLoad | undefined {
		const key = tableKey(ref);
		const load = this.loads.get(key);
		if (load || this.filtered.has(key)) return load;
		if (!this.unlisted.has(key)) {
			this.unlisted.add(key);
			this.run.report(documentError(item, `A data document names ${ref.schema}.${ref.table}, which the header's tables manifest does not list; its documents are skipped`, 'format', ref));
		}
		return undefined;
	}

	/** The table's insert, prepared on first use; undefined, after reporting why once, when the table cannot be loaded. */
	private statementFor(load: TableLoad): Statement | undefined {
		if (load.statement || load.rejected) return load.statement;
		const { entry } = load;
		const target = this.run.db.schemaManager.findTable(entry.table, entry.schema);
		if (!target) return this.reject(load, 'the table does not exist');
		const problem = targetProblem(entry, target);
		if (problem) return this.reject(load, problem);
		try {
			// NOTE: `prepare` compiles on first run, so an insert that cannot compile fails each
			// document (each row under `skip-row`) instead of rejecting the table once. The
			// checks above leave no known compile failure; if one turns up, compile here.
			load.statement = this.run.db.prepare(insertSql(entry, target, this.run.settings.onConflict), anyTypedParameters(entry.columns.length));
		} catch (e) {
			return this.reject(load, messageOf(e), e);
		}
		return load.statement;
	}

	private reject(load: TableLoad, reason: string, cause?: unknown): undefined {
		const { schema, table } = load.entry;
		load.rejected = true;
		this.run.report(new BundleError(`Cannot load ${schema}.${table}: ${reason}; its documents are skipped`, {
			phase: 'data', kind: 'schema', schema, table, cause,
		}));
		return undefined;
	}

	/** Applies a document's rows in one transaction; on failure, the error policy decides what is kept. */
	private async applyDocument(load: TableLoad, statement: Statement, rows: readonly unknown[], item: BundleDocument): Promise<void> {
		const failure = await inTransaction(this.run.db, async mark => {
			for (const [rowIndex, node] of rows.entries()) {
				mark(rowIndex);
				await statement.run(decodeRow(load.entry, node, rowIndex, item));
			}
		});
		if (!failure) {
			this.applied(load, rows.length);
			return;
		}
		if (failure.rollbackError === undefined && this.run.settings.errorPolicy === 'skip-row') {
			await this.applyRowByRow(load, statement, rows, item);
			return;
		}
		load.report.batchesFailed++;
		load.report.rowsFailed += rows.length;
		this.reportFailure(batchError(load.entry, item, failure), failure.rollbackError !== undefined);
	}

	/**
	 * `skip-row`: each row in its own transaction, so only the failing rows are lost. Rows
	 * commit one by one, so `onError` answering `'abort'` stops before the next row.
	 */
	private async applyRowByRow(load: TableLoad, statement: Statement, rows: readonly unknown[], item: BundleDocument): Promise<void> {
		for (const [rowIndex, node] of rows.entries()) {
			if (this.run.stopped) return;
			let values: SqlValue[];
			try {
				values = decodeRow(load.entry, node, rowIndex, item);
			} catch (e) {
				load.report.rowsFailed++;
				this.run.report(e as BundleError);
				continue;
			}
			const failure = await inTransaction(this.run.db, () => statement.run(values));
			if (!failure) {
				this.applied(load, 1);
				continue;
			}
			load.report.rowsFailed++;
			if (failure.rollbackError !== undefined) {
				this.run.fail(batchError(load.entry, item, { ...failure, rowIndex }));
				return;
			}
			this.run.report(rowError(load.entry, item, rowIndex, node, `could not be applied: ${messageOf(failure.error)}`, failure.error));
		}
	}

	private applied(load: TableLoad, rows: number): void {
		load.report.rowsApplied += rows;
		this.run.totalRowsApplied += rows;
	}

	/** A failed batch stops the run under `'abort'`, and always when `fatal` (a rollback failed). */
	private reportFailure(error: BundleError, fatal = false): void {
		if (fatal || this.run.settings.errorPolicy === 'abort') this.run.fail(error);
		else this.run.report(error);
	}

	private reportProgress(load: TableLoad): void {
		notifyProgress(this.run.settings.hooks, {
			phase: 'data', schema: load.entry.schema, table: load.entry.table,
			tableIndex: load.position, tableCount: this.manifest.length,
			rowsDone: load.report.rowsRead, totalRowsDone: this.run.totalRowsRead, batchIndex: this.batchIndex++,
		});
	}
}

/**
 * Runs `work` between `begin` and `commit`, rolling back on failure. `work` marks the row it
 * is on, so a failure can name it; a failure at `commit` (a deferred constraint) names none.
 */
async function inTransaction(db: Database, work: (mark: (rowIndex: number) => void) => Promise<void>): Promise<TransactionFailure | undefined> {
	let rowIndex: number | undefined;
	try {
		await db.exec('begin');
		await work(i => { rowIndex = i; });
		rowIndex = undefined;
		await db.exec('commit');
		return undefined;
	} catch (error) {
		if (db.getAutocommit()) return { error, rowIndex };
		try {
			await db.exec('rollback');
			return { error, rowIndex };
		} catch (rollbackError) {
			return { error, rowIndex, rollbackError };
		}
	}
}

/**
 * Why `target` cannot take the manifest's rows, or undefined when it can: it must hold its
 * own rows and have every manifest column, none of them generated.
 */
function targetProblem(entry: BundleTableEntry, target: TableSchema): string | undefined {
	if (isMaintainedTable(target)) return 'it is a maintained table, whose rows are derived';
	if (entry.columns.length === 0) return 'the bundle lists no columns for it';
	const columns = new Map(target.columns.map(c => [c.name.toLowerCase(), c]));
	for (const name of entry.columns) {
		const column = columns.get(name.toLowerCase());
		if (!column) return `it has no column '${name}'`;
		if (column.generated) return `its column '${name}' is generated`;
	}
	return undefined;
}

/**
 * The insert for one manifest table. `'skip'` leaves an existing row alone; `'update'`
 * overwrites its non-key manifest columns in place. Not `insert or replace`, which
 * deletes and re-inserts and so fires `on delete` cascades.
 */
function insertSql(entry: BundleTableEntry, target: TableSchema, onConflict: ImportSettings['onConflict']): string {
	const table = `${quoteIdentifier(entry.schema)}.${quoteIdentifier(entry.table)}`;
	const columns = entry.columns.map(quoteIdentifier).join(', ');
	const placeholders = entry.columns.map(() => '?').join(', ');
	return `insert into ${table} (${columns}) values (${placeholders})${conflictClause(entry, target, onConflict)}`;
}

/**
 * Every placeholder declared `ANY`. Left undeclared, a statement pins each parameter's type
 * to the first value bound to it, so a column holding `-0` (an integer-looking number) in
 * its first row would refuse `0.1` later. Declared `ANY`, each value is bound as it is and
 * the column converts it, as it would a literal.
 */
function anyTypedParameters(count: number): Map<number, ScalarType> {
	const type: ScalarType = { typeClass: 'scalar', logicalType: ANY_TYPE, nullable: true };
	return new Map(Array.from({ length: count }, (_, i) => [i + 1, type]));
}

function conflictClause(entry: BundleTableEntry, target: TableSchema, onConflict: ImportSettings['onConflict']): string {
	if (onConflict === 'abort') return '';
	const keys = target.primaryKeyDefinition.map(k => target.columns[k.index].name);
	const keySet = new Set(keys.map(k => k.toLowerCase()));
	const updated = entry.columns.filter(c => !keySet.has(c.toLowerCase()));
	// A table whose manifest columns are all key columns has nothing to update.
	if (onConflict === 'skip' || keys.length === 0 || updated.length === 0) return ' on conflict do nothing';
	const assignments = updated.map(c => `${quoteIdentifier(c)} = excluded.${quoteIdentifier(c)}`).join(', ');
	return ` on conflict (${keys.map(quoteIdentifier).join(', ')}) do update set ${assignments}`;
}

/** @throws BundleError (kind `row`) for a row of the wrong arity or holding a value no bundle carries. */
function decodeRow(entry: BundleTableEntry, node: unknown, rowIndex: number, item: BundleDocument): SqlValue[] {
	if (!isSeq(node)) throw rowError(entry, item, rowIndex, node, 'is not a sequence');
	if (node.items.length !== entry.columns.length) {
		throw rowError(entry, item, rowIndex, node, `has ${node.items.length} values, but the table's bundle columns are ${entry.columns.length}`);
	}
	return node.items.map((cell, i) => {
		try {
			return decodeValue(cell);
		} catch (e) {
			throw rowError(entry, item, rowIndex, cell, `column '${entry.columns[i]}': ${messageOf(e)}`, e);
		}
	});
}

function rowError(entry: BundleTableEntry, item: BundleDocument, rowIndex: number, node: unknown, problem: string, cause?: unknown): BundleError {
	const position = isNode(node) && node.range ? item.locate(node.range[0]) : undefined;
	return new BundleError(`Row ${rowIndex} of data document ${item.index} (${entry.schema}.${entry.table}) ${problem}`, {
		phase: 'data', kind: 'row', schema: entry.schema, table: entry.table,
		documentIndex: item.index, rowIndex, line: position?.line, column: position?.column, cause,
	});
}

function batchError(entry: BundleTableEntry, item: BundleDocument, failure: TransactionFailure): BundleError {
	const where = failure.rowIndex === undefined ? '' : ` at row ${failure.rowIndex}`;
	const message = failure.rollbackError === undefined
		? `Data document ${item.index} (${entry.schema}.${entry.table}) was not applied${where}: ${messageOf(failure.error)}`
		: `Rolling back data document ${item.index} (${entry.schema}.${entry.table}) failed after it failed${where}, so the import stopped: ${messageOf(failure.rollbackError)}`;
	const position = item.locate(item.document.range[0]);
	return new BundleError(message, {
		phase: 'data', kind: 'batch', schema: entry.schema, table: entry.table,
		documentIndex: item.index, rowIndex: failure.rowIndex, line: position.line, column: position.column, cause: failure.error,
	});
}
