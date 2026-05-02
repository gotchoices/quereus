import { BTree } from 'inheritree';
import type { TableSchema } from '../../../schema/table.js';
import { MemoryIndex } from '../index.js';
import type { Row } from '../../../common/types.js';
import type { BTreeKeyForPrimary, BTreeKeyForIndex, MemoryIndexEntry } from '../types.js';
import type { Layer } from './interface.js';
import { createLogger } from '../../../common/logger.js';
import { createPrimaryKeyFunctions } from '../utils/primary-key.js';
import { QuereusError } from '../../../common/errors.js';
import { StatusCode } from '../../../common/types.js';

const log = createLogger('vtab:memory:layer:transaction');
const warnLog = log.extend('warn');

let transactionLayerCounter = 1000;

/**
 * Pending change for event emission.
 */
interface PendingChange {
	type: 'insert' | 'update' | 'delete';
	pk: BTreeKeyForPrimary;
	oldRow?: Row;
	newRow?: Row;
}

/**
 * Represents a set of modifications (inserts, updates, deletes) applied
 * on top of a parent Layer using inherited BTrees with copy-on-write semantics.
 * These layers are immutable once committed.
 */
export class TransactionLayer implements Layer {
	private readonly layerId: number;
	public readonly parentLayer: Layer;
	private readonly tableSchemaAtCreation: TableSchema; // Schema when this layer was started

	// Primary modifications BTree that inherits from parent
	private primaryModifications: BTree<BTreeKeyForPrimary, Row>;

	// Secondary index BTrees that inherit from parent's indexes
	private secondaryIndexes: Map<string, MemoryIndex>;

	private _isCommitted: boolean = false;
	private _hasModifications: boolean = false;

	/** Pending changes for event emission. Null if tracking disabled. */
	private pendingChanges: PendingChange[] | null = null;

	constructor(parent: Layer) {
		this.layerId = transactionLayerCounter++;
		this.parentLayer = parent;
		const schema = parent.getSchema();
		if (!schema) {
			throw new QuereusError(
				`TransactionLayer: parent layer ${parent.getLayerId()} has no schema. ` +
				'This usually means a savepoint snapshot was created before the overlay was initialised.',
				StatusCode.INTERNAL
			);
		}
		this.tableSchemaAtCreation = schema; // Schema is fixed at creation

		// Initialize primary modifications BTree with parent's primary tree as base
		const { primaryKeyExtractorFromRow, primaryKeyComparator } = this.getPkExtractorsAndComparators(this.tableSchemaAtCreation);
		const btreeKeyFromValue = (value: Row): BTreeKeyForPrimary => {
			const result = primaryKeyExtractorFromRow(value);
			return result;
		};

		const parentPrimaryTree = parent.getModificationTree('primary');

		this.primaryModifications = new BTree(
			btreeKeyFromValue,
			primaryKeyComparator,
			parentPrimaryTree || undefined // Use parent's primary tree as base
		);

		// Initialize secondary indexes that inherit from parent's secondary indexes
		this.secondaryIndexes = new Map();
		this.initializeSecondaryIndexes();
	}

	private initializeSecondaryIndexes(): void {
		const schema = this.tableSchemaAtCreation;
		if (!schema.indexes) return;

		for (const indexSchema of schema.indexes) {
			const parentSecondaryTree = this.parentLayer.getSecondaryIndexTree?.(indexSchema.name);
			// Create MemoryIndex with inherited BTree
			const memoryIndex = new MemoryIndex(
				indexSchema,
				schema.columns,
				parentSecondaryTree || undefined // Use parent's secondary index tree as base
			);
			this.secondaryIndexes.set(indexSchema.name, memoryIndex);
		}
	}

	getLayerId(): number {
		return this.layerId;
	}

	getParent(): Layer {
		return this.parentLayer;
	}

	getSchema(): TableSchema {
		// Return the schema as it was when this transaction started
		return this.tableSchemaAtCreation;
	}

	isCommitted(): boolean {
		return this._isCommitted;
	}

	/** Marks this layer as committed. Should only be done by MemoryTable. */
	markCommitted(): void {
		if (!this._isCommitted) {
			this._isCommitted = true;
			// With inherited BTrees, we don't need to freeze complex change tracking structures
		}
	}

	/**
	 * Enable change tracking for event emission.
	 * Should be called before mutations if there are listeners.
	 */
	enableChangeTracking(): void {
		if (!this.pendingChanges) {
			this.pendingChanges = [];
		}
	}

	/**
	 * Check if change tracking is enabled.
	 */
	isTrackingChanges(): boolean {
		return this.pendingChanges !== null;
	}

	/**
	 * Get pending changes for event emission.
	 */
	getPendingChanges(): readonly PendingChange[] {
		return this.pendingChanges ?? [];
	}

	/**
	 * Copy change tracking state from another layer (for savepoint snapshots).
	 */
	copyChangeTrackingFrom(source: TransactionLayer): void {
		if (source.pendingChanges) {
			this.pendingChanges = [...source.pendingChanges];
		}
		this._hasModifications = source._hasModifications;
	}

