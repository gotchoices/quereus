import { BTree } from 'inheritree';
import { StatusCode, type Row, type SqlValue } from '../../common/types.js';
import { createTypedComparator } from '../../util/comparison.js';
import type { CollationResolver } from '../../types/logical-type.js';
import { PK_HIGH, PK_LOW, type BTreeKeyForPrimary, type BTreeKeyForIndex, type IndexTreeKey, type MemoryIndexEntry } from './types.js';
import type { IndexColumnSchema as IndexColumnSpec } from '../../schema/table.js'; // Renamed for clarity
import type { ColumnSchema } from '../../schema/column.js';
import type { Expression } from '../../parser/ast.js';
import { quereusError } from '../../common/errors.js';
import { compilePredicate, type CompiledPredicate } from './utils/predicate.js';
import { safeIterate } from './layer/safe-iterate.js';

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

/** A stored entry is its own tree key (see {@link IndexTreeKey}). */
const entryTreeKey = (entry: MemoryIndexEntry): IndexTreeKey => entry;

/** Where a primary-key slot sits among one index key's rows: the low sentinel first, the high one last. */
function sentinelRank(slot: IndexTreeKey['primaryKey']): number {
	return slot === PK_LOW ? -1 : slot === PK_HIGH ? 1 : 0;
}

function comparePrimaryKeySlots(
	a: IndexTreeKey['primaryKey'],
	b: IndexTreeKey['primaryKey'],
	comparePrimaryKeys: (a: BTreeKeyForPrimary, b: BTreeKeyForPrimary) => number,
): number {
	if (typeof a === 'symbol' || typeof b === 'symbol') return sentinelRank(a) - sentinelRank(b);
	return comparePrimaryKeys(a, b);
}

/**
 * Represents a secondary index within a MemoryTable.
 *
 * The tree holds one {@link MemoryIndexEntry} per indexed row, ordered by index key and then
 * primary key, so a layer's write touches one root-to-leaf path however many rows share the
 * value. Scans therefore see each index value's rows in primary-key order, which
 * `quereus-isolation` relies on when it merges overlay and underlying secondary scans.
 */
export class MemoryIndex {
	public readonly name: string | undefined;
	public readonly specColumns: ReadonlyArray<IndexColumnSpec>;
	public readonly keyFromRow: (row: Row) => BTreeKeyForIndex;
	public readonly compareKeys: (a: BTreeKeyForIndex, b: BTreeKeyForIndex) => number;
	public data: BTree<IndexTreeKey, MemoryIndexEntry>;
	/** Compiled partial-index predicate. When present, only rows for which
	 *  `evaluate(row) === true` participate in the index. */
	public readonly predicate: CompiledPredicate | undefined;
	private readonly allTableColumnsSchema: ReadonlyArray<ColumnSchema>;
	/**
	 * The table's primary-key comparator (from `createPrimaryKeyFunctions(schema)`): the second
	 * half of the tree order, and so the identity of an entry. A PK-collation change via
	 * `ALTER COLUMN … SET COLLATE` forces a full base rebuild (`rebuildAllSecondaryIndexes` /
	 * `rebuildPrimaryTreeStrict`) and, on every layer of an open transaction,
	 * `TransactionLayer.rekeyPrimaryKey` — each recreating its entries under the new
	 * comparator, so no tree ordered by the old one survives an ALTER.
	 */
	private readonly primaryKeyComparator: (a: BTreeKeyForPrimary, b: BTreeKeyForPrimary) => number;

	/**
	 * Resolves this index's declared column collations against the owning database.
	 * A layer hands down its own resolver, so a child layer's comparator is built
	 * from the same collation function as the parent tree it inherits.
	 */
	private readonly collationResolver: CollationResolver;

