import { MaybePromise } from "../common/types.js";

/**
 * Generic interface for VirtualTable connections that support transactions.
 * This allows different vtab modules to implement their own connection strategies
 * while providing a consistent interface for transaction operations.
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

	/** Commits the current transaction */
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
