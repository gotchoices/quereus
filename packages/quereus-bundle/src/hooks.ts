/** The stage of an export or import that a progress report or error belongs to. */
export type BundlePhase = 'read' | 'schema' | 'data' | 'verify';

/** What kind of problem a {@link BundleError} reports. */
export type BundleErrorKind =
	| 'format'
	| 'version'
	| 'value'
	| 'schema'
	| 'destructive'
	| 'row'
	| 'batch'
	| 'foreign-key'
	| 'count-mismatch'
	| 'truncated'
	| 'cancelled';

export interface BundleProgress {
	phase: BundlePhase;
	schema?: string;
	table?: string;
	/** Position of `table` in the run's table list, from 0. */
	tableIndex?: number;
	tableCount?: number;
	/** Rows done within the current table. */
	rowsDone: number;
	/** Rows done across the whole run. */
	totalRowsDone: number;
	/** Position of the data document just written or read among the run's data documents, from 0. */
	batchIndex?: number;
}

/** Where a {@link BundleError} happened, and what caused it. */
export interface BundleErrorDetails {
	phase: BundlePhase;
	kind: BundleErrorKind;
	schema?: string;
	table?: string;
	/** Position of the YAML document in the bundle, the header being 0. */
	documentIndex?: number;
	/** Position of the row within its table (export) or its data document (import), from 0. */
	rowIndex?: number;
	/** 1-based line in the bundle text. */
	line?: number;
	/** 1-based column in the bundle text (a text position, not a table column). */
	column?: number;
	cause?: unknown;
}

/** A problem with a bundle's content, or with writing or applying it. */
export class BundleError extends Error {
	readonly phase: BundlePhase;
	readonly kind: BundleErrorKind;
	readonly schema?: string;
	readonly table?: string;
	readonly documentIndex?: number;
	readonly rowIndex?: number;
	readonly line?: number;
	readonly column?: number;

	constructor(message: string, details: BundleErrorDetails) {
		super(message, details.cause === undefined ? undefined : { cause: details.cause });
		this.name = 'BundleError';
		this.phase = details.phase;
		this.kind = details.kind;
		this.schema = details.schema;
		this.table = details.table;
		this.documentIndex = details.documentIndex;
		this.rowIndex = details.rowIndex;
		this.line = details.line;
		this.column = details.column;
	}
}

/**
 * Observers for an export or import. A hook that throws is logged and the run carries on.
 * To stop a run, abort `signal` or return `'abort'` from `onError`.
 */
export interface BundleHooks {
	onProgress?(progress: BundleProgress): void;
	/** Called for every error as it happens. Returning `'abort'` stops the run whatever the error policy. */
	onError?(error: BundleError): void | 'abort';
	/** Checked between batches. */
	signal?: AbortSignal;
}

export function notifyProgress(hooks: BundleHooks, progress: BundleProgress): void {
	try {
		hooks.onProgress?.(progress);
	} catch (e) {
		console.error('Bundle onProgress hook threw:', e);
	}
}

/** Delivers `error` to `onError`, and answers whether the hook asked to stop the run. */
export function notifyError(hooks: BundleHooks, error: BundleError): 'abort' | undefined {
	try {
		return hooks.onError?.(error) === 'abort' ? 'abort' : undefined;
	} catch (e) {
		console.error('Bundle onError hook threw:', e);
		return undefined;
	}
}

/** A `cancelled` error when `signal` has been aborted, carrying the abort reason as its cause. */
export function cancellation(signal: AbortSignal | undefined, phase: BundlePhase): BundleError | undefined {
	if (!signal?.aborted) return undefined;
	return new BundleError('The run was cancelled', { phase, kind: 'cancelled', cause: signal.reason });
}
