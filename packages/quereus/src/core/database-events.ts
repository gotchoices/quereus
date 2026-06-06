/**
 * Database-level event system for unified reactivity.
 *
 * This module provides a centralized event aggregator that collects and broadcasts
 * data and schema change events from all virtual table modules. Events are batched
 * within transactions and emitted after successful commit.
 *
 * Modules that implement their own event emission (detected via getEventEmitter())
 * will have their events forwarded to the database level. For modules without
 * native event support, the engine automatically emits events for local operations.
 */

import { createLogger } from '../common/logger.js';
import type { Row, SqlValue } from '../common/types.js';
import type { VTableDataChangeEvent, VTableSchemaChangeEvent, VTableEventEmitter } from '../vtab/events.js';

const log = createLogger('core:database-events');
const warnLog = log.extend('warn');
const errorLog = log.extend('error');

/**
 * Data change event emitted at the database level.
 * Extends VTableDataChangeEvent with module identification.
 */
export interface DatabaseDataChangeEvent {
	/** The type of mutation operation */
	type: 'insert' | 'update' | 'delete';
	/** The module that raised this event */
	moduleName: string;
	/** Schema name containing the table */
	schemaName: string;
	/** Table name */
	tableName: string;
	/** Primary key values */
	key?: SqlValue[];
	/** Previous row data (for update/delete) */
	oldRow?: Row;
	/** New row data (for insert/update) */
	newRow?: Row;
	/** Column names that changed (for updates) */
	changedColumns?: string[];
	/** True if event originated from sync/remote source, false for local changes */
	remote: boolean;
}

/**
 * Schema change event emitted at the database level.
 * Extends VTableSchemaChangeEvent with module identification.
 */
export interface DatabaseSchemaChangeEvent {
	/** The type of schema operation */
	type: 'create' | 'alter' | 'drop';
	/** The type of object being modified */
	objectType: 'table' | 'index' | 'column';
	/** The module that raised this event */
	moduleName: string;
	/** Schema name */
	schemaName: string;
	/** Object name (table name for table/column, index name for index) */
	objectName: string;
	/** Column name (for column operations) */
	columnName?: string;
	/** Old column name (for column rename) */
	oldColumnName?: string;
	/** DDL statement if available */
	ddl?: string;
	/** True if event originated from sync/remote source, false for local changes */
	remote: boolean;
}

export type DatabaseDataChangeListener = (event: DatabaseDataChangeEvent) => void;
export type DatabaseSchemaChangeListener = (event: DatabaseSchemaChangeEvent) => void;

/**
 * Options for subscribing to data change events.
 * Reserved fields for future filtering capabilities, plus pass-through for module-specific options.
 */
export interface DataChangeSubscriptionOptions {
	// Reserved for future unified options:
	// tables?: string[];
	// schemas?: string[];
	// operations?: ('insert' | 'update' | 'delete')[];
	// remoteOnly?: boolean;
	// localOnly?: boolean;

	/** Module-specific options passed through to modules */
	[key: string]: unknown;
}

/**
 * Options for subscribing to schema change events.
 */
export interface SchemaChangeSubscriptionOptions {
	// Reserved for future unified options:
	// objectTypes?: ('table' | 'index' | 'column')[];
	// schemas?: string[];

	/** Module-specific options passed through to modules */
	[key: string]: unknown;
}

/**
 * Internal structure for tracking a pending (batched) data change event
 * along with its source module name.
 */
interface PendingDataEvent {
	moduleName: string;
	event: VTableDataChangeEvent;
}

/**
 * Internal structure for tracking a pending schema change event.
 */
interface PendingSchemaEvent {
	moduleName: string;
	event: VTableSchemaChangeEvent;
}

/** Default maximum number of listeners per event type before a warning is logged. */
const DEFAULT_MAX_LISTENERS = 100;

/**
 * Central event emitter for database-level reactivity.
 *
 * Aggregates events from all virtual table modules and broadcasts them to
 * registered listeners. Handles transaction batching - events are collected
 * during a transaction and emitted only after successful commit.
 *
 * Supports savepoint semantics: events within a savepoint are tracked separately
 * and can be discarded on ROLLBACK TO SAVEPOINT or merged on RELEASE.
 */
export class DatabaseEventEmitter {
	private dataListeners = new Set<DatabaseDataChangeListener>();
	private schemaListeners = new Set<DatabaseSchemaChangeListener>();
	private maxListeners = DEFAULT_MAX_LISTENERS;

	/** Batched events waiting for commit (base transaction level) */
	private batchedDataEvents: PendingDataEvent[] = [];
	private batchedSchemaEvents: PendingSchemaEvent[] = [];

