import type { Database } from '../../../core/database.js';
import { type TableSchema, type IndexSchema, type UniqueConstraintSchema, buildColumnIndexMap, columnDefToSchema } from '../../../schema/table.js';
import { type BTreeKeyForPrimary } from '../types.js';
import { StatusCode, type SqlValue, type Row, type UpdateResult } from '../../../common/types.js';
import { BaseLayer } from './base.js';
import { TransactionLayer } from './transaction.js';
import type { Layer } from './interface.js';
import { MemoryTableConnection } from './connection.js';
import { Latches } from '../../../util/latches.js';
import { QuereusError } from '../../../common/errors.js';
import { ConflictResolution } from '../../../common/constants.js';
import type { ColumnDef as ASTColumnDef, LiteralExpr } from '../../../parser/ast.js';
import { compareSqlValues } from '../../../util/comparison.js';
import type { ScanPlan } from './scan-plan.js';
import type { ColumnSchema } from '../../../schema/column.js';
import { scanLayer as scanLayerImpl } from './scan-layer.js';
import { createPrimaryKeyFunctions, buildPrimaryKeyFromValues, type PrimaryKeyFunctions } from '../utils/primary-key.js';
import { createMemoryTableLoggers } from '../utils/logging.js';
import { getSyncLiteral } from '../../../parser/utils.js';
import { validateAndParse } from '../../../types/validation.js';
import type { VTableEventEmitter } from '../../events.js';
import { inferType } from '../../../types/registry.js';
import type { Expression } from '../../../parser/ast.js';

let tableManagerCounter = 0;
const logger = createMemoryTableLoggers('layer:manager');

export class MemoryTableManager {
	public readonly managerId: number;
	public readonly db: Database;
	public readonly schemaName: string;
	private _tableName: string;
	public get tableName() { return this._tableName; }

	private baseLayer: BaseLayer;
	private _currentCommittedLayer: Layer;
	private connections: Map<number, MemoryTableConnection> = new Map();
	public readonly isReadOnly: boolean;
	public tableSchema: TableSchema;

	private primaryKeyFunctions!: PrimaryKeyFunctions;

	/** Optional event emitter for mutation and schema hooks */
	private eventEmitter?: VTableEventEmitter;

	constructor(
		db: Database,
		_moduleName: string,
		schemaName: string,
		tableName: string,
		initialSchema: TableSchema,
		readOnly: boolean = false,
		eventEmitter?: VTableEventEmitter
	) {
		this.managerId = tableManagerCounter++;
		this.db = db;
		this.schemaName = schemaName;
		this._tableName = tableName;
		this.tableSchema = initialSchema;
		this.isReadOnly = readOnly;
		this.eventEmitter = eventEmitter;

		this.ensureUniqueConstraintIndexes();
		this.initializePrimaryKeyFunctions();

		this.baseLayer = new BaseLayer(this.tableSchema);
		this._currentCommittedLayer = this.baseLayer;
	}

	private initializePrimaryKeyFunctions(): void {
		this.primaryKeyFunctions = createPrimaryKeyFunctions(this.tableSchema);
	}

	/**
	 * Auto-creates secondary indexes for UNIQUE constraints that don't already
	 * have a matching index. This mirrors standard SQL behavior where UNIQUE
	 * constraints imply an index for efficient enforcement.
	 */
	private ensureUniqueConstraintIndexes(): void {
		const uniqueConstraints = this.tableSchema.uniqueConstraints;
		if (!uniqueConstraints || uniqueConstraints.length === 0) return;

		const existingIndexes = this.tableSchema.indexes ?? [];
		const newIndexes: IndexSchema[] = [...existingIndexes];
		let added = false;

		for (const uc of uniqueConstraints) {
			const hasMatchingIndex = existingIndexes.some(idx =>
				idx.columns.length === uc.columns.length &&
				idx.columns.every((col, i) => col.index === uc.columns[i])
			);

			if (!hasMatchingIndex) {
				const colNames = uc.columns.map(i => this.tableSchema.columns[i]?.name ?? String(i));
				const indexName = uc.name ?? `_uc_${colNames.join('_')}`;
				newIndexes.push({
					name: indexName,
					columns: uc.columns.map(colIdx => ({ index: colIdx })),
				});
				added = true;
			}
		}

		if (added) {
			this.tableSchema = {
				...this.tableSchema,
				indexes: Object.freeze(newIndexes),
			};
		}
	}

	/**
	 * Get the event emitter if one was provided.
	 */
	getEventEmitter(): VTableEventEmitter | undefined {
		return this.eventEmitter;
	}

	/**
	 * Compute which columns changed between old and new rows.
	 */
	private computeChangedColumns(oldRow: Row, newRow: Row): string[] {
		const changed: string[] = [];
		const schema = this.tableSchema;

		for (let i = 0; i < schema.columns.length && i < Math.max(oldRow.length, newRow.length); i++) {
			if (oldRow[i] !== newRow[i]) {
				changed.push(schema.columns[i].name);
			}
		}

		return changed;
	}

	private get primaryKeyFromRow() {
		return this.primaryKeyFunctions.extractFromRow;
	}

	private get comparePrimaryKeys() {
		return this.primaryKeyFunctions.compare;
	}

	public get currentCommittedLayer(): Layer {
		return this._currentCommittedLayer;
	}

	/**
	 * Returns committed layer statistics for cost-based optimization.
	 * Provides exact row count and per-index distinct counts without scanning.
	 */
	getBaseLayerStats(): { rowCount: number; indexDistinctCounts: Map<string, number> } {
		const tree = this._currentCommittedLayer.getModificationTree('primary');
		const rowCount = tree?.getCount() ?? 0;
		const indexDistinctCounts = new Map<string, number>();
		for (const idx of this.tableSchema?.indexes ?? []) {
			const idxTree = this._currentCommittedLayer.getSecondaryIndexTree?.(idx.name);
			if (idxTree) {
				indexDistinctCounts.set(idx.name, idxTree.getCount());
			}
		}
		return { rowCount, indexDistinctCounts };
	}

	/**
	 * Sample column values from the committed layer for histogram construction.
	 * Returns sorted non-null values for the specified column index.
	 * For tables with <= maxSample rows returns all values; otherwise systematic samples.
	 */
	sampleColumnValues(columnIndex: number, maxSample: number = 1000): SqlValue[] {
		const tree = this._currentCommittedLayer.getModificationTree('primary');
		if (!tree) return [];
		const count = tree.getCount();
		const values: SqlValue[] = [];

		if (count === 0) return values;

		const step = count <= maxSample ? 1 : Math.floor(count / maxSample);
		let i = 0;
		for (const path of tree.ascending(tree.first())) {
			if (i % step === 0) {
				const row = tree.at(path);
				if (row) {
					const val = row[columnIndex];
					if (val !== null && val !== undefined) {
						values.push(val);
					}
				}
			}
			i++;
			if (values.length >= maxSample) break;
		}

		values.sort((a, b) => compareSqlValues(a, b));
		return values;
	}

	public connect(): MemoryTableConnection {
		const connection = new MemoryTableConnection(this, this._currentCommittedLayer);
		this.connections.set(connection.connectionId, connection);
		return connection;
	}

