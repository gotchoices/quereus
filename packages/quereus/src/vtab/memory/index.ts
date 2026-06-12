import { BTree } from 'inheritree';
import { StatusCode, type Row, type SqlValue } from '../../common/types.js';
import { createTypedComparator, resolveCollation } from '../../util/comparison.js';
import type { BTreeKeyForPrimary, BTreeKeyForIndex, MemoryIndexEntry } from './types.js';
import type { IndexColumnSchema as IndexColumnSpec } from '../../schema/table.js'; // Renamed for clarity
import type { ColumnSchema } from '../../schema/column.js';
import type { Expression } from '../../parser/ast.js';
import { quereusError } from '../../common/errors.js';
import { compilePredicate, type CompiledPredicate } from './utils/predicate.js';

/** Definition for creating a memory index (matches IndexSchema columns usually) */
export interface IndexSpec {
	name?: string;
	columns: ReadonlyArray<IndexColumnSpec>;
	predicate?: Expression;
}

/** Functions for extracting and comparing index keys */
interface IndexKeyFunctions {
	keyFromRow: (row: Row) => BTreeKeyForIndex;
	compareKeys: (a: BTreeKeyForIndex, b: BTreeKeyForIndex) => number;
}

/** Represents a secondary index within a MemoryTable */
export class MemoryIndex {
	public readonly name: string | undefined;
	public readonly specColumns: ReadonlyArray<IndexColumnSpec>;
	public readonly keyFromRow: (row: Row) => BTreeKeyForIndex;
	public readonly compareKeys: (a: BTreeKeyForIndex, b: BTreeKeyForIndex) => number;
	public data: BTree<BTreeKeyForIndex, MemoryIndexEntry>;
	/** Compiled partial-index predicate. When present, only rows for which
	 *  `evaluate(row) === true` participate in the index. */
	public readonly predicate: CompiledPredicate | undefined;
	private readonly allTableColumnsSchema: ReadonlyArray<ColumnSchema>;

	constructor(spec: IndexSpec, allTableColumnsSchema: ReadonlyArray<ColumnSchema>, baseInheritreeTable?: BTree<BTreeKeyForIndex, MemoryIndexEntry>) {
		this.name = spec.name;
		this.specColumns = Object.freeze(spec.columns.map(c => ({ ...c })));
		this.allTableColumnsSchema = allTableColumnsSchema;

		this.validateColumnIndexes(allTableColumnsSchema);

		const keyFunctions = this.createIndexKeyFunctions();
		this.keyFromRow = keyFunctions.keyFromRow;
		this.compareKeys = keyFunctions.compareKeys;

		this.predicate = spec.predicate ? compilePredicate(spec.predicate, allTableColumnsSchema) : undefined;

		this.data = this.createBTree(baseInheritreeTable);
	}

	/** True when the partial-index predicate is satisfied by `row` (or there is no predicate). */
	rowMatchesPredicate(row: Row): boolean {
		if (!this.predicate) return true;
		return this.predicate.evaluate(row) === true;
	}

	private validateColumnIndexes(allTableColumnsSchema: ReadonlyArray<ColumnSchema>): void {
		const hasInvalidIndex = this.specColumns.some(sc =>
			sc.index < 0 || sc.index >= allTableColumnsSchema.length
		);

		if (hasInvalidIndex) {
			quereusError(`Invalid column index in index '${this.name ?? '(unnamed)'}'.`, StatusCode.INTERNAL);
		}
	}

	private createIndexKeyFunctions(): IndexKeyFunctions {
		if (this.specColumns.length === 1) {
			return this.createSingleColumnKeyFunctions();
		} else {
			return this.createCompositeColumnKeyFunctions();
		}
	}

	private createSingleColumnKeyFunctions(): IndexKeyFunctions {
		const specCol = this.specColumns[0];
		const colSchemaIndex = specCol.index;
		const columnSchema = this.allTableColumnsSchema[colSchemaIndex];
		const descMultiplier = specCol.desc ? -1 : 1;

		// Create type-aware comparator
		const collationFunc = specCol.collation ? resolveCollation(specCol.collation) : undefined;
		const typedComparator = createTypedComparator(columnSchema.logicalType, collationFunc);

		const keyFromRow = (row: Row): BTreeKeyForIndex => {
			this.validateRowLength(row, colSchemaIndex);
			return row[colSchemaIndex];
		};

		const compareKeys = (a: BTreeKeyForIndex, b: BTreeKeyForIndex): number => {
			return typedComparator(a as SqlValue, b as SqlValue) * descMultiplier;
		};

		return { keyFromRow, compareKeys };
	}

