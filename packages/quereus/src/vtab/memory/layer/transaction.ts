import { BTree } from 'inheritree';
import type { TableSchema } from '../../../schema/table.js';
import { MemoryIndex } from '../index.js';
import type { Row } from '../../../common/types.js';
import type { BTreeKeyForPrimary, BTreeKeyForIndex, MemoryIndexEntry } from '../types.js';
import type { Layer, PkExtractorsAndComparators } from './interface.js';
import { createLogger } from '../../../common/logger.js';
import { createPrimaryKeyFunctions, type PrimaryKeyFunctions } from '../utils/primary-key.js';
import { QuereusError } from '../../../common/errors.js';
import { StatusCode } from '../../../common/types.js';
import type { CollationResolver } from '../../../types/logical-type.js';

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
 * A single structural write this layer made, captured unconditionally (unlike
 * {@link PendingChange}, which records only when change-tracking is enabled).
 * Serves as the replay source when a sibling connection's commit advances the
 * committed head past this layer's fork point and the layer must be rebased —
 * see `MemoryTableManager.commitTransaction`.
 */
export interface OwnWrite {
	type: 'upsert' | 'delete';
	primaryKey: BTreeKeyForPrimary;
	/** New row for an upsert; absent for a delete. */
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
	/**
	 * Inherited verbatim from the parent layer: this layer's secondary BTrees are
	 * built over the parent's (`new MemoryIndex(..., parentSecondaryTree)`), so the
	 * child's `compareKeys` must come from the same collation function the parent
	 * ordered those nodes with.
	 */
	public readonly collationResolver: CollationResolver;
	private readonly tableSchemaAtCreation: TableSchema; // Schema when this layer was started

	/**
	 * Built once from {@link tableSchemaAtCreation} (which never changes for a layer),
	 * so the primary tree, every inherited secondary index, and every scan share one
	 * comparator/encoder set — and one pass of collation resolution.
	 */
	private readonly pkFunctions: PrimaryKeyFunctions;

	// Primary modifications BTree that inherits from parent
	private primaryModifications: BTree<BTreeKeyForPrimary, Row>;

	// Secondary index BTrees that inherit from parent's indexes
	private secondaryIndexes: Map<string, MemoryIndex>;

	private _isCommitted: boolean = false;
	private _hasModifications: boolean = false;

	/** Pending changes for event emission. Null if tracking disabled. */
	private pendingChanges: PendingChange[] | null = null;

	// NOTE: always-on, one entry per record{Upsert,Delete} call — an ordered
	// list, so repeated writes to the same PK are all retained (last-write-wins is
	// applied at replay by re-deriving each key's effective row on the new head).
	// If a write-heavy transaction ever shows memory pressure from this log,
	// collapse it to a PK-keyed last-write map (only the net per-PK effect is ever
	// replayed).
	/** Always-maintained log of this layer's own structural writes (see {@link OwnWrite}). */
	private readonly ownWrites: OwnWrite[] = [];

	constructor(parent: Layer) {
		this.layerId = transactionLayerCounter++;
		this.parentLayer = parent;
		this.collationResolver = parent.collationResolver;
		const schema = parent.getSchema();
		if (!schema) {
			throw new QuereusError(
				`TransactionLayer: parent layer ${parent.getLayerId()} has no schema. ` +
				'This usually means a savepoint snapshot was created before the overlay was initialised.',
				StatusCode.INTERNAL
			);
		}
		this.tableSchemaAtCreation = schema; // Schema is fixed at creation
		this.pkFunctions = createPrimaryKeyFunctions(schema, this.collationResolver);

		// Initialize primary modifications BTree with parent's primary tree as base
		const { extractFromRow, compare: primaryKeyComparator } = this.pkFunctions;
		const btreeKeyFromValue = (value: Row): BTreeKeyForPrimary => {
			const result = extractFromRow(value);
			return result;
		};

		const parentPrimaryTree = parent.getModificationTree('primary');

		this.primaryModifications = new BTree(
			btreeKeyFromValue,
			primaryKeyComparator,
			{ base: parentPrimaryTree || undefined } // Use parent's primary tree as base
		);

		// Initialize secondary indexes that inherit from parent's secondary indexes
		this.secondaryIndexes = new Map();
		this.initializeSecondaryIndexes();
	}

