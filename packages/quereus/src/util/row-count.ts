import { QuereusError } from '../common/errors.js';
import { StatusCode, type SqlValue } from '../common/types.js';

export type RowCountClause = 'LIMIT' | 'OFFSET';

/**
 * Resolve a LIMIT / OFFSET value to a row count, or throw.
 *
 * The one definition of what a row count is, shared by every operator that applies a
 * LIMIT / OFFSET at runtime and by the prepare-time check on constant expressions, so
 * they cannot disagree. NULL, negative and non-numeric values are errors; "no limit"
 * is spelled by omitting the clause (see docs/sql-select.md §3.6). Fractional values
 * truncate toward zero. `at` is the clause's source position, when the caller knows it.
 */
export function toRowCount(value: SqlValue, clause: RowCountClause, at?: SourcePosition): number {
	if (value === null) {
		throw rowCountError(`${clause} must not be NULL; omit the clause instead`, at);
	}
	const n = Number(value);
	if (!Number.isFinite(n)) {
		throw rowCountError(`${clause} must be a finite number, got ${describeValue(value)}`, at);
	}
	if (n < 0) {
		throw rowCountError(`${clause} must not be negative, got ${n}`, at);
	}
	return Math.trunc(n);
}

/** A 1-based source line and column, as the parser stamps them. */
export interface SourcePosition {
	line: number;
	column: number;
}

export function rowCountError(message: string, at: SourcePosition | undefined): QuereusError {
	return new QuereusError(message, StatusCode.MISMATCH, undefined, at?.line, at?.column);
}

function describeValue(value: SqlValue): string {
	if (typeof value === 'string') return `'${value}'`;
	if (value instanceof Uint8Array) return 'a blob';
	if (typeof value === 'object') return JSON.stringify(value);
	return String(value);
}
