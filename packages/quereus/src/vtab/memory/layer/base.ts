import { BTree } from 'inheritree';
import type { TableSchema } from '../../../schema/table.js';
import type { BTreeKeyForPrimary, BTreeKeyForIndex, MemoryIndexEntry } from '../types.js';
import type { Layer } from './interface.js';
import { MemoryIndex } from '../index.js';
import { StatusCode, type Row, type SqlValue } from '../../../common/types.js';
import { type ColumnSchema } from '../../../schema/column.js';
import type { IndexSchema } from '../../../schema/table.js';
import { createPrimaryKeyFunctions, type PrimaryKeyFunctions } from '../utils/primary-key.js';
import { createMemoryTableLoggers } from '../utils/logging.js';
import { QuereusError } from '../../../common/errors.js';

let baseLayerCounter = 0;
const logger = createMemoryTableLoggers('layer:base');

export class BaseLayer implements Layer {
	private readonly layerId: number;
	public tableSchema: TableSchema;
	private primaryKeyFunctions!: PrimaryKeyFunctions;
	public primaryTree: BTree<BTreeKeyForPrimary, Row>;
	public readonly secondaryIndexes: Map<string, MemoryIndex>;

	constructor(schema: TableSchema) {
		this.layerId = baseLayerCounter++;
		this.tableSchema = schema;
		this.initializePrimaryKeyFunctions();

		// Use the same key extraction pattern as TransactionLayer for consistency
		const btreeKeyFromValue = (value: Row): BTreeKeyForPrimary =>
			this.primaryKeyFunctions.extractFromRow(value);

		this.primaryTree = new BTree<BTreeKeyForPrimary, Row>(
			btreeKeyFromValue,
			this.primaryKeyFunctions.compare
		);
		this.secondaryIndexes = new Map();
		this.rebuildAllSecondaryIndexes();
	}

	public updateSchema(newSchema: TableSchema): void {
		logger.operation('Schema Update', this.tableSchema.name, {
			from: this.tableSchema.name,
			to: newSchema.name
		});
		this.tableSchema = newSchema;
		this.initializePrimaryKeyFunctions();
	}

	private initializePrimaryKeyFunctions(): void {
		this.primaryKeyFunctions = createPrimaryKeyFunctions(this.tableSchema);
	}

	public rebuildAllSecondaryIndexes(): void {
		this.clearExistingSecondaryIndexes();

		if (!this.hasSecondaryIndexes()) {
			return;
		}

		const newIndexes = this.createSecondaryIndexes();
		this.populateSecondaryIndexes(newIndexes);
		this.replaceSecondaryIndexes(newIndexes);
	}

	private clearExistingSecondaryIndexes(): void {
		this.secondaryIndexes.forEach(index => index.clear());
	}

	private hasSecondaryIndexes(): boolean {
		return Boolean(this.tableSchema.indexes && this.tableSchema.indexes.length > 0);
	}

	private createSecondaryIndexes(): Map<string, MemoryIndex> {
		const newIndexes = new Map<string, MemoryIndex>();

		for (const indexSchema of this.tableSchema.indexes!) {
			try {
				const memoryIndex = new MemoryIndex(indexSchema, this.tableSchema.columns);
				newIndexes.set(indexSchema.name, memoryIndex);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} catch (e: any) {
				logger.error('Create Index', this.tableSchema.name, e, { indexName: indexSchema.name });
			}
		}

		return newIndexes;
	}

	private populateSecondaryIndexes(newIndexes: Map<string, MemoryIndex>): void {
		for (const path of this.primaryTree.ascending(this.primaryTree.first())) {
			const row = this.primaryTree.at(path)!;
			this.addRowToSecondaryIndexes(row, newIndexes);
		}
	}

	private addRowToSecondaryIndexes(row: Row, indexes: Map<string, MemoryIndex>): void {
		const primaryKey = this.primaryKeyFunctions.extractFromRow(row);

		indexes.forEach(index => {
			try {
				if (!index.rowMatchesPredicate(row)) return;
				const indexKey = index.keyFromRow(row);
				index.addEntry(indexKey, primaryKey);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} catch (e: any) {
				logger.error('Re-index Row', this.tableSchema.name, e, { indexName: index.name });
			}
		});
	}

	private replaceSecondaryIndexes(newIndexes: Map<string, MemoryIndex>): void {
		this.secondaryIndexes.clear();
		newIndexes.forEach((idx, name) => this.secondaryIndexes.set(name, idx));
	}

	getLayerId = (): number => this.layerId;
	getParent = (): Layer | null => null;
	getSchema = (): TableSchema => this.tableSchema;
	isCommitted = (): boolean => true;

	getModificationTree = (indexName: string | 'primary'): BTree<BTreeKeyForPrimary, Row> | null =>
		indexName === 'primary' ? this.primaryTree : null;

	getSecondaryIndexTree = (indexName: string): BTree<BTreeKeyForIndex, MemoryIndexEntry> | null =>
		this.secondaryIndexes.get(indexName)?.data ?? null;

	getSecondaryIndex = (indexName: string): MemoryIndex | undefined =>
		this.secondaryIndexes.get(indexName);

	public getPkExtractorsAndComparators(schema: TableSchema): {
		primaryKeyExtractorFromRow: (row: Row) => BTreeKeyForPrimary;
		primaryKeyComparator: (a: BTreeKeyForPrimary, b: BTreeKeyForPrimary) => number
	} {
		if (schema !== this.tableSchema) {
			logger.warn('PK Extractors', this.tableSchema.name, 'Called with different schema');
		}
		return {
			primaryKeyExtractorFromRow: this.primaryKeyFunctions.extractFromRow,
			primaryKeyComparator: this.primaryKeyFunctions.compare
		};
	}

