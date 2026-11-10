import type { SqlValue } from '../../common/types.js';

/**
 * Key type used in B-Trees (primary key or index key part).
 *
 * **Invariant: the scalar-vs-tuple choice is a function of the structure's ARITY
 * alone, and is NEVER recoverable from the value.** A one-column primary key or
 * index stores the raw column value as a scalar; every other arity (including the
 * zero-column singleton PK, whose extractor returns `[]`) stores a `SqlValue[]`
 * tuple. See `utils/primary-key.ts` and {@link MemoryIndex}, which both branch on
 * arity when they build keys.
 *
 * Do NOT recover the shape with `Array.isArray`: a JSON column's value can itself
 * be a JS array, so a stored document like `[1]` would be misread as the one-element
 * tuple `(1)` and every bound/prefix check would then compare against `1`. Thread the
 * arity down instead and use {@link keyParts} / {@link leadingKeyPart}.
 */
export type BTreeKey = BTreeKeyForPrimary | BTreeKeyForIndex;

/** Alias for BTreeKey when explicitly referring to a primary key. */
export type BTreeKeyForPrimary = SqlValue | SqlValue[];

/** Alias for BTreeKey when explicitly referring to a key of a secondary index. */
export type BTreeKeyForIndex = SqlValue | SqlValue[];

/**
 * The tuple view of a key whose arity is already known — see the {@link BTreeKey}
 * invariant. `keyIsTuple` must come from the structure's column count, never from
 * inspecting the value.
 */
export function keyParts(key: BTreeKey, keyIsTuple: boolean): readonly SqlValue[] {
	return keyIsTuple ? key as SqlValue[] : [key as SqlValue];
}

/**
 * The leading component of a key whose arity is already known — `keyParts(...)[0]`
 * without allocating the single-element wrapper on the scalar path (this runs per
 * row inside scan loops).
 */
export function leadingKeyPart(key: BTreeKey, keyIsTuple: boolean): SqlValue {
	return keyIsTuple ? (key as SqlValue[])[0] : key as SqlValue;
}

/**
 * One indexed row in a {@link MemoryIndex} tree: the row's index key and its primary key.
 *
 * The tree holds one entry per row, ordered by the index key and then by the table's
 * primary-key comparator, so identity is that pair under those two comparators: PKs the
 * PK comparator calls equal (`5n` / `5`, reordered JSON objects, NOCASE `'A'` / `'a'`)
 * are one entry. Each entry keeps its own row's index-key bytes, so two collation-equal
 * index values (NOCASE `'B'` / `'b'`) stay as they were written; nothing reads them back
 * as data, since scans fetch rows from the primary tree.
 *
 * Immutable once stored. A transaction layer's tree inherits its parent's nodes and
 * clones only the path it writes; the entry objects in those nodes are shared with the
 * parent, so changing one in place would change the parent's committed state too.
 */
export interface MemoryIndexEntry {
	readonly indexKey: BTreeKeyForIndex;
	readonly primaryKey: BTreeKeyForPrimary;
}

/** Sorts before every primary key filed under an equal index key. Probe keys only; never stored. */
export const PK_LOW: unique symbol = Symbol('PK_LOW');
/** Sorts after every primary key filed under an equal index key. Probe keys only; never stored. */
export const PK_HIGH: unique symbol = Symbol('PK_HIGH');

/**
 * A position in a {@link MemoryIndex} tree. A stored entry is one; a probe puts
 * {@link PK_LOW} or {@link PK_HIGH} in the primary-key slot to land just before or just
 * after every row filed under `indexKey`.
 */
export interface IndexTreeKey {
	readonly indexKey: BTreeKeyForIndex;
	readonly primaryKey: BTreeKeyForPrimary | typeof PK_LOW | typeof PK_HIGH;
}

/**
 * Configuration options for MemoryTable creation
 */
export interface MemoryTableConfig {
	readOnly?: boolean;
	_readCommitted?: boolean;
}