	private createCompositeColumnKeyFunctions(): IndexKeyFunctions {
		const localSpecColumns = this.specColumns;

		// Pre-create type-aware comparators for each column
		const comparators = localSpecColumns.map(sc => {
			const columnSchema = this.allTableColumnsSchema[sc.index];
			const collationFunc = sc.collation ? resolveCollation(sc.collation) : undefined;
			return createTypedComparator(columnSchema.logicalType, collationFunc);
		});

		const keyFromRow = (row: Row): BTreeKeyForIndex => {
			return localSpecColumns.map(sc => {
				this.validateRowLength(row, sc.index);
				return row[sc.index];
			});
		};

		const compareKeys = (a: BTreeKeyForIndex, b: BTreeKeyForIndex): number => {
			const arrA = a as SqlValue[];
			const arrB = b as SqlValue[];

			for (let i = 0; i < localSpecColumns.length; i++) {
				if (i >= arrA.length || i >= arrB.length) {
					return arrA.length - arrB.length;
				}

				const specCol = localSpecColumns[i];
				const comparison = comparators[i](arrA[i], arrB[i]);

				if (comparison !== 0) {
					return specCol.desc ? -comparison : comparison;
				}
			}
			return 0;
		};

		return { keyFromRow, compareKeys };
	}

	private validateRowLength(row: Row, columnIndex: number): void {
		if (columnIndex < 0 || columnIndex >= row.length) {
			quereusError(`Index key col index ${columnIndex} OOB for row len ${row.length}`, StatusCode.INTERNAL);
		}
	}

	private createBTree(baseInheritreeTable?: BTree<BTreeKeyForIndex, MemoryIndexEntry>): BTree<BTreeKeyForIndex, MemoryIndexEntry> {
		return new BTree<BTreeKeyForIndex, MemoryIndexEntry>(
			(entry: MemoryIndexEntry) => entry.indexKey,
			this.compareKeys,
			baseInheritreeTable
		);
	}

	/**
	 * Entries created by THIS index instance — safe to mutate in place. An entry
	 * found through the tree but absent here was INHERITED from an ancestor
	 * layer's tree (each TransactionLayer wraps a fresh MemoryIndex around the
	 * parent's BTree as base): only the btree NODES are copy-on-write, the entry
	 * objects (and their `primaryKeys` Sets) are shared, so mutating an inherited
	 * entry's Set writes through to the ancestor — corrupting committed state
	 * when this layer rolls back (a rolled-back insert leaves a phantom PK that
	 * false-rejects later UNIQUE checks; a rolled-back delete strips a live PK
	 * and silently un-enforces UNIQUE). Inherited entries are therefore
	 * copy-on-written via {@link BTree.updateAt}, which lands the replacement in
	 * THIS tree; owned entries keep the in-place fast path (bulk loads and
	 * repeated same-key writes within one layer stay O(1) per entry).
	 */
	private ownedEntries = new WeakSet<MemoryIndexEntry>();

	/** Adds a mapping from index key to primary key */
	addEntry(indexKey: BTreeKeyForIndex, primaryKey: BTreeKeyForPrimary): void {
		const path = this.data.find(indexKey);
		if (path.on) {
			const existingEntry = this.data.at(path)!;
			if (this.ownedEntries.has(existingEntry)) {
				existingEntry.primaryKeys.add(primaryKey);
				return;
			}
			// Inherited: copy-on-write into this layer's tree (see ownedEntries).
			// Keep the stored indexKey bytes (a collation-equal/byte-different new
			// key must not re-key the entry — matching the prior in-place behavior).
			const updated: MemoryIndexEntry = {
				indexKey: existingEntry.indexKey,
				primaryKeys: new Set(existingEntry.primaryKeys).add(primaryKey),
			};
			this.ownedEntries.add(updated);
			this.data.updateAt(path, updated);
		} else {
			const newEntry: MemoryIndexEntry = {
				indexKey,
				primaryKeys: new Set([primaryKey])
			};
			this.ownedEntries.add(newEntry);
			this.data.insert(newEntry);
		}
	}

	/** Removes a mapping from index key to primary key */
	removeEntry(indexKey: BTreeKeyForIndex, primaryKey: BTreeKeyForPrimary): void {
		const path = this.data.find(indexKey);
		if (!path.on) return;
		const entry = this.data.at(path)!;

		if (this.ownedEntries.has(entry)) {
			entry.primaryKeys.delete(primaryKey);
			// If no primary keys remain, remove the entire entry
			if (entry.primaryKeys.size === 0) {
				this.data.deleteAt(path);
			}
			return;
		}

		// Inherited: copy-on-write (see ownedEntries). A delete that empties the
		// entry masks it in this layer's tree; the ancestor's entry is untouched.
		const remaining = new Set(entry.primaryKeys);
		remaining.delete(primaryKey);
		if (remaining.size === 0) {
			this.data.deleteAt(path);
		} else {
			const updated: MemoryIndexEntry = { indexKey: entry.indexKey, primaryKeys: remaining };
			this.ownedEntries.add(updated);
			this.data.updateAt(path, updated);
		}
	}

	/** Returns the primary keys for a given index key */
	getPrimaryKeys(indexKey: BTreeKeyForIndex): BTreeKeyForPrimary[] {
		const entry = this.data.get(indexKey);
		return entry ? Array.from(entry.primaryKeys) : [];
	}

	/** Gets the count of unique index values */
	get size(): number {
		return this.data.getCount();
	}

	/** Clears all entries from the index, creating a fresh empty BTree */
	clear(): void {
		this.data = this.createBTree();
	}

	/** Detaches this index's BTree from its base inheritance (used during layer collapse) */
	clearBase(): void {
		this.data.clearBase();
	}
}
