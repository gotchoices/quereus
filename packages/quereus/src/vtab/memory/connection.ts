import type { VirtualTableConnection } from '../connection.js';
import type { MemoryTableConnection } from './layer/connection.js';
import { createLogger } from '../../common/logger.js';

const log = createLogger('vtab:memory:vtab-connection');

/**
 * VirtualTableConnection implementation for memory tables.
 * Wraps the existing MemoryTableConnection to provide the generic interface.
 */
export class MemoryVirtualTableConnection implements VirtualTableConnection {
	public readonly connectionId: string;
	public readonly tableName: string;
	private memoryConnection: MemoryTableConnection;

	constructor(tableName: string, memoryConnection: MemoryTableConnection) {
		this.connectionId = `memory-${tableName}-${memoryConnection.connectionId}`;
		this.tableName = tableName;
		this.memoryConnection = memoryConnection;
	}

	/** Begins a transaction on this connection */
	begin(): void {
		log(`BEGIN transaction on connection ${this.connectionId}`);
		this.memoryConnection.begin();
	}

	/** Commits the current transaction */
	async commit(): Promise<void> {
		log(`COMMIT transaction on connection ${this.connectionId}`);
		await this.memoryConnection.commit();
	}

	/** Rolls back the current transaction */
	rollback(): void {
		log(`ROLLBACK transaction on connection ${this.connectionId}`);
		this.memoryConnection.rollback();
	}

	/** Creates a savepoint with the given index */
	createSavepoint(index: number): void {
		log(`CREATE SAVEPOINT ${index} on connection ${this.connectionId}`);
		this.memoryConnection.createSavepoint(index);
	}

	/** Releases a savepoint with the given index */
	releaseSavepoint(index: number): void {
		log(`RELEASE SAVEPOINT ${index} on connection ${this.connectionId}`);
		this.memoryConnection.releaseSavepoint(index);
	}

	/** Rolls back to a savepoint with the given index */
	rollbackToSavepoint(index: number): void {
		log(`ROLLBACK TO SAVEPOINT ${index} on connection ${this.connectionId}`);
		this.memoryConnection.rollbackToSavepoint(index);
	}

	/** Disconnects and cleans up this connection */
	async disconnect(): Promise<void> {
		log(`DISCONNECT connection ${this.connectionId}`);
		// The MemoryTableConnection doesn't have a disconnect method,
		// but we can clear any pending transaction state
		if (this.memoryConnection.pendingTransactionLayer) {
			log(`Rolling back pending transaction on disconnect for ${this.connectionId}`);
			this.memoryConnection.rollback();
		}
	}

	/** Gets the underlying MemoryTableConnection for internal use */
	getMemoryConnection(): MemoryTableConnection {
		return this.memoryConnection;
	}
}
