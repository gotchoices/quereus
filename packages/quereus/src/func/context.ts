import { createLogger } from '../common/logger.js';
import { type SqlValue, StatusCode } from '../common/types.js';
import { QuereusError } from '../common/errors.js';
import type { Database } from '../core/database.js';

/**
 * Represents the execution context passed to user-defined SQL functions
 * (scalar, aggregate, window) and to virtual table methods.
 * Provides methods for setting results and accessing auxiliary data.
 *
 * Methods that set a result should be the last action in a function
 * implementation. Setting multiple results or setting a result then
 * throwing an error leads to undefined behavior.
 */
export interface QuereusContext {
	/**
	 * Sets the result of the function to a BLOB value.
	 * @param value The BLOB data
	 * @param destructor Optional hint that influences whether the engine copies the buffer
	 */
	resultBlob(value: Uint8Array, destructor?: unknown): void;

	/**
	 * Sets the result of the function to a floating-point value.
	 * @param value The double value
	 */
	resultDouble(value: number): void;

	/**
	 * Causes the function to return an error state.
	 * @param message The error message
	 * @param code Optional error code (defaults to ERROR)
	 */
	resultError(message: string, code?: StatusCode): void;

	/**
	 * Sets the result of the function to a 32-bit integer value.
	 * For larger integers, use resultInt64.
	 * @param value The integer value
	 */
	resultInt(value: number): void;

	/**
	 * Sets the result of the function to a 64-bit integer value.
	 * @param value The bigint value
	 */
	resultInt64(value: bigint): void;

	/**
	 * Sets the result of the function to SQL NULL.
	 */
	resultNull(): void;

	/**
	 * Sets the result of the function to a TEXT value.
	 * @param value The string value
	 * @param destructor Optional hint that influences whether the engine copies the string
	 */
	resultText(value: string, destructor?: unknown): void;

	/**
	 * Sets the result of the function to the provided SqlValue.
	 * @param value The SqlValue to set as the result
	 */
	resultValue(value: SqlValue): void;

	/**
	 * Sets the result to a zero-filled BLOB of a specified size.
	 * @param n The desired size of the zeroblob in bytes
	 */
	resultZeroblob(n: number): void;

	/**
	 * Sets the application-defined subtype for the result value.
	 * @param subtype An unsigned integer representing the subtype
	 */
	resultSubtype(subtype: number): void;

	/**
	 * Returns the user data associated with the function registration.
	 * @returns The user data specified during registration
	 */
	getUserData(): unknown;

	/**
	 * Returns the Database connection associated with this context.
	 * @returns The database connection
	 */
	getDbConnection(): Database;

	/**
	 * Gets auxiliary data previously associated with a function argument.
	 * Used for caching computations across multiple calls with the same arguments.
	 * @param N The argument index (0-based)
	 * @returns The stored auxiliary data, or undefined if none exists
	 */
	getAuxData(N: number): unknown;

	/**
	 * Sets auxiliary data associated with a specific function argument.
	 * @param N The argument index (0-based)
	 * @param data The data to store
	 * @param destructor Optional cleanup function called when the data is discarded
	 */
	setAuxData(N: number, data: unknown, destructor?: (data: unknown) => void): void;

	/**
	 * Retrieves the context (accumulator) for an aggregate function.
	 * @param createIfNotFound If true and no context exists, creates a new empty object
	 * @returns The aggregate context for the current group, or undefined
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	getAggregateContext<T = any>(createIfNotFound?: boolean): T | undefined;

	/**
	 * Sets the context (accumulator) for an aggregate function.
	 * @param context The new state for the aggregate context
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	setAggregateContext<T = any>(context: T): void;
}

const log = createLogger('func:context');
const errorLog = log.extend('error');

/**
 * Concrete implementation of QuereusContext used by the engine.
 * @internal
 */
export class FunctionContext implements QuereusContext {
	private _result: SqlValue | undefined = undefined;
	private _result_set = false;
	private _error: QuereusError | null = null;
	private _subtype: number = 0;
	private userData: unknown;
	private db: Database;
	private auxData: Map<number, { data: unknown, destructor?: (data: unknown) => void }> = new Map();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private _aggregateContext: any | undefined = undefined;

	constructor(db: Database, userData?: unknown) {
		this.db = db;
		this.userData = userData;
	}

	/**
	 * @internal Gets the function result or throws if in error state
	 */
	_getResult(): SqlValue | null {
		if (this._error) throw this._error;
		return this._result_set ? this._result! : null;
	}

	/**
	 * @internal Gets the error if one occurred
	 */
	_getError(): QuereusError | null { return this._error; }

	/**
	 * @internal Gets the result subtype
	 */
	_getSubtype(): number { return this._subtype; }

	/**
	 * @internal Resets the context for reuse
	 */
	_clear(): void {
		this._result = undefined;
		this._result_set = false;
		this._error = null;
		this._subtype = 0;
	}

	/**
	 * @internal Sets the aggregate context reference from VDBE
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	_setAggregateContextRef(contextRef: any | undefined): void {
		this._aggregateContext = contextRef;
	}

	/**
	 * @internal Gets the potentially modified aggregate context
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	_getAggregateContextRef(): any | undefined {
		return this._aggregateContext;
	}

	private setResult(value: SqlValue) {
		if (this._result_set || this._error) return;
		this._result = value;
		this._result_set = true;
	}

	resultBlob(value: Uint8Array): void { this.setResult(value); }
	resultDouble(value: number): void { this.setResult(value); }
	resultError(message: string, code: StatusCode = StatusCode.ERROR): void {
		if (this._result_set || this._error) return;
		this._error = new QuereusError(message, code);
	}
	resultInt(value: number): void { this.setResult(Math.trunc(value)); }
	resultInt64(value: bigint): void { this.setResult(value); }
	resultNull(): void { this.setResult(null); }
	resultText(value: string): void { this.setResult(value); }
	resultValue(value: SqlValue): void { this.setResult(value); }
	resultZeroblob(n: number): void { this.setResult(new Uint8Array(n)); }
	resultSubtype(subtype: number): void { this._subtype = subtype >>> 0; }

	getUserData(): unknown { return this.userData; }
	getDbConnection(): Database { return this.db; }

	getAuxData(N: number): unknown {
		return this.auxData.get(N)?.data;
	}

	setAuxData(N: number, data: unknown, destructor?: (data: unknown) => void): void {
		if (this._error) return;
		const existing = this.auxData.get(N);
		if (existing?.destructor && existing.data !== data) {
			try { existing.destructor(existing.data); } catch (e) {
				errorLog("Internal: AuxData destructor failed: %O", e);
			}
		}
		if (data === undefined && destructor === undefined) {
			this.auxData.delete(N);
		} else {
			this.auxData.set(N, { data, destructor });
		}
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	getAggregateContext<T = any>(createIfNotFound: boolean = false): T | undefined {
		if (this._aggregateContext === undefined && createIfNotFound) {
			return {} as T;
		}
		return this._aggregateContext as T | undefined;
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	setAggregateContext<T = any>(context: T): void {
		this._aggregateContext = context;
	}

	/**
	 * @internal Cleans up auxiliary data during statement reset/finalize
	 */
	_cleanupAuxData(): void {
		this.auxData.forEach(entry => {
			if (entry.destructor) {
				try { entry.destructor(entry.data); } catch (e) {
					errorLog("Internal: AuxData destructor failed: %O", e);
				}
			}
		});
		this.auxData.clear();
	}
}
