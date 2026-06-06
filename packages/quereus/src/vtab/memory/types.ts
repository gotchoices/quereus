import type { SqlValue } from '../../common/types.js';

/** Key type used in B-Trees (primary key or index key part) */
export type BTreeKey = BTreeKeyForPrimary | BTreeKeyForIndex;

/** Alias for BTreeKey when explicitly referring to a primary key. */
export type BTreeKeyForPrimary = SqlValue | SqlValue[];

/** Alias for BTreeKey when explicitly referring to a key of a secondary index. */
export type BTreeKeyForIndex = SqlValue | SqlValue[];

/** Represents an entry in a MemoryIndex BTree, mapping an IndexKey to an array of PrimaryKeys */
export interface MemoryIndexEntry {
	indexKey: BTreeKeyForIndex;
	primaryKeys: Set<BTreeKeyForPrimary>;
}

/**
 * Configuration options for MemoryTable creation
 */
export interface MemoryTableConfig {
	readOnly?: boolean;
	_readCommitted?: boolean;
}
