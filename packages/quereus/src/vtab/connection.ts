import { MaybePromise } from "../common/types.js";

/**
 * Generic interface for VirtualTable connections that support transactions.
 * This allows different vtab modules to implement their own connection strategies
 * while providing a consistent interface for transaction operations.
 *
 * What the engine promises a connection passed to `Database.registerConnection`
 * (docs/invariants.md TXN-001; docs/module-authoring-transactions.md § Connection lifecycle):
 *
 * - Every `begin`, `commit`, `rollback` and savepoint call holds the execution mutex.
 * - Calls on one connection never overlap.
 * - A connection receives `begin`, then savepoint calls at in-range depths, then
 *   exactly one `commit` or `rollback`, before the next `begin`. A `commit` that
 *   rejects leaves the connection open, and `rollback` follows. A `begin` that
 *   rejects leaves it idle.
 * - With no statement running and the database in autocommit, the connection is idle.
 *
 * `installConnectionLifecycleCheck` checks a module's test runs against this.
 */
export interface VirtualTableConnection {
	/** Unique identifier for this connection */
	readonly connectionId: string;

	/** Name of the table this connection is associated with */
	readonly tableName: string;

	/**
	 * When true, this connection is the primary/covering connection for the table —
	 * it coordinates all transaction semantics (including over underlying sub-connections).
	 * Used by DeferredConstraintQueue to prefer this connection when multiple connections
	 * match the same table name.
	 */
	readonly isCovering?: boolean;

	// Transaction methods
	/** Begins a transaction on this connection */
	begin(): MaybePromise<void>;

	/**
	 * Commits the current transaction. Runs under the execution mutex, so awaiting a
	 * statement on the same database here hangs it; schedule that work without awaiting it.
	 */
	commit(): MaybePromise<void>;

	/** Rolls back the current transaction */
	rollback(): MaybePromise<void>;

	/** Creates a savepoint with the given index */
	createSavepoint(index: number): MaybePromise<void>;

	/** Releases a savepoint with the given index */
	releaseSavepoint(index: number): MaybePromise<void>;

	/** Rolls back to a savepoint with the given index */
	rollbackToSavepoint(index: number): MaybePromise<void>;

	/** Disconnects and cleans up this connection */
	disconnect(): MaybePromise<void>;
}