	public getPkExtractorsAndComparators(schema: TableSchema): {
		primaryKeyExtractorFromRow: (row: Row) => BTreeKeyForPrimary;
		primaryKeyComparator: (a: BTreeKeyForPrimary, b: BTreeKeyForPrimary) => number
	} {
		if (schema !== this.tableSchemaAtCreation) {
			warnLog("TransactionLayer.getPkExtractorsAndComparators called with a schema different from its creation schema. Using creation schema.");
		}

		// Use the centralized primary key functions instead of duplicating the logic
		// This ensures consistent handling of empty primary key definitions
		const pkFunctions = createPrimaryKeyFunctions(this.tableSchemaAtCreation);
		return {
			primaryKeyExtractorFromRow: pkFunctions.extractFromRow,
			primaryKeyComparator: pkFunctions.compare
		};
	}

	getModificationTree(indexName: string | 'primary'): BTree<BTreeKeyForPrimary, Row> | null {
		if (indexName === 'primary') return this.primaryModifications;
		return null; // Secondary indexes are accessed via getSecondaryIndexTree
	}

	getSecondaryIndexTree(indexName: string): BTree<BTreeKeyForIndex, MemoryIndexEntry> | null {
		return this.secondaryIndexes.get(indexName)?.data ?? null;
	}

	getSecondaryIndex(indexName: string): MemoryIndex | undefined {
		return this.secondaryIndexes.get(indexName);
	}

	/** Records an insert or update in this transaction layer */
	recordUpsert(primaryKey: BTreeKeyForPrimary, newRowData: Row, oldRowDataIfUpdate?: Row | null): void {
		if (this._isCommitted) throw new QuereusError("Cannot modify a committed layer");

		this._hasModifications = true;
		this.primaryModifications.upsert(newRowData);

		// Track change for event emission
		if (this.pendingChanges) {
			this.pendingChanges.push({
				type: oldRowDataIfUpdate ? 'update' : 'insert',
				pk: primaryKey,
				oldRow: oldRowDataIfUpdate ?? undefined,
				newRow: newRowData,
			});
		}

		// Update secondary indexes
		const schema = this.getSchema();
		if (schema.indexes) {
			for (const indexSchema of schema.indexes) {
				const memoryIndex = this.secondaryIndexes.get(indexSchema.name);
				if (!memoryIndex) continue;

				if (oldRowDataIfUpdate) { // UPDATE
					const oldIndexKey = memoryIndex.keyFromRow(oldRowDataIfUpdate);
					const newIndexKey = memoryIndex.keyFromRow(newRowData);

					// If index key changed, remove old and add new
					if (memoryIndex.compareKeys(oldIndexKey, newIndexKey) !== 0) {
						memoryIndex.removeEntry(oldIndexKey, primaryKey);
						memoryIndex.addEntry(newIndexKey, primaryKey);
					} else {
						// Index key is same, but we might need to update the entry
						// With inherited BTrees, the existing entry will be copied on write
						memoryIndex.addEntry(newIndexKey, primaryKey);
					}
				} else { // INSERT
					const newIndexKey = memoryIndex.keyFromRow(newRowData);
					memoryIndex.addEntry(newIndexKey, primaryKey);
				}
			}
		}
	}

	/** Records a delete in this transaction layer */
	recordDelete(primaryKey: BTreeKeyForPrimary, oldRowDataForIndexes: Row): void {
		if (this._isCommitted) throw new QuereusError("Cannot modify a committed layer");

		this._hasModifications = true;
		// Find the existing entry
		const existingPath = this.primaryModifications.find(primaryKey);
		if (existingPath.on) {
			// Entry exists (locally or inherited) - use deleteAt to remove it
			this.primaryModifications.deleteAt(existingPath);
		}
		// If key doesn't exist, there's nothing to delete - no deletion marker needed
		// Inheritree's copy-on-write semantics handle this properly

		// Track change for event emission
		if (this.pendingChanges) {
			this.pendingChanges.push({
				type: 'delete',
				pk: primaryKey,
				oldRow: oldRowDataForIndexes,
			});
		}

		// Update secondary indexes to remove entries
		const schema = this.getSchema();
		if (schema.indexes) {
			for (const indexSchema of schema.indexes) {
				const memoryIndex = this.secondaryIndexes.get(indexSchema.name);
				if (!memoryIndex) continue;

				const oldIndexKey = memoryIndex.keyFromRow(oldRowDataForIndexes);
				memoryIndex.removeEntry(oldIndexKey, primaryKey);
			}
		}
	}

	public hasChanges(): boolean {
		return this._hasModifications;
	}

	/**
	 * Detaches this layer's BTrees from their base, making them self-contained.
	 * This should be called when the layer becomes the new effective base.
	 */
	public clearBase(): void {
		this.primaryModifications.clearBase();
		for (const memoryIndex of this.secondaryIndexes.values()) {
			memoryIndex.clearBase();
		}
	}
}