	private initializeSecondaryIndexes(): void {
		const schema = this.tableSchemaAtCreation;
		if (!schema.indexes) return;

		// All layers of a table derive the PK comparator and encoder from the same PK
		// definition, so an inherited entry's `primaryKeys` Map keys stay valid for this
		// layer's value add/remove on each MemoryIndex entry.
		const pkFunctions = this.pkFunctions;

		for (const indexSchema of schema.indexes) {
			const parentSecondaryTree = this.parentLayer.getSecondaryIndexTree?.(indexSchema.name);
			// Create MemoryIndex with inherited BTree
			const memoryIndex = new MemoryIndex(
				indexSchema,
				schema.columns,
				this.collationResolver,
				pkFunctions.compare,
				pkFunctions.encode,
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
	 * Get pending changes for event emission.
	 */
	getPendingChanges(): readonly PendingChange[] {
		return this.pendingChanges ?? [];
	}

	/** This layer's own structural writes, oldest-first — the rebase replay source. */
	getOwnWrites(): readonly OwnWrite[] {
		return this.ownWrites;
	}

	public getPkExtractorsAndComparators(schema: TableSchema): PkExtractorsAndComparators {
		if (schema !== this.tableSchemaAtCreation) {
			warnLog("TransactionLayer.getPkExtractorsAndComparators called with a schema different from its creation schema. Using creation schema.");
		}

		// Use the centralized primary key functions instead of duplicating the logic
		// This ensures consistent handling of empty primary key definitions
		return {
			primaryKeyExtractorFromRow: this.pkFunctions.extractFromRow,
			primaryKeyComparator: this.pkFunctions.compare,
			primaryKeyEncoder: this.pkFunctions.encode
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

		// Always-on replay log (independent of change tracking).
		this.ownWrites.push({ type: 'upsert', primaryKey, newRow: newRowData });

		// Track change for event emission
		if (this.pendingChanges) {
			this.pendingChanges.push({
				type: oldRowDataIfUpdate ? 'update' : 'insert',
				pk: primaryKey,
				oldRow: oldRowDataIfUpdate ?? undefined,
				newRow: newRowData,
			});
		}

		// Update secondary indexes (honoring partial-index predicates)
		const schema = this.getSchema();
		if (schema.indexes) {
			for (const indexSchema of schema.indexes) {
				const memoryIndex = this.secondaryIndexes.get(indexSchema.name);
				if (!memoryIndex) continue;

				const newInScope = memoryIndex.rowMatchesPredicate(newRowData);

				if (oldRowDataIfUpdate) { // UPDATE
					const oldInScope = memoryIndex.rowMatchesPredicate(oldRowDataIfUpdate);

					if (!oldInScope && !newInScope) continue;

					if (oldInScope && !newInScope) {
						const oldIndexKey = memoryIndex.keyFromRow(oldRowDataIfUpdate);
						memoryIndex.removeEntry(oldIndexKey, primaryKey);
						continue;
					}

					if (!oldInScope && newInScope) {
						const newIndexKey = memoryIndex.keyFromRow(newRowData);
						memoryIndex.addEntry(newIndexKey, primaryKey);
						continue;
					}

					// Both in scope
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
					if (!newInScope) continue;
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

		// Always-on replay log (independent of change tracking).
		this.ownWrites.push({ type: 'delete', primaryKey });

		// Track change for event emission
		if (this.pendingChanges) {
			this.pendingChanges.push({
				type: 'delete',
				pk: primaryKey,
				oldRow: oldRowDataForIndexes,
			});
		}

		// Update secondary indexes to remove entries (only if the deleted row was in scope)
		const schema = this.getSchema();
		if (schema.indexes) {
			for (const indexSchema of schema.indexes) {
				const memoryIndex = this.secondaryIndexes.get(indexSchema.name);
				if (!memoryIndex) continue;

				if (!memoryIndex.rowMatchesPredicate(oldRowDataForIndexes)) continue;

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
