import type { SqlValue } from '../../common/types.js';

/** Key type used in B-Trees (primary key or index key part) */
export type BTreeKey = BTreeKeyForPrimary | BTreeKeyForIndex;

/** Alias for BTreeKey when explicitly referring to a primary key. */
export type BTreeKeyForPrimary = SqlValue | SqlValue[];

/** Alias for BTreeKey when explicitly referring to a key of a secondary index. */
export type BTreeKeyForIndex = SqlValue | SqlValue[];

/** Represents an entry in a MemoryIndex BTree, mapping an IndexKey to its PrimaryKeys.
 *
 * `primaryKeys` is an array kept sorted under the table's PK comparator (the
 * `primaryKeyComparator` threaded into {@link MemoryIndex}), NOT a JS Set. A Set
 * keys members by SameValueZero/reference identity, which is wrong for the keys
 * stored here: composite PKs are freshly-allocated arrays (so `Set.delete` of an
 * equal-by-value key never matches and `Set.add` stores equal-by-value dupes) and
 * even scalar integer PKs can differ by representation (`5n` vs `5`). The sorted
 * array lets {@link MemoryIndex} add/remove/contains by *value* via binary search
 * under the comparator — collation- and representation-aware. */
export interface MemoryIndexEntry {
	indexKey: BTreeKeyForIndex;
	primaryKeys: BTreeKeyForPrimary[];
}

/**
 * Configuration options for MemoryTable creation
 */
export interface MemoryTableConfig {
	readOnly?: boolean;
	_readCommitted?: boolean;
}