	/** Savepoint layers for event batching - each layer captures events since that savepoint */
	private dataEventLayers: PendingDataEvent[][] = [];
	private schemaEventLayers: PendingSchemaEvent[][] = [];

	/** Whether we're currently in a transaction (batching mode) */
	private isBatching = false;

	/** Map of module emitters we've subscribed to, for cleanup */
	private moduleSubscriptions = new Map<string, { dataUnsub?: () => void; schemaUnsub?: () => void }>();

	/**
	 * Set the maximum number of listeners per event type.
	 * A warning is logged when this limit is exceeded, which typically
	 * indicates a listener leak. Set to 0 to disable the warning.
	 */
	setMaxListeners(n: number): void {
		this.maxListeners = n;
	}

	/**
	 * Get the current maximum listener count.
	 */
	getMaxListeners(): number {
		return this.maxListeners;
	}

	/**
	 * Subscribe to data change events from all modules.
	 * @param listener Callback invoked for each data change event
	 * @param _options Reserved for future filtering options
	 * @returns Unsubscribe function
	 */
	onDataChange(
		listener: DatabaseDataChangeListener,
		_options?: DataChangeSubscriptionOptions
	): () => void {
		this.dataListeners.add(listener);
		this.checkListenerCount('data', this.dataListeners.size);
		log('Added data change listener, total: %d', this.dataListeners.size);
		return () => {
			this.dataListeners.delete(listener);
			log('Removed data change listener, total: %d', this.dataListeners.size);
		};
	}

	/**
	 * Subscribe to schema change events from all modules.
	 * @param listener Callback invoked for each schema change event
	 * @param _options Reserved for future filtering options
	 * @returns Unsubscribe function
	 */
	onSchemaChange(
		listener: DatabaseSchemaChangeListener,
		_options?: SchemaChangeSubscriptionOptions
	): () => void {
		this.schemaListeners.add(listener);
		this.checkListenerCount('schema', this.schemaListeners.size);
		log('Added schema change listener, total: %d', this.schemaListeners.size);
		return () => {
			this.schemaListeners.delete(listener);
			log('Removed schema change listener, total: %d', this.schemaListeners.size);
		};
	}

	/**
	 * Check if there are any data change listeners registered.
	 */
	hasDataListeners(): boolean {
		return this.dataListeners.size > 0;
	}

	/**
	 * Check if there are any schema change listeners registered.
	 */
	hasSchemaListeners(): boolean {
		return this.schemaListeners.size > 0;
	}

	/**
	 * Hook a module's event emitter to forward events to the database level.
	 * Called when a module with native event support is detected.
	 *
	 * @param moduleName The name of the module
	 * @param emitter The module's event emitter
	 */
	hookModuleEmitter(moduleName: string, emitter: VTableEventEmitter): void {
		// Avoid double-subscription
		if (this.moduleSubscriptions.has(moduleName)) {
			return;
		}

		const subs: { dataUnsub?: () => void; schemaUnsub?: () => void } = {};

		// Subscribe to data changes if supported
		if (emitter.onDataChange) {
			subs.dataUnsub = emitter.onDataChange((event) => {
				this.handleModuleDataEvent(moduleName, event);
			});
		}

		// Subscribe to schema changes if supported
		if (emitter.onSchemaChange) {
			subs.schemaUnsub = emitter.onSchemaChange((event) => {
				this.handleModuleSchemaEvent(moduleName, event);
			});
		}

		this.moduleSubscriptions.set(moduleName, subs);
		log('Hooked module emitter: %s', moduleName);
	}

	/**
	 * Unhook a module's event emitter.
	 * Called when a module is unregistered.
	 *
	 * @param moduleName The name of the module
	 */
	unhookModuleEmitter(moduleName: string): void {
		const subs = this.moduleSubscriptions.get(moduleName);
		if (subs) {
			subs.dataUnsub?.();
			subs.schemaUnsub?.();
			this.moduleSubscriptions.delete(moduleName);
			log('Unhooked module emitter: %s', moduleName);
		}
	}

	/**
	 * Warn if the listener count for a category exceeds the configured maximum.
	 */
	private checkListenerCount(category: string, count: number): void {
		if (this.maxListeners > 0 && count > this.maxListeners) {
			warnLog(
				'Possible listener leak: %d %s change listeners registered (max %d). ' +
				'Use setMaxListeners() to increase the limit if this is intentional.',
				count, category, this.maxListeners
			);
		}
	}

	/**
	 * Get the active data event store (top layer or base).
	 */
	private getActiveDataStore(): PendingDataEvent[] {
		return this.dataEventLayers.length > 0
			? this.dataEventLayers[this.dataEventLayers.length - 1]
			: this.batchedDataEvents;
	}