	public async disconnect(connectionId: number): Promise<void> {
		const connection = this.connections.get(connectionId);
		if (!connection) return;

		// If the connection still has an un-committed pending layer, defer
		// disconnect until the layer is either committed or rolled back by the
		// transaction coordinator.  This avoids accidental rollback during
		// implicit transactions.
		if (connection.pendingTransactionLayer && !connection.pendingTransactionLayer.isCommitted()) {
			logger.debugLog(`[Disconnect] Deferring disconnect of connection ${connectionId} while transaction pending for ${this._tableName}`);
			return;
		}

		// No pending changes – safe to remove immediately.
		this.connections.delete(connectionId);

		// Attempt fast layer-collapse in the background (best-effort)
		void this.tryCollapseLayers().catch(err => {
			logger.error('Disconnect', this._tableName, 'Layer collapse failed', err);
		});
	}

	public async commitTransaction(connection: MemoryTableConnection): Promise<void> {
		if (this.isReadOnly) {
			if (connection.pendingTransactionLayer && connection.pendingTransactionLayer.hasChanges()) {
				throw new QuereusError(`Table ${this._tableName} is read-only, cannot commit changes.`, StatusCode.READONLY);
			}
			connection.pendingTransactionLayer = null;
			connection.clearSavepoints();
			return;
		}
		const pendingLayer = connection.pendingTransactionLayer;
		if (!pendingLayer) return;

		// Capture changes before marking committed
		const changes = pendingLayer.getPendingChanges();

		const lockKey = `MemoryTable.Commit:${this.schemaName}.${this._tableName}`;
		const release = await Latches.acquire(lockKey);
		logger.debugLog(`[Commit ${connection.connectionId}] Acquired lock for ${this._tableName}`);
		try {
			// Walk up the parent chain to find if the current committed layer is an ancestor
			// This handles savepoint chains properly
			let currentParent: Layer | null = pendingLayer.getParent();
			let foundCommittedLayer = false;
			while (currentParent) {
				if (currentParent === this._currentCommittedLayer) {
					foundCommittedLayer = true;
					break;
				}
				currentParent = currentParent.getParent();
			}

			// Also check if the current committed layer and pending layer are siblings
			// (both children of the same parent) - this handles coordinated multi-connection commits
			if (!foundCommittedLayer) {
				const pendingParent = pendingLayer.getParent();
				let committedAncestor: Layer | null = this._currentCommittedLayer;
				while (committedAncestor) {
					if (committedAncestor === pendingParent) {
						foundCommittedLayer = true;
						break;
					}
					committedAncestor = committedAncestor.getParent();
				}
			}

			if (!foundCommittedLayer) {
				// During coordinated multi-connection commits (explicit COMMIT or implicit transaction commit),
				// sibling layers are allowed. Only enforce strict validation outside coordinated commits.
				if (!this.db._inCoordinatedCommit()) {
					connection.pendingTransactionLayer = null;
					connection.clearSavepoints();
					logger.warn('Commit Transaction', this._tableName, 'Stale commit detected, rolling back', { connectionId: connection.connectionId });
					throw new QuereusError(`Commit failed: concurrent update on table ${this._tableName}. Retry.`, StatusCode.BUSY);
				}
			}

			pendingLayer.markCommitted();
			this._currentCommittedLayer = pendingLayer;
			logger.debugLog(`[Commit ${connection.connectionId}] CurrentCommittedLayer set to ${pendingLayer.getLayerId()} for ${this._tableName}`);
			connection.readLayer = pendingLayer;
			connection.pendingTransactionLayer = null;
			connection.clearSavepoints();

			// Emit data change events after successful commit
			if (changes.length > 0 && this.eventEmitter?.emitDataChange) {
				for (const change of changes) {
					const event: import('../../events.js').VTableDataChangeEvent = {
						type: change.type,
						schemaName: this.schemaName,
						tableName: this._tableName,
						key: Array.isArray(change.pk) ? change.pk : [change.pk],
						oldRow: change.oldRow,
						newRow: change.newRow,
					};

					// Add changedColumns for update events
					if (change.type === 'update' && change.oldRow && change.newRow) {
						event.changedColumns = this.computeChangedColumns(change.oldRow, change.newRow);
					}

					this.eventEmitter.emitDataChange(event);
				}
			}
		} finally {
			release();
			logger.debugLog(`[Commit ${connection.connectionId}] Released lock for ${this._tableName}`);
		}
	}

	async tryCollapseLayers(): Promise<void> {
		const lockKey = `MemoryTable.Collapse:${this.schemaName}.${this._tableName}`;
		let release: (() => void) | null = null;
		try {
			const acquirePromise = Latches.acquire(lockKey);
			const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 10)); // Short timeout
			const result = await Promise.race([
				acquirePromise.then(releaseFn => ({ release: releaseFn })),
				timeoutPromise.then(() => ({ release: null }))
			]);
			release = result.release;
			if (!release) {
				logger.debugLog(`[Collapse] Lock busy for ${this._tableName}, skipping.`);
				return;
			}
			logger.debugLog(`[Collapse] Acquired lock for ${this._tableName}`);
			let collapsedCount = 0;
			const maxCollapseIterations = 10; // Prevent infinite loops
			let iterations = 0;

			// Continue collapsing layers as long as it's safe to do so
			while (iterations < maxCollapseIterations &&
			       this._currentCommittedLayer instanceof TransactionLayer &&
			       this._currentCommittedLayer.isCommitted()) {

				const layerToPromote = this._currentCommittedLayer as TransactionLayer;
				const parentLayer = layerToPromote.getParent();
				if (!parentLayer) {
					logger.error('Collapse Layers', this._tableName, 'Committed TransactionLayer has no parent', { layerId: layerToPromote.getLayerId() });
					break;
				}

				// Check if anyone is still using the parent layer or any of its ancestors
				if (this.isLayerInUse(parentLayer)) {
					logger.debugLog(`[Collapse] Parent layer ${parentLayer.getLayerId()} or its ancestors in use. Cannot collapse layer ${layerToPromote.getLayerId()}.`);
					break;
				}

				logger.debugLog(`[Collapse] Promoting layer ${layerToPromote.getLayerId()} to become independent from parent ${parentLayer.getLayerId()} for ${this._tableName}`);

				// With inherited BTrees, "collapsing" means making the transaction layer independent
				// by calling clearBase() on its BTrees, effectively making it the new base data
				layerToPromote.clearBase();

				// Update connections that were reading from the collapsed parent layer
				for (const conn of this.connections.values()) {
					if (conn.readLayer === parentLayer) {
						// Update connections to read from the now-independent transaction layer
						conn.readLayer = layerToPromote;
						logger.debugLog(`[Collapse] Connection ${conn.connectionId} updated to read from independent layer ${layerToPromote.getLayerId()}`);
					}
				}

				collapsedCount++;
				iterations++;

				// The layer is now independent, but check if we can collapse further
				// by examining if this layer can be promoted above its (now detached) parent
				logger.debugLog(`[Collapse] Layer ${layerToPromote.getLayerId()} is now independent for ${this._tableName}`);
			}

