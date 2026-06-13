import type { SqlValue } from '../../common/types.js';

/** Key type used in B-Trees (primary key or index key part) */
export type BTreeKey = BTreeKeyForPrimary | BTreeKeyForIndex;

/** Alias for BTreeKey when explicitly referring to a primary key. */
export type BTreeKeyForPrimary = SqlValue | SqlValue[];

/** Alias for BTreeKey when explicitly referring to a key of a secondary index. */
export type BTreeKeyForIndex = SqlValue | SqlValue[];

/** Represents an entry in a MemoryIndex BTree, mapping an IndexKey to its PrimaryKeys.
 *
 * `primaryKeys` maps a **lossless, type-aware PK encoding** (see
 * `utils/primary-key-encode.ts`, bound to the table's PK arity and threaded into
 * {@link MemoryIndex} as `encode`) to the actual stored PK. The KEY gives O(1)
 * value-identity add/remove/dedup; the VALUE is the real {@link BTreeKeyForPrimary}
 * so scans yield real PKs and the PK comparator can sort them on read.
 *
 * It is a `Map` — NOT a JS `Set`, and NOT a class instance or nested BTree — for two
 * reasons:
 *  - *Value identity.* A `Set` keys members by SameValueZero/reference identity,
 *    wrong here: composite PKs are freshly-allocated arrays (so `Set.delete` of an
 *    equal-by-value key never matches and `Set.add` stores equal-by-value dupes),
 *    and even scalar integer PKs differ by representation (`5n` vs `5`). The encoding
 *    normalizes these so equal-by-comparator PKs share one Map key.
 *  - *Structured-clone safety.* The entry is stored as a value inside the secondary
 *    index `inheritree` BTree, whose node copy-on-write deep-clones stored entries via
 *    `structuredClone(this.entries)`. A `Map` round-trips through `structuredClone` as
 *    a `Map` (pure data); a class instance or nested BTree would not survive intact. */
export interface MemoryIndexEntry {
	indexKey: BTreeKeyForIndex;
	primaryKeys: Map<string, BTreeKeyForPrimary>;
}

/**
 * Configuration options for MemoryTable creation
 */
export interface MemoryTableConfig {
	readOnly?: boolean;
	_readCommitted?: boolean;
}