	/**
	 * Get the active schema event store (top layer or base).
	 */
	private getActiveSchemaStore(): PendingSchemaEvent[] {
		return this.schemaEventLayers.length > 0
			? this.schemaEventLayers[this.schemaEventLayers.length - 1]
			: this.batchedSchemaEvents;
	}

	/**
	 * Handle a data change event from a module.
	 * If batching, queue the event; otherwise emit immediately.
	 */
	private handleModuleDataEvent(moduleName: string, event: VTableDataChangeEvent): void {
		if (this.isBatching) {
			this.getActiveDataStore().push({ moduleName, event });
			log('Batched data event from %s: %s on %s.%s', moduleName, event.type, event.schemaName, event.tableName);
		} else {
			this.emitDataEvent(moduleName, event);
		}
	}

	/**
	 * Handle a schema change event from a module.
	 * Schema events are typically not batched (DDL is usually auto-committed),
	 * but we support batching for consistency.
	 */
	private handleModuleSchemaEvent(moduleName: string, event: VTableSchemaChangeEvent): void {
		if (this.isBatching) {
			this.getActiveSchemaStore().push({ moduleName, event });
			log('Batched schema event from %s: %s %s', moduleName, event.type, event.objectName);
		} else {
			this.emitSchemaEvent(moduleName, event);
		}
	}

	/**
	 * Emit a data change event for a module that doesn't have native event support.
	 * Called by the engine after successful DML operations.
	 *
	 * @param moduleName The module name
	 * @param event The event to emit (will be converted to DatabaseDataChangeEvent)
	 */
	emitAutoDataEvent(moduleName: string, event: VTableDataChangeEvent): void {
		if (this.isBatching) {
			this.getActiveDataStore().push({ moduleName, event });
			log('Batched auto data event from %s: %s on %s.%s', moduleName, event.type, event.schemaName, event.tableName);
		} else {
			this.emitDataEvent(moduleName, event);
		}
	}

	/**
	 * Emit a schema change event for a module that doesn't have native event support.
	 * Called by the engine after successful DDL operations.
	 *
	 * @param moduleName The module name
	 * @param event The event to emit
	 */
	emitAutoSchemaEvent(moduleName: string, event: VTableSchemaChangeEvent): void {
		if (this.isBatching) {
			this.getActiveSchemaStore().push({ moduleName, event });
		} else {
			this.emitSchemaEvent(moduleName, event);
		}
	}

	/**
	 * Emit a data event to all listeners.
	 */
	private emitDataEvent(moduleName: string, event: VTableDataChangeEvent): void {
		if (this.dataListeners.size === 0) return;

		const dbEvent: DatabaseDataChangeEvent = {
			type: event.type,
			moduleName,
			schemaName: event.schemaName,
			tableName: event.tableName,
			key: event.key,
			oldRow: event.oldRow,
			newRow: event.newRow,
			changedColumns: event.changedColumns,
			remote: event.remote ?? false,
		};

		log('Emitting data event: %s on %s.%s (module: %s, remote: %s)',
			dbEvent.type, dbEvent.schemaName, dbEvent.tableName, moduleName, dbEvent.remote);

		for (const listener of this.dataListeners) {
			try {
				listener(dbEvent);
			} catch (e) {
				errorLog('Data change listener error on %s.%s (%s): %O',
					dbEvent.schemaName, dbEvent.tableName, dbEvent.type, e);
			}
		}
	}

	/**
	 * Emit a schema event to all listeners.
	 */
	private emitSchemaEvent(moduleName: string, event: VTableSchemaChangeEvent): void {
		if (this.schemaListeners.size === 0) return;

		const dbEvent: DatabaseSchemaChangeEvent = {
			type: event.type,
			objectType: event.objectType,
			moduleName,
			schemaName: event.schemaName,
			objectName: event.objectName,
			columnName: event.columnName,
			oldColumnName: event.oldColumnName,
			ddl: event.ddl,
			remote: event.remote ?? false,
		};

		log('Emitting schema event: %s %s %s (module: %s, remote: %s)',
			dbEvent.type, dbEvent.objectType, dbEvent.objectName, moduleName, dbEvent.remote);

		for (const listener of this.schemaListeners) {
			try {
				listener(dbEvent);
			} catch (e) {
				errorLog('Schema change listener error on %s %s %s: %O',
					dbEvent.type, dbEvent.objectType, dbEvent.objectName, e);
			}
		}
	}

	/**
	 * Start batching events (called at transaction begin).
	 */
	startBatch(): void {
		this.isBatching = true;
		this.batchedDataEvents = [];
		this.batchedSchemaEvents = [];
		this.dataEventLayers = [];
		this.schemaEventLayers = [];
		log('Started event batching');
	}

