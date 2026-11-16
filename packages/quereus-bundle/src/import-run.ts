import { MisuseError, type Database } from '@quereus/quereus';
import { BundleError, cancellation, notifyError, type BundleHooks, type BundlePhase } from './hooks.js';

export interface ImportOptions extends BundleHooks {
	/**
	 * What to do with the header's schema declarations. `'apply'` (default) migrates the
	 * database to them; `'verify'` fails when the database differs from them; `'skip'`
	 * ignores them.
	 */
	schema?: 'apply' | 'verify' | 'skip';
	/** Let `'apply'` run a plan that drops objects, columns or constraints, or changes a column's type. Default false. */
	allowDestructive?: boolean;
	/** Passed to `apply schema … options (rename_policy = …)`. Default: the engine's (`'allow'`). */
	renamePolicy?: 'allow' | 'require-hint' | 'deny';
	/** Asked before a non-empty plan is applied; answering false stops the import. */
	confirmSchemaPlan?(plan: SchemaPlan): boolean | Promise<boolean>;
	/** Which tables' rows to load. Default: all. */
	tables?: (schema: string, table: string) => boolean;
	/** What a row whose key already exists does. `'abort'` (default) fails it, `'skip'` leaves the stored row, `'update'` overwrites its non-key columns. */
	onConflict?: 'abort' | 'skip' | 'update';
	/** What a failed batch does. `'abort'` (default) stops, `'skip-batch'` drops that batch, `'skip-row'` retries its rows one by one and drops only the failing ones. */
	errorPolicy?: 'abort' | 'skip-batch' | 'skip-row';
}

/** The migration one schema's declaration needs, as `diff schema` reports it. */
export interface SchemaPlan {
	schema: string;
	ddl: string[];
	/** The statements of `ddl` that lose data or break dependents. */
	destructive: string[];
}

export interface ImportTableReport {
	schema: string;
	table: string;
	/** Rows the table's data documents carry. */
	rowsRead: number;
	/** Rows committed, including rows `onConflict: 'skip'` left as they were. */
	rowsApplied: number;
	/** Rows not applied because of an error. */
	rowsFailed: number;
	/** Data documents that failed as a whole. */
	batchesFailed: number;
	/** The row count the trailer states, once the trailer has been read. */
	expectedRows?: number;
}

export interface ImportReport {
	/** True when no error was recorded and the run was not cancelled. */
	ok: boolean;
	cancelled: boolean;
	schemas: Array<{ schema: string; ddlApplied: string[] }>;
	tables: ImportTableReport[];
	errors: BundleError[];
}

export interface ImportSettings {
	schemaMode: NonNullable<ImportOptions['schema']>;
	allowDestructive: boolean;
	renamePolicy?: ImportOptions['renamePolicy'];
	confirmSchemaPlan?: ImportOptions['confirmSchemaPlan'];
	includes: (schema: string, table: string) => boolean;
	onConflict: NonNullable<ImportOptions['onConflict']>;
	errorPolicy: NonNullable<ImportOptions['errorPolicy']>;
	hooks: BundleHooks;
}

const SCHEMA_MODES = ['apply', 'verify', 'skip'] as const;
const RENAME_POLICIES = ['allow', 'require-hint', 'deny'] as const;
const CONFLICT_MODES = ['abort', 'skip', 'update'] as const;
const ERROR_POLICIES = ['abort', 'skip-batch', 'skip-row'] as const;

/** @throws MisuseError for an option outside its allowed values. */
export function resolveImportSettings(options: ImportOptions): ImportSettings {
	return {
		schemaMode: oneOf('schema', options.schema ?? 'apply', SCHEMA_MODES),
		allowDestructive: options.allowDestructive ?? false,
		renamePolicy: options.renamePolicy === undefined ? undefined : oneOf('renamePolicy', options.renamePolicy, RENAME_POLICIES),
		confirmSchemaPlan: options.confirmSchemaPlan,
		includes: options.tables ?? (() => true),
		onConflict: oneOf('onConflict', options.onConflict ?? 'abort', CONFLICT_MODES),
		errorPolicy: oneOf('errorPolicy', options.errorPolicy ?? 'abort', ERROR_POLICIES),
		hooks: { onProgress: options.onProgress, onError: options.onError, signal: options.signal },
	};
}

function oneOf<T extends string>(name: string, value: unknown, allowed: readonly T[]): T {
	if (allowed.includes(value as T)) return value as T;
	throw new MisuseError(`${name} must be one of ${allowed.join(', ')}, got ${String(value)}`);
}

/** One import's settings, the report it builds, and whether it has been told to stop. */
export class ImportRun {
	readonly errors: BundleError[] = [];
	readonly schemas: ImportReport['schemas'] = [];
	readonly tables: ImportTableReport[] = [];
	cancelled = false;
	/** Set when `onError` answered `'abort'`. */
	abortRequested = false;
	/** Set by an error that ends the run, by `onError` answering `'abort'`, or by cancelling. No further document is read. */
	stopped = false;
	/** Rows committed across every table. */
	totalRowsApplied = 0;
	/** Rows read across every table. */
	totalRowsRead = 0;

	constructor(readonly db: Database, readonly settings: ImportSettings) {}

	/** Records `error` and delivers it to `onError`; the run stops if the hook answers `'abort'`. */
	report(error: BundleError): void {
		this.errors.push(error);
		if (notifyError(this.settings.hooks, error) === 'abort') {
			this.abortRequested = true;
			this.stopped = true;
		}
	}

	/** Records `error` and stops the run. */
	fail(error: BundleError): void {
		this.report(error);
		this.stopped = true;
	}

	/** Whether the signal has been aborted; the first time it has, records a `cancelled` error and stops the run. */
	isCancelled(phase: BundlePhase): boolean {
		if (this.cancelled) return true;
		const error = cancellation(this.settings.hooks.signal, phase);
		if (!error) return false;
		this.cancelled = true;
		this.fail(error);
		return true;
	}

	result(): ImportReport {
		return {
			ok: this.errors.length === 0 && !this.cancelled,
			cancelled: this.cancelled,
			schemas: this.schemas,
			tables: this.tables,
			errors: this.errors,
		};
	}
}

export function messageOf(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