	has = (key: BTreeKeyForPrimary): boolean => {
		const value = this.primaryTree.get(key);
		return value !== undefined;
	};

	async addColumnToBase(newColumnSchema: ColumnSchema, defaultValue: SqlValue): Promise<void> {
		logger.operation('Add Column', this.tableSchema.name, {
			columnName: newColumnSchema.name,
			defaultValue
		});

		const oldPrimaryTree = this.primaryTree;

		// Reinitialize primary key functions with the updated schema (which already includes the new column)
		this.initializePrimaryKeyFunctions();

		// Create new primary tree with the updated schema and migrate data
		this.recreatePrimaryTreeWithNewColumn(oldPrimaryTree, defaultValue);

		this.rebuildAllSecondaryIndexes();
	}

	private recreatePrimaryTreeWithNewColumn(
		oldTree: BTree<BTreeKeyForPrimary, Row>,
		defaultValue: SqlValue
	): void {
		// Use the updated primary key functions for the new tree
		const btreeKeyFromValue = (value: Row): BTreeKeyForPrimary =>
			this.primaryKeyFunctions.extractFromRow(value);

		this.primaryTree = new BTree<BTreeKeyForPrimary, Row>(
			btreeKeyFromValue,
			this.primaryKeyFunctions.compare
		);

		for (const path of oldTree.ascending(oldTree.first())) {
			const oldRow = oldTree.at(path)!;
			const newRow = [...oldRow, defaultValue];
			this.primaryTree.insert(newRow);
		}
	}

	async dropColumnFromBase(columnIndexInOldSchema: number): Promise<void> {
		logger.operation('Drop Column', this.tableSchema.name, {
			columnIndex: columnIndexInOldSchema
		});

		const oldPrimaryTree = this.primaryTree;
		this.recreatePrimaryTreeWithoutColumn(oldPrimaryTree, columnIndexInOldSchema);
		await this.rebuildAllSecondaryIndexes();
	}

	private recreatePrimaryTreeWithoutColumn(oldTree: BTree<BTreeKeyForPrimary, Row>, columnIndex: number): void {
		const btreeKeyFromValue = (value: Row): BTreeKeyForPrimary =>
			this.primaryKeyFunctions.extractFromRow(value);

		this.primaryTree = new BTree<BTreeKeyForPrimary, Row>(
			btreeKeyFromValue,
			this.primaryKeyFunctions.compare
		);

		for (const path of oldTree.ascending(oldTree.first())) {
			const oldRow = oldTree.at(path)!;
			const newRow = oldRow.filter((_, idx) => idx !== columnIndex);
			this.primaryTree.insert(newRow);
		}
	}

	async handleColumnRename(): Promise<void> {
		logger.operation('Handle Column Rename', this.tableSchema.name);
		await this.rebuildAllSecondaryIndexes();
	}

	async addIndexToBase(indexSchema: IndexSchema): Promise<void> {
		logger.operation('Add Index', this.tableSchema.name, {
			indexName: indexSchema.name
		});

		const newMemoryIndex = new MemoryIndex(indexSchema, this.tableSchema.columns);
		this.populateNewIndex(newMemoryIndex, indexSchema);
		this.secondaryIndexes.set(indexSchema.name, newMemoryIndex);
	}

	/**
	 * Populates a freshly-created secondary index from the primary tree,
	 * honoring the index's partial-WHERE predicate (rows for which the
	 * predicate is not TRUE are skipped). For UNIQUE indexes, raises a
	 * CONSTRAINT error on the first duplicate index key among in-scope rows;
	 * the caller is expected to roll back the schema change in that case.
	 */
	private populateNewIndex(newIndex: MemoryIndex, indexSchema: IndexSchema): void {
		// Track index keys we've already inserted so we can detect duplicates
		// without doing a get() per row (the BTree merges duplicates by primaryKey
		// set; we want the first duplicate to surface as a CONSTRAINT error).
		const seen = indexSchema.unique
			? new Map<string, boolean>()
			: undefined;

		for (const path of this.primaryTree.ascending(this.primaryTree.first())) {
			const currentRow = this.primaryTree.at(path)!;
			if (!newIndex.rowMatchesPredicate(currentRow)) continue;

			const indexKey = newIndex.keyFromRow(currentRow);
			const primaryKey = this.primaryKeyFunctions.extractFromRow(currentRow);

			if (seen) {
				const cols = newIndex.specColumns.map(c => currentRow[c.index]);
				// SQL UNIQUE allows multiple NULLs: skip dup detection if any key value is NULL.
				const hasNull = cols.some(v => v === null);
				if (!hasNull) {
					const keySig = JSON.stringify(cols);
					if (seen.has(keySig)) {
						const colNames = newIndex.specColumns
							.map(c => this.tableSchema.columns[c.index]?.name ?? String(c.index))
							.join(', ');
						throw new QuereusError(
							`UNIQUE constraint failed: ${this.tableSchema.name} (${colNames})`,
							StatusCode.CONSTRAINT,
						);
					}
					seen.set(keySig, true);
				}
			}

			newIndex.addEntry(indexKey, primaryKey);
		}
	}

	async dropIndexFromBase(indexName: string): Promise<void> {
		if (this.secondaryIndexes.delete(indexName)) {
			logger.operation('Drop Index', this.tableSchema.name, { indexName });
		} else {
			logger.warn('Drop Index', this.tableSchema.name, 'Index not found', { indexName });
		}
	}
}