	/**
	 * Flush all batched events to listeners (called after successful commit).
	 * Collects events from all layers (base + savepoint layers) and emits them.
	 */
	flushBatch(): void {
		this.isBatching = false;

		// Collect all events from base and all layers
		const allDataEvents: PendingDataEvent[] = [...this.batchedDataEvents];
		for (const layer of this.dataEventLayers) {
			allDataEvents.push(...layer);
		}

		const allSchemaEvents: PendingSchemaEvent[] = [...this.batchedSchemaEvents];
		for (const layer of this.schemaEventLayers) {
			allSchemaEvents.push(...layer);
		}

		// Clear all
		this.batchedDataEvents = [];
		this.batchedSchemaEvents = [];
		this.dataEventLayers = [];
		this.schemaEventLayers = [];

		log('Flushing %d data events and %d schema events', allDataEvents.length, allSchemaEvents.length);

		// Emit schema events first (table creation before data insertion makes logical sense)
		for (const { moduleName, event } of allSchemaEvents) {
			this.emitSchemaEvent(moduleName, event);
		}

		// Then emit data events
		for (const { moduleName, event } of allDataEvents) {
			this.emitDataEvent(moduleName, event);
		}
	}

	/**
	 * Discard all batched events (called on rollback).
	 */
	discardBatch(): void {
		this.isBatching = false;
		const discardedData = this.batchedDataEvents.length + this.dataEventLayers.reduce((sum, layer) => sum + layer.length, 0);
		const discardedSchema = this.batchedSchemaEvents.length + this.schemaEventLayers.reduce((sum, layer) => sum + layer.length, 0);
		this.batchedDataEvents = [];
		this.batchedSchemaEvents = [];
		this.dataEventLayers = [];
		this.schemaEventLayers = [];
		log('Discarded %d data events and %d schema events', discardedData, discardedSchema);
	}

	/**
	 * Begin a new savepoint layer for event batching.
	 * Events after this point will be captured in the new layer.
	 */
	beginSavepointLayer(): void {
		this.dataEventLayers.push([]);
		this.schemaEventLayers.push([]);
		log('Started savepoint event layer (depth: %d)', this.dataEventLayers.length);
	}

	/**
	 * Rollback the current savepoint layer, discarding its events.
	 * Called on ROLLBACK TO SAVEPOINT.
	 */
	rollbackSavepointLayer(): void {
		const discardedData = this.dataEventLayers.pop();
		const discardedSchema = this.schemaEventLayers.pop();
		log('Rolled back savepoint event layer, discarded %d data and %d schema events',
			discardedData?.length ?? 0, discardedSchema?.length ?? 0);
	}

	/**
	 * Release the current savepoint layer, merging its events into the parent layer.
	 * Called on RELEASE SAVEPOINT.
	 */
	releaseSavepointLayer(): void {
		const topData = this.dataEventLayers.pop();
		const topSchema = this.schemaEventLayers.pop();

		if (topData && topData.length > 0) {
			// Merge into parent layer or base
			const targetData = this.dataEventLayers.length > 0
				? this.dataEventLayers[this.dataEventLayers.length - 1]
				: this.batchedDataEvents;
			targetData.push(...topData);
		}

		if (topSchema && topSchema.length > 0) {
			const targetSchema = this.schemaEventLayers.length > 0
				? this.schemaEventLayers[this.schemaEventLayers.length - 1]
				: this.batchedSchemaEvents;
			targetSchema.push(...topSchema);
		}

		log('Released savepoint event layer, merged %d data and %d schema events',
			topData?.length ?? 0, topSchema?.length ?? 0);
	}

	/**
	 * Remove all listeners and unhook all modules.
	 * Logs a warning if listeners were still registered, which may indicate
	 * missing cleanup in consumer code.
	 */
	removeAllListeners(): void {
		const dataCount = this.dataListeners.size;
		const schemaCount = this.schemaListeners.size;

		if (dataCount > 0 || schemaCount > 0) {
			warnLog(
				'removeAllListeners() called with %d data and %d schema listeners still registered — possible listener leak',
				dataCount, schemaCount
			);
		}

		this.dataListeners.clear();
		this.schemaListeners.clear();
		this.batchedDataEvents = [];
		this.batchedSchemaEvents = [];
		this.dataEventLayers = [];
		this.schemaEventLayers = [];
		this.isBatching = false;

		// Unhook all module emitters
		for (const [, subs] of this.moduleSubscriptions) {
			subs.dataUnsub?.();
			subs.schemaUnsub?.();
		}
		this.moduleSubscriptions.clear();

		log('Removed all listeners and unhooked all modules');
	}

	/**
	 * Check if currently batching events.
	 */
	isBatchingEvents(): boolean {
		return this.isBatching;
	}
}