	constructor(
		spec: IndexSpec,
		allTableColumnsSchema: ReadonlyArray<ColumnSchema>,
		collationResolver: CollationResolver,
		primaryKeyComparator: (a: BTreeKeyForPrimary, b: BTreeKeyForPrimary) => number,
		tableName: string,
		baseInheritreeTable?: BTree<IndexTreeKey, MemoryIndexEntry>,
	) {
		this.name = spec.name;
		this.specColumns = Object.freeze(spec.columns.map(c => ({ ...c })));
		this.allTableColumnsSchema = allTableColumnsSchema;
		this.collationResolver = collationResolver;
		this.primaryKeyComparator = primaryKeyComparator;

		this.validateColumnIndexes(allTableColumnsSchema);

		const keyFunctions = this.createIndexKeyFunctions();
		this.keyFromRow = keyFunctions.keyFromRow;
		this.compareKeys = keyFunctions.compareKeys;

		this.predicate = spec.predicate ? compilePredicate(spec.predicate, allTableColumnsSchema, tableName) : undefined;

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
		const collationFunc = specCol.collation ? this.collationResolver(specCol.collation) : undefined;
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
			const collationFunc = sc.collation ? this.collationResolver(sc.collation) : undefined;
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

	private createBTree(baseInheritreeTable?: BTree<IndexTreeKey, MemoryIndexEntry>): BTree<IndexTreeKey, MemoryIndexEntry> {
		return new BTree<IndexTreeKey, MemoryIndexEntry>(
			entryTreeKey,
			this.compareTreeKeys,
			{ base: baseInheritreeTable }
		);
	}

	/** The tree order: index key, then primary key, with the probe sentinels at either end of one index key's rows. */
	private readonly compareTreeKeys = (a: IndexTreeKey, b: IndexTreeKey): number => {
		const byIndexKey = this.compareKeys(a.indexKey, b.indexKey);
		return byIndexKey !== 0 ? byIndexKey : comparePrimaryKeySlots(a.primaryKey, b.primaryKey, this.primaryKeyComparator);
	};

	/**
	 * Files `primaryKey` under `indexKey`. An entry already there for the same pair (equal under
	 * both comparators) is replaced, so the stored bytes are the row's current ones.
	 */
	addEntry(indexKey: BTreeKeyForIndex, primaryKey: BTreeKeyForPrimary): void {
		this.data.upsert({ indexKey, primaryKey });
	}

	/**
	 * Removes the entry for this pair, if there is one.
	 *
	 * When a row's primary key changes to one the PK comparator calls equal (NOCASE `'A'` to
	 * `'a'`), callers must remove the old pair before adding the new one: both name the same
	 * entry, so adding first would replace it and the removal would then delete the row's only entry.
	 */
	removeEntry(indexKey: BTreeKeyForIndex, primaryKey: BTreeKeyForPrimary): void {
		const path = this.data.find({ indexKey, primaryKey });
		if (path.on) this.data.deleteAt(path);
	}

	/**
	 * The primary keys filed under `indexKey` (collation-equal index values included), in
	 * primary-key order, or the reverse of it when `descending`. Survives tree mutation between
	 * steps by re-finding its place (see {@link safeIterate}).
	 */
	*primaryKeysOf(indexKey: BTreeKeyForIndex, descending = false): Generator<BTreeKeyForPrimary> {
		const start: { value: IndexTreeKey } = { value: { indexKey, primaryKey: descending ? PK_HIGH : PK_LOW } };
		for (const entry of safeIterate(this.data, !descending, start, entryTreeKey)) {
			if (this.compareKeys(entry.indexKey, indexKey) !== 0) return;
			yield entry.primaryKey;
		}
	}

	/** The primary keys filed under `indexKey`, in primary-key order. */
	getPrimaryKeys(indexKey: BTreeKeyForIndex): BTreeKeyForPrimary[] {
		return [...this.primaryKeysOf(indexKey)];
	}

	/**
	 * True when at least one row is filed under `indexKey`. O(log n), so the build-time UNIQUE
	 * check (`populateIndexFromRows`) can probe per row.
	 */
	hasAnyPrimaryKey(indexKey: BTreeKeyForIndex): boolean {
		return !this.primaryKeysOf(indexKey).next().done;
	}

	/** The number of indexed rows (not of distinct index values). */
	get size(): number {
		return this.data.getCount();
	}

	/** Clears all entries from the index, creating a fresh empty BTree */
	clear(): void {
		this.data = this.createBTree();
	}

	/** Detaches this index's BTree from its base inheritance (when its layer is frozen, or a frozen layer's index is rebuilt) */
	clearBase(): void {
		this.data.clearBase();
	}
}