			// Trigger garbage collection of unreferenced layers
			if (collapsedCount > 0) {
				void this.cleanupUnreferencedLayers();
				logger.operation('Collapse Layers', this._tableName, { collapsedCount, iterations });
			} else {
				logger.debugLog(`[Collapse] No layers collapsed for ${this._tableName}. Current: ${this._currentCommittedLayer.getLayerId()}`);
			}
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} catch (e: any) {
			logger.error('Collapse Layers', this._tableName, e);
		} finally {
			if (release) {
				release();
				logger.debugLog(`[Collapse] Released lock for ${this._tableName}`);
			}
		}
	}

	/**
	 * Checks if a layer is currently in use by any connections.
	 * This includes checking if any connection is reading from the layer,
	 * has it as a pending transaction layer, or has it as a savepoint.
	 */
	private isLayerInUse(layer: Layer): boolean {
		for (const conn of this.connections.values()) {
			// Check if connection is reading from this layer
			if (conn.readLayer === layer) {
				return true;
			}

			// Check if connection has this layer as pending transaction
			if (conn.pendingTransactionLayer === layer) {
				return true;
			}

			// Check if connection has this layer in its parent chain
			let currentLayer = conn.pendingTransactionLayer?.getParent();
			while (currentLayer) {
				if (currentLayer === layer) {
					return true;
				}
				if (currentLayer instanceof TransactionLayer) {
					currentLayer = currentLayer.getParent();
				} else {
					break;
				}
			}
		}
		return false;
	}

	/**
	 * Performs garbage collection of layers that are no longer referenced
	 * by any connections or the current committed layer chain.
	 */
	private cleanupUnreferencedLayers(): void {
		// For now, this is a no-op since JavaScript's garbage collector
		// will handle cleanup of unreferenced objects automatically.
		// In the future, we could implement more aggressive cleanup
		// or tracking of layer references for memory monitoring.
		logger.debugLog(`[Cleanup] Triggering garbage collection hint for ${this._tableName}`);

		// Optional: Force garbage collection if available (Node.js with --expose-gc)
		if (typeof global !== 'undefined' && global.gc) {
			try {
				global.gc();
			} catch {
				// Ignore errors - gc() might not be available
			}
		}
	}

	// With inherited BTrees, lookupEffectiveRow is much simpler
	public lookupEffectiveRow(primaryKey: BTreeKeyForPrimary, startLayer: Layer): Row | null {
		// With inherited BTrees, a simple get() will traverse the inheritance chain automatically
		const primaryTree = startLayer.getModificationTree('primary');
		if (!primaryTree) return null;

		const result = primaryTree.get(primaryKey);
		return result === undefined ? null : result as Row;
	}

	// Simplified for compatibility, though less relevant with inherited BTrees
	lookupEffectiveValue(key: BTreeKeyForPrimary, indexName: string | 'primary', startLayer: Layer): Row | null {
		if (indexName !== 'primary') {
			logger.error('lookupEffectiveValue', this._tableName, 'Currently only supports primary index for MemoryTableManager');
			return null;
		}
		const primaryTree = startLayer.getModificationTree('primary');
		if (!primaryTree) return null;

		const result = primaryTree.get(key);
		return result === undefined ? null : result;
	}

	public async performMutation(
		connection: MemoryTableConnection,
		operation: 'insert' | 'update' | 'delete',
		values: Row | undefined,
		oldKeyValues?: Row,
		onConflict: ConflictResolution = ConflictResolution.ABORT
	): Promise<UpdateResult> {
		this.validateMutationPermissions(operation);

		const wasExplicitTransaction = connection.explicitTransaction;
		this.ensureTransactionLayer(connection);

		const targetLayer = connection.pendingTransactionLayer!;

		let result: UpdateResult;

		switch (operation) {
			case 'insert':
				result = await this.performInsert(targetLayer, values, onConflict);
				break;
			case 'update':
				result = await this.performUpdate(targetLayer, values, oldKeyValues, onConflict);
				break;
			case 'delete':
				result = await this.performDelete(targetLayer, oldKeyValues);
				break;
			default: {
				const exhaustiveCheck: never = operation;
				throw new QuereusError(`Unsupported operation: ${exhaustiveCheck}`, StatusCode.INTERNAL);
			}
		}

		// Auto-commit if we weren't already in an explicit transaction
		// Note: We commit even on constraint violations when IGNORE mode, as the row was simply skipped
		if (!wasExplicitTransaction && this.db.getAutocommit()) {
			await this.commitTransaction(connection);
		}

		return result;
	}

	private validateMutationPermissions(_operation: 'insert' | 'update' | 'delete'): void {
		if (this.isReadOnly) {
			throw new QuereusError(`Table '${this._tableName}' is read-only`, StatusCode.READONLY);
		}
	}

	private ensureTransactionLayer(connection: MemoryTableConnection): void {
		if (!connection.pendingTransactionLayer) {
			// Lazily create a new TransactionLayer based on the current committed layer
			connection.pendingTransactionLayer = new TransactionLayer(this._currentCommittedLayer);

			// Enable change tracking if there are data listeners
			if (this.eventEmitter?.hasDataListeners?.()) {
				connection.pendingTransactionLayer.enableChangeTracking();
			}

			// If this method is called from a DML statement outside an explicit BEGIN, the
			// transaction is auto-created (autocommit mode).  Leave explicitTransaction flag as-is.
		}
	}

	private async performInsert(
		targetLayer: TransactionLayer,
		values: Row | undefined,
		onConflict: ConflictResolution
	): Promise<UpdateResult> {
		if (!values) {
			throw new QuereusError("INSERT requires values.", StatusCode.MISUSE);
		}

		// Validate and parse values according to column types
		const schema = targetLayer.getSchema();
		const validatedRow: Row = values.map((value, index) => {
			if (index >= schema.columns.length) {
				throw new QuereusError(
					`Too many values for INSERT into ${this._tableName}: expected ${schema.columns.length}, got ${values.length}`,
					StatusCode.ERROR
				);
			}
			const column = schema.columns[index];
			return validateAndParse(value, column.logicalType, column.name);
		});

		const newRowData: Row = validatedRow;
		const primaryKey = this.primaryKeyFromRow(newRowData);
		const existingRow = this.lookupEffectiveRow(primaryKey, targetLayer);

		if (existingRow !== null) {
			if (onConflict === ConflictResolution.IGNORE) {
				return { status: 'ok', row: undefined };
			}
			if (onConflict === ConflictResolution.REPLACE) {
				targetLayer.recordUpsert(primaryKey, newRowData, existingRow);
				return { status: 'ok', row: newRowData, replacedRow: existingRow };
			}
			return {
				status: 'constraint',
				constraint: 'unique',
				message: `UNIQUE constraint failed: ${this._tableName} PK.`,
				existingRow: existingRow
			};
		}

		// Check UNIQUE constraints against secondary indexes
		const ucResult = this.checkUniqueConstraints(targetLayer, schema, newRowData, primaryKey, onConflict);
		if (ucResult) return ucResult;

		targetLayer.recordUpsert(primaryKey, newRowData, null);
		return { status: 'ok', row: newRowData };
	}

	private async performUpdate(
		targetLayer: TransactionLayer,
		values: Row | undefined,
		oldKeyValues: Row | undefined,
		onConflict: ConflictResolution
	): Promise<UpdateResult> {
		if (!values || !oldKeyValues) {
			throw new QuereusError("UPDATE requires new values and old key values.", StatusCode.MISUSE);
		}

		// Validate and parse values according to column types
		const schema = targetLayer.getSchema();
		const validatedRow: Row = values.map((value, index) => {
			if (index >= schema.columns.length) {
				throw new QuereusError(
					`Too many values for UPDATE on ${this._tableName}: expected ${schema.columns.length}, got ${values.length}`,
					StatusCode.ERROR
				);
			}
			const column = schema.columns[index];
			return validateAndParse(value, column.logicalType, column.name);
		});

		const newRowData: Row = validatedRow;
		const targetPrimaryKey = buildPrimaryKeyFromValues(oldKeyValues, schema.primaryKeyDefinition);
		const oldRowData = this.lookupEffectiveRow(targetPrimaryKey, targetLayer);

		if (!oldRowData) {
			if (onConflict === ConflictResolution.IGNORE) {
				return { status: 'ok', row: undefined };
			}
			logger.warn('UPDATE', this._tableName, 'Target row not found', {
				primaryKey: oldKeyValues.join(',')
			});
			return { status: 'ok', row: undefined };
		}

		const newPrimaryKey = this.primaryKeyFromRow(newRowData);
		const isPrimaryKeyChanged = this.comparePrimaryKeys(targetPrimaryKey, newPrimaryKey) !== 0;

		if (isPrimaryKeyChanged) {
			return this.performUpdateWithPrimaryKeyChange(targetLayer, schema, targetPrimaryKey, newPrimaryKey, oldRowData, newRowData, onConflict);
		} else {
			// Check UNIQUE constraints if any constrained columns changed
			if (this.uniqueColumnsChanged(schema, oldRowData, newRowData)) {
				const ucResult = this.checkUniqueConstraints(targetLayer, schema, newRowData, targetPrimaryKey, onConflict);
				if (ucResult) return ucResult;
			}
			targetLayer.recordUpsert(targetPrimaryKey, newRowData, oldRowData);
			return { status: 'ok', row: newRowData };
		}
	}

	private performUpdateWithPrimaryKeyChange(
		targetLayer: TransactionLayer,
		schema: TableSchema,
		oldPrimaryKey: BTreeKeyForPrimary,
		newPrimaryKey: BTreeKeyForPrimary,
		oldRowData: Row,
		newRowData: Row,
		onConflict: ConflictResolution
	): UpdateResult {
		const existingRowAtNewKey = this.lookupEffectiveRow(newPrimaryKey, targetLayer);

		if (existingRowAtNewKey !== null) {
			if (onConflict === ConflictResolution.IGNORE) {
				return { status: 'ok', row: undefined };
			}
			// Return constraint violation with existing row
			return {
				status: 'constraint',
				constraint: 'unique',
				message: `UNIQUE constraint failed on new PK for ${this._tableName}.`,
				existingRow: existingRowAtNewKey
			};
		}

		// Delete old row first, then check UNIQUE constraints at the new position
		targetLayer.recordDelete(oldPrimaryKey, oldRowData);

		const ucResult = this.checkUniqueConstraints(targetLayer, schema, newRowData, newPrimaryKey, onConflict);
		if (ucResult) {
			// Rollback the delete if constraint check fails
			targetLayer.recordUpsert(oldPrimaryKey, oldRowData, null);
			return ucResult;
		}

		targetLayer.recordUpsert(newPrimaryKey, newRowData, null);
		return { status: 'ok', row: newRowData };
	}

	private async performDelete(
		targetLayer: TransactionLayer,
		oldKeyValues: Row | undefined
	): Promise<UpdateResult> {
		if (!oldKeyValues) {
			throw new QuereusError("DELETE requires key values.", StatusCode.MISUSE);
		}

		const schema = targetLayer.getSchema();
		const targetPrimaryKey = buildPrimaryKeyFromValues(oldKeyValues, schema.primaryKeyDefinition);
		const oldRowData = this.lookupEffectiveRow(targetPrimaryKey, targetLayer);

		if (!oldRowData) {
			return { status: 'ok', row: undefined };
		}

		targetLayer.recordDelete(targetPrimaryKey, oldRowData);
		return { status: 'ok', row: oldRowData };
	}

	/** Returns true if any column covered by a UNIQUE constraint changed between old and new rows. */
	private uniqueColumnsChanged(schema: TableSchema, oldRow: Row, newRow: Row): boolean {
		if (!schema.uniqueConstraints) return false;
		for (const uc of schema.uniqueConstraints) {
			for (const colIdx of uc.columns) {
				if (compareSqlValues(oldRow[colIdx], newRow[colIdx]) !== 0) return true;
			}
		}
		return false;
	}

	/**
	 * Checks all UNIQUE constraints for a new/updated row. Returns an UpdateResult
	 * if a violation is found (or IGNORE suppresses the insert), or null if all pass.
	 * For REPLACE conflicts, the conflicting rows are deleted from the layer.
	 */
	private checkUniqueConstraints(
		targetLayer: TransactionLayer,
		schema: TableSchema,
		newRowData: Row,
		newPrimaryKey: BTreeKeyForPrimary,
		onConflict: ConflictResolution
	): UpdateResult | null {
		if (!schema.uniqueConstraints) return null;

		for (const uc of schema.uniqueConstraints) {
			const result = this.checkSingleUniqueConstraint(
				targetLayer, schema, uc, newRowData, newPrimaryKey, onConflict
			);
			if (result) return result;
		}

		return null;
	}

	private checkSingleUniqueConstraint(
		targetLayer: TransactionLayer,
		schema: TableSchema,
		uc: UniqueConstraintSchema,
		newRowData: Row,
		newPrimaryKey: BTreeKeyForPrimary,
		onConflict: ConflictResolution
	): UpdateResult | null {
		// SQL semantics: UNIQUE allows multiple NULLs — skip if any constrained column is NULL
		if (uc.columns.some(colIdx => newRowData[colIdx] === null)) return null;

		// Find the matching secondary index for this constraint
		const index = this.findIndexForConstraint(targetLayer, uc);
		if (index) {
			return this.checkUniqueViaIndex(targetLayer, schema, uc, index, newRowData, newPrimaryKey, onConflict);
		}

		// Fallback: scan primary tree
		return this.checkUniqueByScanning(targetLayer, schema, uc, newRowData, newPrimaryKey, onConflict);
	}

	private findIndexForConstraint(
		targetLayer: Layer,
		uc: UniqueConstraintSchema
	): import('../index.js').MemoryIndex | undefined {
		const schema = targetLayer.getSchema();
		if (!schema.indexes) return undefined;

		for (const idx of schema.indexes) {
			if (idx.columns.length === uc.columns.length &&
				idx.columns.every((col, i) => col.index === uc.columns[i])) {
				return targetLayer.getSecondaryIndex?.(idx.name);
			}
		}
		return undefined;
	}

	private checkUniqueViaIndex(
		targetLayer: TransactionLayer,
		schema: TableSchema,
		uc: UniqueConstraintSchema,
		index: import('../index.js').MemoryIndex,
		newRowData: Row,
		newPrimaryKey: BTreeKeyForPrimary,
		onConflict: ConflictResolution
	): UpdateResult | null {
		const indexKey = index.keyFromRow(newRowData);
		const existingPKs = index.getPrimaryKeys(indexKey);

		for (const existingPK of existingPKs) {
			if (this.comparePrimaryKeys(newPrimaryKey, existingPK) === 0) continue;

			// Found a different row with the same unique key values
			if (onConflict === ConflictResolution.IGNORE) {
				return { status: 'ok', row: undefined };
			}
			if (onConflict === ConflictResolution.REPLACE) {
				const conflictingRow = this.lookupEffectiveRow(existingPK, targetLayer);
				if (conflictingRow) {
					targetLayer.recordDelete(existingPK, conflictingRow);
				}
				return null; // Conflict resolved, continue with insert
			}
			const colNames = uc.columns.map(i => schema.columns[i].name).join(', ');
			const existingRow = this.lookupEffectiveRow(existingPK, targetLayer);
			return {
				status: 'constraint',
				constraint: 'unique',
				message: `UNIQUE constraint failed: ${this._tableName} (${colNames})`,
				existingRow: existingRow ?? undefined
			};
		}

		return null;
	}

	private checkUniqueByScanning(
		targetLayer: TransactionLayer,
		schema: TableSchema,
		uc: UniqueConstraintSchema,
		newRowData: Row,
		newPrimaryKey: BTreeKeyForPrimary,
		onConflict: ConflictResolution
	): UpdateResult | null {
		const primaryTree = targetLayer.getModificationTree('primary');
		if (!primaryTree) return null;

		for (const path of primaryTree.ascending(primaryTree.first())) {
			const existingRow = primaryTree.at(path)!;
			const existingPK = this.primaryKeyFromRow(existingRow);
			if (this.comparePrimaryKeys(newPrimaryKey, existingPK) === 0) continue;

			const allMatch = uc.columns.every(
				colIdx => compareSqlValues(newRowData[colIdx], existingRow[colIdx]) === 0
			);
			if (!allMatch) continue;

			if (onConflict === ConflictResolution.IGNORE) {
				return { status: 'ok', row: undefined };
			}
			if (onConflict === ConflictResolution.REPLACE) {
				targetLayer.recordDelete(existingPK, existingRow);
				return null;
			}
			const colNames = uc.columns.map(i => schema.columns[i].name).join(', ');
			return {
				status: 'constraint',
				constraint: 'unique',
				message: `UNIQUE constraint failed: ${this._tableName} (${colNames})`,
				existingRow: existingRow
			};
		}

		return null;
	}

	public renameTable(newName: string): void {
		logger.operation('Rename Table', this._tableName, { newName });
		this._tableName = newName;
		const renamed = Object.freeze({ ...this.tableSchema, name: newName });
		this.tableSchema = renamed;
		this.baseLayer.tableSchema = renamed;

		// Emit schema change event
		this.eventEmitter?.emitSchemaChange?.({
			type: 'alter',
			objectType: 'table',
			schemaName: this.schemaName,
			objectName: newName,
		});
	}

	/** Iterates all committed rows from the current committed layer (for rebuild). */
	scanAllRows(): Row[] {
		const tree = this._currentCommittedLayer.getModificationTree('primary');
		if (!tree) return [];
		const rows: Row[] = [];
		for (const path of tree.ascending(tree.first())) {
			rows.push(tree.at(path)!);
		}
		return rows;
	}

	/** Inserts a row directly into the base layer (for rebuild, bypasses transaction).
	 *  Throws on duplicate primary key. */
	insertRow(row: Row): void {
		const key = this.primaryKeyFunctions.extractFromRow(row);
		const path = this.baseLayer.primaryTree.find(key);
		if (path.on) {
			throw new QuereusError(
				`UNIQUE constraint failed: ${this._tableName} PK.`,
				StatusCode.CONSTRAINT,
			);
		}
		this.baseLayer.primaryTree.insert(row);
	}

	// --- Schema Operations (simplified with inherited BTrees) ---
	async addColumn(columnDefAst: ASTColumnDef): Promise<void> {
		if (this.isReadOnly) throw new QuereusError(`Table '${this._tableName}' is read-only`, StatusCode.READONLY);
		const lockKey = `MemoryTable.SchemaChange:${this.schemaName}.${this._tableName}`;
		const release = await Latches.acquire(lockKey);
		const originalManagerSchema = this.tableSchema;
		try {
			await this.ensureSchemaChangeSafety();

			// Get default nullability setting from database options
			const defaultNullability = this.db.options.getStringOption('default_column_nullability');
			const defaultNotNull = defaultNullability === 'not_null';

			const newColumnSchema = columnDefToSchema(columnDefAst, defaultNotNull);
			if (this.tableSchema.columns.some(c => c.name.toLowerCase() === newColumnSchema.name.toLowerCase())) {
				throw new QuereusError(`Duplicate column name: ${newColumnSchema.name}`, StatusCode.ERROR);
			}
			let defaultValue: SqlValue = null;
			const defaultConstraint = columnDefAst.constraints.find(c => c.type === 'default');
			if (defaultConstraint && defaultConstraint.expr) {
				if (defaultConstraint.expr.type === 'literal') {
					defaultValue = getSyncLiteral(defaultConstraint.expr as LiteralExpr);
				} else {
					logger.warn('Add Column', this._tableName, 'Default for new col is expr; existing rows get NULL.', { columnName: newColumnSchema.name });
				}
			}
			// Check for NOT NULL constraint (could be explicit or from default behavior)
			// Allow NOT NULL without DEFAULT if table is empty (SQLite-compatible)
			const tableHasRows = this.baseLayer.primaryTree.at(this.baseLayer.primaryTree.first()) !== undefined;
			if (newColumnSchema.notNull && defaultValue === null && !(defaultConstraint?.expr?.type ==='literal') && tableHasRows) {
				throw new QuereusError(
					`Cannot add NOT NULL column '${newColumnSchema.name}' to non-empty table `
						+ `'${this.schemaName}.${this._tableName}' without a DEFAULT value`,
					StatusCode.CONSTRAINT,
				);
			}
			const updatedColumnsSchema: ReadonlyArray<ColumnSchema> = Object.freeze([...this.tableSchema.columns, newColumnSchema]);
			const finalNewTableSchema: TableSchema = Object.freeze({
				...this.tableSchema,
				columns: updatedColumnsSchema,
				columnIndexMap: buildColumnIndexMap(updatedColumnsSchema),
			});
			this.baseLayer.updateSchema(finalNewTableSchema);
			await this.baseLayer.addColumnToBase(newColumnSchema, defaultValue);
			this.tableSchema = finalNewTableSchema;
			this.initializePrimaryKeyFunctions();

			// Emit schema change event
			this.eventEmitter?.emitSchemaChange?.({
				type: 'alter',
				objectType: 'column',
				schemaName: this.schemaName,
				objectName: this._tableName,
				columnName: newColumnSchema.name,
			});

			logger.operation('Add Column', this._tableName, { columnName: newColumnSchema.name });
		} catch (e: unknown) {
			this.baseLayer.updateSchema(originalManagerSchema);
			this.tableSchema = originalManagerSchema;
			this.initializePrimaryKeyFunctions();
			logger.error('Add Column', this._tableName, e);
			throw e;
		} finally {
			release();
		}
	}

	async dropColumn(columnName: string): Promise<void> {
		if (this.isReadOnly) throw new QuereusError(`Table '${this._tableName}' is read-only`, StatusCode.READONLY);
		const lockKey = `MemoryTable.SchemaChange:${this.schemaName}.${this._tableName}`;
		const release = await Latches.acquire(lockKey);
		const originalManagerSchema = this.tableSchema;
		try {
			await this.ensureSchemaChangeSafety();
			const oldNameLower = columnName.toLowerCase();
			const colIndex = this.tableSchema.columns.findIndex(c => c.name.toLowerCase() === oldNameLower);
			if (colIndex === -1) throw new QuereusError(`Column '${columnName}' not found.`, StatusCode.ERROR);
			if (this.tableSchema.primaryKeyDefinition.some(def => def.index === colIndex)) {
				throw new QuereusError(`Cannot drop PK column "${columnName}".`, StatusCode.CONSTRAINT);
			}

			const updatedColumnsSchema = this.tableSchema.columns.filter((_, idx) => idx !== colIndex);
			const updatedPkDefinition = this.tableSchema.primaryKeyDefinition.map(def => ({
				...def, index: def.index > colIndex ? def.index - 1 : def.index
			}));
			const updatedPrimaryKeyNames = updatedPkDefinition.map(def => updatedColumnsSchema[def.index]?.name).filter(Boolean) as string[];

			const updatedIndexes = (this.tableSchema.indexes || []).map(idx => ({
				...idx,
				columns: idx.columns
					.map(ic => ({ ...ic, index: ic.index > colIndex ? ic.index - 1 : ic.index }))
					.filter(ic => ic.index !== colIndex)
			})).filter(idx => idx.columns.length > 0);

			const finalNewTableSchema: TableSchema = Object.freeze({
				...this.tableSchema,
				columns: Object.freeze(updatedColumnsSchema),
				columnIndexMap: buildColumnIndexMap(updatedColumnsSchema),
				primaryKeyDefinition: Object.freeze(updatedPkDefinition),
				primaryKey: Object.freeze(updatedPrimaryKeyNames),
				indexes: Object.freeze(updatedIndexes)
			});

			this.baseLayer.updateSchema(finalNewTableSchema);
			await this.baseLayer.dropColumnFromBase(colIndex);
			this.tableSchema = finalNewTableSchema;
			this.initializePrimaryKeyFunctions();

			// Emit schema change event
			this.eventEmitter?.emitSchemaChange?.({
				type: 'drop',
				objectType: 'column',
				schemaName: this.schemaName,
				objectName: this._tableName,
				columnName,
			});

			logger.operation('Drop Column', this._tableName, { columnName });
		} catch (e: unknown) {
			this.baseLayer.updateSchema(originalManagerSchema);
			this.tableSchema = originalManagerSchema;
			this.initializePrimaryKeyFunctions();
			logger.error('Drop Column', this._tableName, e);
			throw e;
		} finally {
			release();
		}
	}

	async renameColumn(oldName: string, newColumnDefAst: ASTColumnDef): Promise<void> {
		if (this.isReadOnly) throw new QuereusError(`Table '${this._tableName}' is read-only`, StatusCode.READONLY);
		const lockKey = `MemoryTable.SchemaChange:${this.schemaName}.${this._tableName}`;
		const release = await Latches.acquire(lockKey);
		const originalManagerSchema = this.tableSchema;
		try {
			await this.ensureSchemaChangeSafety();
			const oldNameLower = oldName.toLowerCase();
			const newColumnName = newColumnDefAst.name;
			const newNameLower = newColumnName.toLowerCase();
			const colIndex = this.tableSchema.columns.findIndex(c => c.name.toLowerCase() === oldNameLower);
			if (colIndex === -1) throw new QuereusError(`Column '${oldName}' not found.`, StatusCode.ERROR);
			if (oldNameLower !== newNameLower && this.tableSchema.columns.some((c, i) => i !== colIndex && c.name.toLowerCase() === newNameLower)) {
				throw new QuereusError(`Target name '${newColumnName}' already exists.`, StatusCode.ERROR);
			}

			// Get default nullability setting from database options
			const defaultNullability = this.db.options.getStringOption('default_column_nullability');
			const defaultNotNull = defaultNullability === 'not_null';

			const newColumnSchemaAtIndex = columnDefToSchema(newColumnDefAst, defaultNotNull);
			const updatedCols = this.tableSchema.columns.map((c, i) => i === colIndex ? newColumnSchemaAtIndex : c);
			const updatedIndexes = (this.tableSchema.indexes || []).map(idx => ({
				...idx,
				columns: idx.columns.map(ic =>
					ic.index === colIndex ? { ...ic, name: newColumnName } : ic
				)
			}));

			const finalNewTableSchema: TableSchema = Object.freeze({
				...this.tableSchema,
				columns: Object.freeze(updatedCols),
				columnIndexMap: buildColumnIndexMap(updatedCols),
				primaryKeyDefinition: Object.freeze(this.tableSchema.primaryKeyDefinition),
				indexes: Object.freeze(updatedIndexes),
			});

			this.baseLayer.updateSchema(finalNewTableSchema);
			await this.baseLayer.handleColumnRename();
			this.tableSchema = finalNewTableSchema;
			this.initializePrimaryKeyFunctions();

			// Emit schema change event
			this.eventEmitter?.emitSchemaChange?.({
				type: 'alter',
				objectType: 'column',
				schemaName: this.schemaName,
				objectName: this._tableName,
				columnName: newColumnName,
				oldColumnName: oldName,
			});

			logger.operation('Rename Column', this._tableName, { oldName, newName: newColumnName });
		} catch (e: unknown) {
			this.baseLayer.updateSchema(originalManagerSchema);
			this.tableSchema = originalManagerSchema;
			this.initializePrimaryKeyFunctions();
			logger.error('Rename Column', this._tableName, e);
			throw e;
		} finally {
			release();
		}
	}

	/**
	 * Apply a single-attribute ALTER COLUMN change (NOT NULL, DEFAULT, DATA TYPE).
	 * The caller supplies exactly one populated change; multi-attribute combinations
	 * are rejected by the runtime before reaching this method.
	 */
	async alterColumn(change: {
		columnName: string;
		setNotNull?: boolean;
		setDataType?: string;
		setDefault?: Expression | null;
	}): Promise<void> {
		if (this.isReadOnly) throw new QuereusError(`Table '${this._tableName}' is read-only`, StatusCode.READONLY);
		const lockKey = `MemoryTable.SchemaChange:${this.schemaName}.${this._tableName}`;
		const release = await Latches.acquire(lockKey);
		const originalManagerSchema = this.tableSchema;
		try {
			await this.ensureSchemaChangeSafety();

			const colNameLower = change.columnName.toLowerCase();
			const colIndex = this.tableSchema.columns.findIndex(c => c.name.toLowerCase() === colNameLower);
			if (colIndex === -1) {
				throw new QuereusError(`Column '${change.columnName}' not found.`, StatusCode.ERROR);
			}
			const oldCol = this.tableSchema.columns[colIndex];
			let newCol: ColumnSchema = oldCol;

			if (change.setNotNull !== undefined) {
				if (change.setNotNull === true && !oldCol.notNull) {
					// Tightening: scan for NULLs. If DEFAULT present, backfill first.
					const defaultExpr = oldCol.defaultValue;
					let defaultLiteral: SqlValue | undefined;
					if (defaultExpr && defaultExpr.type === 'literal') {
						defaultLiteral = getSyncLiteral(defaultExpr as LiteralExpr);
					}

					const tree = this.baseLayer.primaryTree;
					const nullRows: Row[] = [];
					for (const path of tree.ascending(tree.first())) {
						const row = tree.at(path)!;
						if (row[colIndex] === null) nullRows.push(row);
					}

					if (nullRows.length > 0) {
						if (defaultLiteral === undefined || defaultLiteral === null) {
							throw new QuereusError(
								`column ${change.columnName} contains NULL values`,
								StatusCode.CONSTRAINT,
							);
						}
						// Backfill NULLs with the default literal.
						for (const row of nullRows) {
							const newRow: Row = row.map((v, i) => i === colIndex ? defaultLiteral! : v) as Row;
							// replace in-place: same PK, mutate row array. BTree keys by PK extraction,
							// so overwriting the value at the same key is sufficient.
							tree.insert(newRow);
						}
					}

					newCol = { ...oldCol, notNull: true };
				} else if (change.setNotNull === false && oldCol.notNull) {
					if (this.tableSchema.primaryKeyDefinition.some(def => def.index === colIndex)) {
						throw new QuereusError(
							`Cannot DROP NOT NULL on PRIMARY KEY column '${change.columnName}'`,
							StatusCode.CONSTRAINT,
						);
					}
					newCol = { ...oldCol, notNull: false };
				} else {
					// No-op (already in desired state).
					return;
				}
			} else if (change.setDataType !== undefined) {
				const newLogicalType = inferType(change.setDataType);
				if (newLogicalType.physicalType === oldCol.logicalType.physicalType) {
					newCol = { ...oldCol, logicalType: newLogicalType };
				} else {
					// Physical conversion required. Iterate rows and convert.
					const tree = this.baseLayer.primaryTree;
					const toConvert: Array<{ path: ReturnType<typeof tree.first>, row: Row }> = [];
					for (const path of tree.ascending(tree.first())) {
						const row = tree.at(path)!;
						toConvert.push({ path, row });
					}
					for (const { row } of toConvert) {
						const oldVal = row[colIndex];
						if (oldVal === null) continue;
						let newVal: SqlValue;
						try {
							newVal = validateAndParse(oldVal, newLogicalType, change.columnName) as SqlValue;
						} catch {
							throw new QuereusError(
								`Cannot convert value in '${change.columnName}' to ${change.setDataType}`,
								StatusCode.MISMATCH,
							);
						}
						const newRow: Row = row.map((v, i) => i === colIndex ? newVal : v) as Row;
						tree.insert(newRow);
					}
					newCol = { ...oldCol, logicalType: newLogicalType };
				}
			} else if (change.setDefault !== undefined) {
				newCol = { ...oldCol, defaultValue: change.setDefault };
			} else {
				throw new QuereusError('ALTER COLUMN requires an attribute to change', StatusCode.INTERNAL);
			}

			const updatedCols = this.tableSchema.columns.map((c, i) => i === colIndex ? newCol : c);
			const finalNewTableSchema: TableSchema = Object.freeze({
				...this.tableSchema,
				columns: Object.freeze(updatedCols),
				columnIndexMap: buildColumnIndexMap(updatedCols),
			});

			this.baseLayer.updateSchema(finalNewTableSchema);
			this.tableSchema = finalNewTableSchema;
			this.initializePrimaryKeyFunctions();

			this.eventEmitter?.emitSchemaChange?.({
				type: 'alter',
				objectType: 'column',
				schemaName: this.schemaName,
				objectName: this._tableName,
				columnName: change.columnName,
			});

			logger.operation('Alter Column', this._tableName, { columnName: change.columnName });
		} catch (e: unknown) {
			this.baseLayer.updateSchema(originalManagerSchema);
			this.tableSchema = originalManagerSchema;
			this.initializePrimaryKeyFunctions();
			logger.error('Alter Column', this._tableName, e);
			throw e;
		} finally {
			release();
		}
	}

	async createIndex(newIndexSchemaEntry: IndexSchema, ifNotExistsFromAst?: boolean): Promise<void> {
		if (this.isReadOnly) throw new QuereusError(`Table '${this._tableName}' is read-only`, StatusCode.READONLY);
		const lockKey = `MemoryTable.SchemaChange:${this.schemaName}.${this._tableName}`;
		const release = await Latches.acquire(lockKey);
		const originalManagerSchema = this.tableSchema;
		try {
			await this.ensureSchemaChangeSafety();

			const indexName = newIndexSchemaEntry.name;
			if (this.tableSchema.indexes?.some(idx => idx.name.toLowerCase() === indexName.toLowerCase())) {
				if (!ifNotExistsFromAst) {
					throw new QuereusError(`Index '${indexName}' already exists on table '${this._tableName}'.`, StatusCode.ERROR);
				}
				logger.operation('Create Index', this._tableName, 'Index already exists, IF NOT EXISTS specified. Skipping creation.');
				return;
			}

			for (const iCol of newIndexSchemaEntry.columns) {
				if (iCol.index < 0 || iCol.index >= this.tableSchema.columns.length) {
					throw new QuereusError(`Column index ${iCol.index} for index '${indexName}' is out of bounds for table '${this._tableName}'.`, StatusCode.ERROR);
				}
			}

			const updatedIndexes = Object.freeze([...(this.tableSchema.indexes || []), newIndexSchemaEntry]);
			let updatedUniqueConstraints = this.tableSchema.uniqueConstraints;
			if (newIndexSchemaEntry.unique) {
				const newConstraint = {
					name: newIndexSchemaEntry.name,
					columns: Object.freeze(newIndexSchemaEntry.columns.map(c => c.index)),
				};
				updatedUniqueConstraints = Object.freeze([
					...(this.tableSchema.uniqueConstraints ?? []),
					newConstraint
				]);
			}
			const finalNewTableSchema: TableSchema = Object.freeze({
				...this.tableSchema,
				indexes: updatedIndexes,
				uniqueConstraints: updatedUniqueConstraints,
			});

			this.baseLayer.updateSchema(finalNewTableSchema);
			await this.baseLayer.addIndexToBase(newIndexSchemaEntry);

			this.tableSchema = finalNewTableSchema;

			// Emit schema change event
			this.eventEmitter?.emitSchemaChange?.({
				type: 'create',
				objectType: 'index',
				schemaName: this.schemaName,
				objectName: indexName,
			});

			logger.operation('Create Index', this._tableName, { indexName });
		} catch (e: unknown) {
			this.baseLayer.updateSchema(originalManagerSchema);
			this.tableSchema = originalManagerSchema;
			logger.error('Create Index', this._tableName, e);
			throw e;
		} finally {
			release();
		}
	}

	async dropIndex(indexName: string, ifExists?: boolean): Promise<void> {
		if (this.isReadOnly) throw new QuereusError(`Table '${this._tableName}' is read-only`, StatusCode.READONLY);
		const lockKey = `MemoryTable.SchemaChange:${this.schemaName}.${this._tableName}`;
		const release = await Latches.acquire(lockKey);
		const originalManagerSchema = this.tableSchema;
		try {
			await this.ensureSchemaChangeSafety();
			const indexNameLower = indexName.toLowerCase();
			const indexExists = this.tableSchema.indexes?.some(idx => idx.name.toLowerCase() === indexNameLower);
			if (!indexExists) {
				if (ifExists) {
					logger.operation('Drop Index', this._tableName, 'Index not on table, IF EXISTS. Skipping.');
					return;
				}
				throw new QuereusError(`Index '${indexName}' not on table '${this._tableName}'.`, StatusCode.ERROR);
			}
			const finalNewTableSchema: TableSchema = Object.freeze({
				...this.tableSchema,
				indexes: Object.freeze((this.tableSchema.indexes || []).filter(idx => idx.name.toLowerCase() !== indexNameLower))
			});
			this.baseLayer.updateSchema(finalNewTableSchema);
			await this.baseLayer.dropIndexFromBase(indexName);
			this.tableSchema = finalNewTableSchema;

			// Emit schema change event
			this.eventEmitter?.emitSchemaChange?.({
				type: 'drop',
				objectType: 'index',
				schemaName: this.schemaName,
				objectName: indexName,
			});

			logger.operation('Drop Index', this._tableName, { indexName });
		} catch (e: unknown) {
			this.baseLayer.updateSchema(originalManagerSchema);
			this.tableSchema = originalManagerSchema;
			logger.error('Drop Index', this._tableName, e);
			throw e;
		} finally {
			release();
		}
	}

	public async destroy(): Promise<void> {
		const lockKey = `MemoryTable.Destroy:${this.schemaName}.${this._tableName}`;
		const release = await Latches.acquire(lockKey);
		try {
			for (const connection of this.connections.values()) {
				if (connection.pendingTransactionLayer) connection.rollback();
			}
			this.connections.clear();
			this.baseLayer = new BaseLayer(this.tableSchema);
			this._currentCommittedLayer = this.baseLayer;
			logger.operation('Destroy', this._tableName, 'Manager destroyed and data cleared');
		} finally {
			release();
		}
	}

	private async ensureSchemaChangeSafety(): Promise<void> {
		if (this._currentCommittedLayer !== this.baseLayer) {
			logger.warn('Schema Change', this._tableName, 'Transaction layers exist. Attempting to consolidate to base...');

			// For schema changes, we need to consolidate all data into the base layer
			// instead of just promoting layers
			await this.consolidateToBaseLayer();

			if (this._currentCommittedLayer !== this.baseLayer) {
				throw new QuereusError(
					`Cannot perform schema change on table ${this._tableName} while older transaction versions are in use by active connections. Commit/rollback active transactions and retry.`,
					StatusCode.BUSY
				);
			}
		}

		// After ensuring we're at the base layer, update all connections to read from the base layer
		// This is necessary because connections might still be reading from promoted/collapsed layers
		for (const connection of this.connections.values()) {
			if (connection.readLayer !== this.baseLayer) {
				logger.debugLog(`[Schema Safety] Updating connection ${connection.connectionId} to read from base layer`);
				connection.readLayer = this.baseLayer;
			}
		}

		logger.debugLog(`Schema change safety check passed for ${this._tableName}. Current committed layer is base.`);
	}

	/** Consolidates all transaction data into the base layer for schema changes */
	private async consolidateToBaseLayer(): Promise<void> {
		const lockKey = `MemoryTable.Consolidate:${this.schemaName}.${this._tableName}`;
		const release = await Latches.acquire(lockKey);

		try {
			logger.debugLog(`[Consolidate] Acquired lock for ${this._tableName}`);

			// If current committed layer is a transaction layer, we need to merge its data into the base
			if (this._currentCommittedLayer instanceof TransactionLayer && this._currentCommittedLayer.isCommitted()) {
				const transactionLayer = this._currentCommittedLayer as TransactionLayer;

				logger.debugLog(`[Consolidate] Copying data from transaction layer ${transactionLayer.getLayerId()} to base layer for ${this._tableName}`);

				// Copy all data from the transaction layer to the base layer
				await this.copyTransactionDataToBase(transactionLayer);

				// Force all connections to read from the base layer
				for (const conn of this.connections.values()) {
					if (conn.readLayer === transactionLayer) {
						logger.debugLog(`[Consolidate] Updating connection ${conn.connectionId} from transaction layer to base layer`);
						conn.readLayer = this.baseLayer;
					}
				}

				// Now we can set the base layer as the current committed layer
				this._currentCommittedLayer = this.baseLayer;
				logger.debugLog(`[Consolidate] CurrentCommittedLayer set to base for ${this._tableName}`);
			}
		} finally {
			release();
			logger.debugLog(`[Consolidate] Released lock for ${this._tableName}`);
		}
	}

	/** Copies all data from a transaction layer to the base layer */
	private async copyTransactionDataToBase(transactionLayer: TransactionLayer): Promise<void> {
		const primaryTree = transactionLayer.getModificationTree('primary');
		if (!primaryTree) return;

		// Collect all rows first to avoid modifying the base tree while iterating
		// the inherited BTree (whose parent IS the base tree).
		const allRows: Row[] = [];
		for (const path of primaryTree.ascending(primaryTree.first())) {
			allRows.push(primaryTree.at(path)!);
		}

		logger.debugLog(`[Consolidate] Collected ${allRows.length} rows from transaction layer. Row widths: ${allRows.map(r => r.length).join(',')}`);

		// Count base layer rows before
		let baseCount = 0;
		for (const _path of this.baseLayer.primaryTree.ascending(this.baseLayer.primaryTree.first())) {
			baseCount++;
		}
		logger.debugLog(`[Consolidate] Base layer had ${baseCount} rows before copy`);

		// Now insert collected rows into the base layer
		for (const row of allRows) {
			this.baseLayer.primaryTree.insert(row);
		}

		// Count base layer rows after
		let baseCountAfter = 0;
		for (const _path of this.baseLayer.primaryTree.ascending(this.baseLayer.primaryTree.first())) {
			baseCountAfter++;
		}
		logger.debugLog(`[Consolidate] Base layer has ${baseCountAfter} rows after copy`);

		// Also need to rebuild secondary indexes in the base layer
		await this.baseLayer.rebuildAllSecondaryIndexes();
	}

	/** Scans a layer according to the given plan, yielding matching rows. */
	public async* scanLayer(layer: Layer, plan: ScanPlan): AsyncIterable<Row> {
		yield* scanLayerImpl(layer, plan);
	}
}
