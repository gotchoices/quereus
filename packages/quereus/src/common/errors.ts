import { StatusCode } from './types.js';

/**
 * Base class for Quereus specific errors
 * Provides location information and status code support
 */
export class QuereusError extends Error {
	public code: number;
	public line?: number;
	public column?: number;

	constructor(message: string, code: number = StatusCode.ERROR, cause?: Error, line?: number, column?: number) {
		super(message, { cause });
		this.code = code;
		this.name = 'QuereusError';
		this.line = line;
		this.column = column;

		// Enhance message with location if available
		if (line !== undefined && column !== undefined) {
			this.message = `${message} (at line ${line}, column ${column})`;
		}

		// Maintain stack trace in V8
		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, QuereusError);
		}
	}
}

/**
 * Error thrown when a database constraint is violated
 */
export class ConstraintError extends QuereusError {
	constructor(message: string, code: number = StatusCode.CONSTRAINT, cause?: Error) {
		super(message, code, cause);
		this.name = 'ConstraintError';
		Object.setPrototypeOf(this, ConstraintError.prototype);
	}
}

/**
 * Constraint violation that resolved to OR FAIL.
 *
 * Per SQLite OR FAIL semantics: rows successfully processed before the
 * violation must remain inserted/updated even though the statement aborts.
 * The iterator-level cleanup recognizes this subclass and commits prior
 * rows (in autocommit mode) instead of rolling back.
 */
export class FailConflictError extends ConstraintError {
	constructor(message: string, code: number = StatusCode.CONSTRAINT, cause?: Error) {
		super(message, code, cause);
		this.name = 'FailConflictError';
		Object.setPrototypeOf(this, FailConflictError.prototype);
	}
}

/**
 * Constraint violation that resolved to OR ROLLBACK.
 *
 * Per SQLite OR ROLLBACK semantics: the violation aborts the entire
 * enclosing transaction (explicit or implicit). The iterator-level cleanup
 * recognizes this subclass and unconditionally rolls back the transaction.
 */
export class RollbackConflictError extends ConstraintError {
	constructor(message: string, code: number = StatusCode.CONSTRAINT, cause?: Error) {
		super(message, code, cause);
		this.name = 'RollbackConflictError';
		Object.setPrototypeOf(this, RollbackConflictError.prototype);
	}
}

/**
 * Error thrown when the API is used incorrectly
 */
export class MisuseError extends QuereusError {
	constructor(message: string = 'API misuse', cause?: Error) {
		super(message, StatusCode.MISUSE, cause);
		this.name = 'MisuseError';
		Object.setPrototypeOf(this, MisuseError.prototype);
	}
}

/**
 * Helper function to throw a QuereusError with optional location information from AST nodes
 * @param message Error message
 * @param code Status code (defaults to ERROR)
 * @param cause Optional underlying error
 * @param astNode Optional AST node or object with location information
 * @returns Never (always throws)
 */
export function quereusError(
	message: string,
	code: StatusCode = StatusCode.ERROR,
	cause?: Error,
	astNode?: { loc?: { start: { line: number; column: number }, end?: { line: number; column: number } } }
): never {
	throw new QuereusError(
		message,
		code,
		cause,
		astNode?.loc?.start.line,
		astNode?.loc?.start.column
	);
}

/**
 * Information about an error in the error chain
 */
export interface ErrorInfo {
	message: string;
	code?: number;
	line?: number;
	column?: number;
	name: string;
	stack?: string;
}

/**
 * Recursively unwraps a QuereusError (or any Error) and its causes
 * @param error The error to unwrap
 * @returns Array of ErrorInfo objects, with the root error first
 */
export function unwrapError(error: Error): ErrorInfo[] {
	const errorChain: ErrorInfo[] = [];
	let currentError: Error | undefined = error;

	while (currentError) {
		const errorInfo: ErrorInfo = {
			message: currentError.message,
			name: currentError.name,
			stack: currentError.stack,
		};

		// Add QuereusError-specific fields if available
		if (currentError instanceof QuereusError) {
			errorInfo.code = currentError.code;
			errorInfo.line = currentError.line;
			errorInfo.column = currentError.column;
		}

		errorChain.push(errorInfo);

		// Move to the next error in the chain
		currentError = (currentError as Error & { cause?: Error }).cause;
	}

	return errorChain;
}

/**
 * Formats an error chain for display
 * @param errorChain Array of ErrorInfo objects
 * @param includeStack Whether to include stack traces
 * @returns Formatted error message
 */
export function formatErrorChain(errorChain: ErrorInfo[], includeStack: boolean = false): string {
	if (errorChain.length === 0) {
		return 'Unknown error';
	}

	const lines: string[] = [];

	errorChain.forEach((errorInfo, index) => {
		const prefix = index === 0 ? 'Error' : `Caused by`;
		let line = `${prefix}: ${errorInfo.message}`;

		if (errorInfo.line !== undefined && errorInfo.column !== undefined) {
			line += ` (at line ${errorInfo.line}, column ${errorInfo.column})`;
		}

		lines.push(line);

		if (includeStack && errorInfo.stack) {
			lines.push(errorInfo.stack);
		}
	});

	return lines.join('\n');
}

/**
 * Gets the primary error info (the first error in the chain)
 * @param error The error to analyze
 * @returns ErrorInfo for the primary error
 */
export function getPrimaryError(error: Error): ErrorInfo {
	const chain = unwrapError(error);
	return chain[0] || {
		message: 'Unknown error',
		name: 'Error',
	};
}
