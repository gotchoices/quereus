import type { VirtualTableConnection } from '@quereus/quereus';
import type { IsolatedTable } from './isolated-table.js';

let connectionIdCounter = 0;

/**
 * Callback interface for IsolatedTable to receive transaction events.
 */
export interface IsolatedTableCallback {
	onConnectionCommit(): Promise<void>;
	onConnectionRollback(): Promise<void>;
	onConnectionSavepoint(index: number): Promise<void>;
	onConnectionReleaseSavepoint(index: number): Promise<void>;
	onConnectionRollbackToSavepoint(index: number): Promise<void>;
}

/**
 * Connection wrapper that coordinates transactions across overlay and underlying.
 * When commit/rollback are called by the database, this connection calls back
 * to the IsolatedTable to perform flush/clear operations.
 */
export class IsolatedConnection implements VirtualTableConnection {
	readonly connectionId: string;
	readonly tableName: string;
	readonly isCovering = true;

	private readonly underlyingConnection: VirtualTableConnection | undefined;
	private readonly overlayConnection: VirtualTableConnection | undefined;
	private readonly tableCallback: IsolatedTableCallback | undefined;

	constructor(
		tableName: string,
		underlyingConnection: VirtualTableConnection | undefined,
		overlayConnection: VirtualTableConnection | undefined,
		tableCallback?: IsolatedTableCallback
	) {
		this.connectionId = `isolated-${++connectionIdCounter}`;
		this.tableName = tableName;
		this.underlyingConnection = underlyingConnection;
		this.overlayConnection = overlayConnection;
		this.tableCallback = tableCallback;
	}

	async begin(): Promise<void> {
		await this.underlyingConnection?.begin();
		await this.overlayConnection?.begin();
	}

	async commit(): Promise<void> {
		// Call table's commit logic (flush overlay to underlying)
		if (this.tableCallback) {
			await this.tableCallback.onConnectionCommit();
		}
		// Then commit the underlying connections
		await this.overlayConnection?.commit();
		await this.underlyingConnection?.commit();
	}

	async rollback(): Promise<void> {
		// Call table's rollback logic (clear overlay)
		if (this.tableCallback) {
			await this.tableCallback.onConnectionRollback();
		}
		// Only rollback the overlay - the underlying table should NOT be rolled back
		// because it only contains committed data (flushed during commit)
		await this.overlayConnection?.rollback();
		// Note: We intentionally do NOT rollback underlyingConnection here.
		// The underlying table only receives writes during commit flush,
		// and those writes should be committed, not rolled back.
	}

	async createSavepoint(index: number): Promise<void> {
		if (this.tableCallback) {
			await this.tableCallback.onConnectionSavepoint(index);
		}
		await this.underlyingConnection?.createSavepoint(index);
		await this.overlayConnection?.createSavepoint(index);
	}

	async releaseSavepoint(index: number): Promise<void> {
		if (this.tableCallback) {
			await this.tableCallback.onConnectionReleaseSavepoint(index);
		}
		await this.underlyingConnection?.releaseSavepoint(index);
		await this.overlayConnection?.releaseSavepoint(index);
	}

	async rollbackToSavepoint(index: number): Promise<void> {
		if (this.tableCallback) {
			await this.tableCallback.onConnectionRollbackToSavepoint(index);
		}
		await this.overlayConnection?.rollbackToSavepoint(index);
		await this.underlyingConnection?.rollbackToSavepoint(index);
	}

	async disconnect(): Promise<void> {
		await this.overlayConnection?.disconnect();
		await this.underlyingConnection?.disconnect();
	}
}
