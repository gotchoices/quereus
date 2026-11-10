import type { ScanPlan, ScanPlanRangeBound } from './scan-plan.js';
import type { Layer } from './interface.js';
import { keyParts, leadingKeyPart, PK_HIGH, PK_LOW, type BTreeKey, type BTreeKeyForPrimary, type BTreeKeyForIndex, type IndexTreeKey, type MemoryIndexEntry } from '../types.js';
import { IndexConstraintOp } from '../../../common/constants.js';
import { StatusCode, type Row, type SqlValue } from '../../../common/types.js';
import type { BTree } from 'inheritree';
import { safeIterate } from './safe-iterate.js';
import { QuereusError } from '../../../common/errors.js';
import { planAppliesToKey, resolveScanComparators, type ResolvedScanComparators } from './plan-filter.js';

/**
 * True if a multi-seek key is SQL NULL (scalar) or contains any NULL component
 * (composite tuple). Such a key contributes no match: `x IN (…, NULL)` is TRUE on
 * a non-null equal element else NULL, so the WHERE excludes the row; for a tuple
 * seek, a NULL in any component makes the row-value comparison NULL ⇒ no match.
 *
 * `keyIsTuple` comes from the scanned structure's arity (see the {@link BTreeKey}
 * invariant) — sniffing it would read the JSON document `[null]` as a NULL-bearing
 * tuple and silently drop the equality seek that should match it.
 */
function seekKeyHasNull(key: BTreeKey, keyIsTuple: boolean): boolean {
	return keyParts(key, keyIsTuple).some(v => v === null);
}

/**
 * A multi-seek's keys arrive in seek-argument order (the order the `IN` list appears in
 * the SQL text), which need not match the scanned structure's own key order. `quereus-isolation`
 * merges this scan with a staged-row stream assuming both arrive in structure order (see
 * merge-iterator.ts), so sort them under that structure's own comparator — the same contract
 * the store backend already honors (see store-table-scan.ts). Reversed for a descending walk,
 * which emits the structure's keys backwards too. Both comparators already fold each key
 * column's logical type, collation and `DESC` direction, so this is the tree's physical order.
 *
 * Keys pass through untouched for an index name the layer's schema does not know; the scan
 * body reports that with a better message than a sort could.
 */
function orderSeekKeys(
	keys: readonly BTreeKey[],
	plan: ScanPlan,
	layer: Layer,
	primaryKeyComparator: (a: BTreeKey, b: BTreeKey) => number,
): readonly BTreeKey[] {
	const compare = plan.indexName === 'primary'
		? primaryKeyComparator
		: layer.getSecondaryIndex(plan.indexName)?.compareKeys;
	if (!compare) return keys;
	return plan.descending
		? [...keys].sort((a, b) => -compare(a, b))
		: [...keys].sort(compare);
}

/**
 * The key a walk seeks to: the equality prefix, then the bound the walk starts from. Undefined
 * when there is neither, which leaves the start to `safeIterate`. A tuple shorter than the tree's
 * keys sorts before every full key sharing it, so the seek lands before all of those rows.
 *
 * A non-composite tree stores SCALAR keys: an array-shaped seek key would position PAST the
 * scalar match (the comparator orders the wrapped form after its scalar), silently skipping the
 * row a full-key-length prefix (the delta-aggregate point read) targets. A lone value is
 * therefore unwrapped there, and stays a one-element tuple on a composite tree.
 *
 * NOTE: no consumer today emits a single-column secondary-index `equalityPrefix` seek
 * (single-column equality goes through `equalityKey`), so that shape has no direct test. If one
 * ever does, add a targeted prefix-scan test; the primary key's is exercised by every
 * delta-aggregate flush.
 */
function seekStartKey(
	plan: ScanPlan,
	seekBound: ScanPlanRangeBound | undefined,
	isComposite: boolean,
): { value: BTreeKey } | undefined {
	const parts = [...(plan.equalityPrefix ?? []), ...(seekBound ? [seekBound.value] : [])];
	if (parts.length === 0) return undefined;
	return { value: !isComposite && parts.length === 1 ? parts[0] : parts };
}

/**
 * How a walk moves between the scanned structure's keys (the primary key, or a secondary index's
 * key columns) and the keys its tree is ordered by. The primary tree is keyed by the primary key
 * itself; a secondary-index tree by (index key, primary key), so a seek tuple over the index
 * columns becomes a tree key by adding a sentinel in the primary-key slot.
 */
interface WalkKeys<TKey, TEntry> {
	/** The tree key that positions a walk at a seek tuple over the structure's key columns. */
	readonly seekKey: (seek: BTreeKey) => TKey;
	/** An entry's key over the structure's key columns: what plan bounds and seek groups test. */
	readonly structureKey: (entry: TEntry) => BTreeKey;
}

/**
 * The tree key a walk starts from: {@link seekStartKey}, except that a BACKWARDS walk seeking with
 * a tuple shorter than the structure's keys starts from the last key of the group sharing that tuple.
 *
 * The short tuple sorts just before every key sharing it, so the seek lands at the START of that
 * group. A forward walk then enters the group; a backwards walk would move away from it and skip
 * every row in it (`where k = 1 order by r desc` over `(k, r)` would return nothing). A full-length
 * key needs no help (an exact hit, or the crack `moveNearest` steps off correctly), and neither
 * does an exclusive seek bound, which excludes the whole group anyway.
 */
function walkStartKey<TKey, TEntry>(
	tree: BTree<TKey, TEntry>,
	plan: ScanPlan,
	seekBound: ScanPlanRangeBound | undefined,
	keyArity: number,
	keys: WalkKeys<TKey, TEntry>,
	comparators: ResolvedScanComparators,
): { value: TKey } | undefined {
	const startKey = seekStartKey(plan, seekBound, keyArity > 1);
	if (!startKey) return undefined;
	const seekPartCount = (plan.equalityPrefix?.length ?? 0) + (seekBound ? 1 : 0);
	const entersShortGroupBackwards = plan.descending && seekPartCount < keyArity && !(seekBound && isExclusiveBound(seekBound));
	const from = entersShortGroupBackwards
		? lastKeyOfSeekGroup(tree, startKey.value, plan, seekBound, keys, comparators)
		: startKey.value;
	return { value: keys.seekKey(from) };
}

function isExclusiveBound(bound: ScanPlanRangeBound): boolean {
	return bound.op === IndexConstraintOp.GT || bound.op === IndexConstraintOp.LT;
}

/**
 * The last structure key at or after `startKey` whose leading columns equal the seek tuple, or
 * `startKey` itself when no key does (the crack is then already the right start for a backwards
 * walk). Equality runs under the walk's own per-column comparators, which mirror the tree's, so
 * the group is contiguous and collation variants of one value count as one group.
 *
 * NOTE: costs one extra forward pass over the group's rows (a secondary index holds one entry per
 * row). If a large group at a backwards walk's start ever shows up in a profile, give the key
 * comparator a sentinel that sorts a short tuple after its group and seek past it directly.
 */
function lastKeyOfSeekGroup<TKey, TEntry>(
	tree: BTree<TKey, TEntry>,
	startKey: BTreeKey,
	plan: ScanPlan,
	seekBound: ScanPlanRangeBound | undefined,
	keys: WalkKeys<TKey, TEntry>,
	comparators: ResolvedScanComparators,
): BTreeKey {
	const path = tree.find(keys.seekKey(startKey));
	if (!path.on) tree.moveNext(path);
	let last: BTreeKey | undefined;
	for (; path.on; tree.moveNext(path)) {
		const key = keys.structureKey(tree.at(path)!);
		if (!keyInSeekGroup(key, plan, seekBound, comparators)) break;
		last = key;
	}
	return last === undefined ? startKey : last;
}

/**
 * The primary-key sentinel a secondary-index seek carries. A seek tuple as long as the index key
 * names one index value, and every row filed under it shares the tuple, so the sentinel decides
 * whether the walk starts among those rows or past them: an inclusive seek bound (or a bare
 * equality prefix) starts on the walk's near side of the group, an exclusive one on its far side.
 * A shorter tuple sorts before the whole group whatever the sentinel.
 */
function seekSentinel(isAscending: boolean, seekBound: ScanPlanRangeBound | undefined): typeof PK_LOW | typeof PK_HIGH {
	const skipsSeekValue = seekBound !== undefined && isExclusiveBound(seekBound);
	return isAscending !== skipsSeekValue ? PK_LOW : PK_HIGH;
}

/** True when `key`'s leading columns equal the equality prefix and then the seek bound's value. */
function keyInSeekGroup(
	key: BTreeKey,
	plan: ScanPlan,
	seekBound: ScanPlanRangeBound | undefined,
	comparators: ResolvedScanComparators,
): boolean {
	const parts = keyParts(key, comparators.keyIsTuple);
	const prefix = plan.equalityPrefix ?? [];
	if (prefix.some((value, i) => comparators.equalityPrefix[i](parts[i], value) !== 0)) return false;
	return !seekBound || comparators.bound(parts[prefix.length], seekBound.value) === 0;
}

/**
 * True when `value`, the range-bound column of a key the plan rejected, has passed the bound
 * the walk terminates at. The other bound is not compared: the walk starts from it, and it can
 * reject the row the seek lands on (an exclusive bound positioned on an exact match) with
 * matching rows still ahead. `comparators.bound` is built like the tree's key comparator, so
 * the walk ends at the boundary of the tree's own order.
 *
 * `undefined` means the key has no such column (a prefix as long as the key), which no bound
 * constrains. A stored NULL is safe here because the comparator ranks it lowest: it sits before
 * an ascending column's values, below the upper bound, and after a `DESC` column's values, where
 * stopping at the lower bound loses nothing since NULL never satisfies a range.
 */
function pastTerminatingBound(
	value: SqlValue | undefined,
	plan: ScanPlan,
	seekFromUpper: boolean,
	comparators: ResolvedScanComparators,
): boolean {
	if (value === undefined) return false;
	if (!seekFromUpper && plan.upperBound) {
		const cmp = comparators.bound(value, plan.upperBound.value);
		return cmp > 0 || (cmp === 0 && plan.upperBound.op === IndexConstraintOp.LT);
	}
	if (seekFromUpper && plan.lowerBound) {
		const cmp = comparators.bound(value, plan.lowerBound.value);
		return cmp < 0 || (cmp === 0 && plan.lowerBound.op === IndexConstraintOp.GT);
	}
	return false;
}

/** True when a key the plan rejected shows that no later key in the walk can match. */
function walkIsExhausted(
	key: BTreeKey,
	plan: ScanPlan,
	seekFromUpper: boolean,
	comparators: ResolvedScanComparators,
): boolean {
	const prefix = plan.equalityPrefix;
	if (!prefix) {
		return pastTerminatingBound(leadingKeyPart(key, comparators.keyIsTuple), plan, seekFromUpper, comparators);
	}
	const parts = keyParts(key, comparators.keyIsTuple);
	return prefix.some((value, i) => comparators.equalityPrefix[i](parts[i], value) !== 0)
		|| pastTerminatingBound(parts[prefix.length], plan, seekFromUpper, comparators);
}

/**
 * Scans a layer (base or transaction) according to a ScanPlan, yielding matching rows.
 * Operates on the Layer interface — the inherited BTrees handle data inheritance transparently.
 *
 * The plan's collation names and the scanned index's column types are resolved into
 * per-column comparators exactly once here; {@link scanLayerResolved} does the work and
 * passes the functions down its own recursion, so a multi-seek or multi-range plan
 * never re-resolves per sub-scan or per row. The comparators mirror the tree's own key
 * comparator (typed — see plan-filter.ts), so bound filtering and early termination
 * agree with the physical BTree order.
 */
export function* scanLayer(
	layer: Layer,
	plan: ScanPlan
): Iterable<Row> {
	yield* scanLayerResolved(layer, plan, resolveScanComparators(plan, layer.getSchema(), layer.collationResolver));
}

/**
 * The scan body. `comparators` holds the plan's already-resolved bound/prefix
 * comparators; narrowing a plan (multi-seek → single key, multi-range → single range)
 * never changes which columns the prefix/bound comparators describe, so the same
 * functions are reused down the recursion.
 */
function* scanLayerResolved(
	layer: Layer,
	plan: ScanPlan,
	comparators: ResolvedScanComparators,
): Iterable<Row> {
	// Multi-seek: iterate over multiple equality keys (e.g. `col IN (v1, v2, …)`).
	// This is set-membership, not a bag, so two faults must be avoided:
	//  - A duplicate seek key (`IN (5, 5)`, or two case-variant literals that hit the
	//    same NOCASE index entry) must not re-yield its row. We dedup the *yielded
	//    rows by primary key* — keying on physical row identity is collation-agnostic.
	//  - A NULL (or NULL-containing) seek key contributes no match and must be skipped;
	//    leaving it in would also fall through to the unbounded full-index walk below
	//    (the point-seek branches gate on `equalityKey != null`).
	if (plan.equalityKeys && plan.equalityKeys.length > 0) {
		const seekSchema = layer.getSchema();
		// Dedup by encoded primary key. Membership is all we need (ordered iteration
		// of the seen-set is not), so a Set of the lossless, type-aware PK encoding
		// (collation-independent — see utils/primary-key-encode.ts) is lighter than a
		// full BTree and keys on the same value-identity the PK comparator would.
		const { primaryKeyExtractorFromRow, primaryKeyEncoder: encodePk, primaryKeyComparator } =
			layer.getPkExtractorsAndComparators(seekSchema);
		const seen = new Set<string>();
		for (const key of orderSeekKeys(plan.equalityKeys, plan, layer, primaryKeyComparator)) {
			if (seekKeyHasNull(key, comparators.keyIsTuple)) continue;
			const singlePlan: ScanPlan = { ...plan, equalityKey: key, equalityKeys: undefined };
			for (const row of scanLayerResolved(layer, singlePlan, comparators)) {
				const encoded = encodePk(primaryKeyExtractorFromRow(row));
				// A key already in `seen` means this row was yielded by an earlier seek.
				if (seen.has(encoded)) continue;
				seen.add(encoded);
				yield row;
			}
		}
		return;
	}

	// Multi-range: iterate over multiple range specs
	if (plan.ranges && plan.ranges.length > 0) {
		// NOTE: ranges are visited in SQL-text order, not index order (harmless: no multi-range
		// seek advertises an ordering). If one ever does, or a backwards walk reaches here, sort
		// the ranges by leading bound under the index comparator (reversed for a backwards
		// walk), as `orderSeekKeys` does for multi-seek keys.
		for (const range of plan.ranges) {
			const singlePlan: ScanPlan = {
				...plan,
				ranges: undefined,
				lowerBound: range.lowerBound,
				upperBound: range.upperBound,
			};
			yield* scanLayerResolved(layer, singlePlan, comparators);
		}
		return;
	}

	// A NULL prefix value is UNKNOWN ⇒ no row matches. `planAppliesToKey` would reject
	// every row anyway, but the prefix comparators treat NULL as equal to NULL, so the walk
	// would visit the whole group of stored NULLs before its early termination fires.
	if (plan.equalityPrefix?.some(v => v === null)) return;

	const schema = layer.getSchema();
	const { primaryKeyExtractorFromRow, primaryKeyComparator } = layer.getPkExtractorsAndComparators(schema);
	// The column a range bound applies to. The prefix columns are fixed within the walk, so
	// only this column's direction decides where the walk seeks from and where it stops.
	const boundPosition = plan.equalityPrefix?.length ?? 0;

	if (plan.indexName === 'primary') {
		const tree = layer.getModificationTree('primary');
		if (!tree) return;

		if (plan.equalityKey !== undefined) {
			// A NULL (or NULL-containing) equality key is UNKNOWN under SQL three-valued
			// logic ⇒ no row matches. Short-circuit before `tree.get`: a literal `null`
			// could otherwise match a stored NULL index entry for a composite key. Only
			// `undefined` (no equality key) falls through to the full/range walk below.
			if (seekKeyHasNull(plan.equalityKey, comparators.keyIsTuple)) return;
			const value = tree.get(plan.equalityKey as BTreeKeyForPrimary);
			if (value) {
				yield value as Row;
			}
			return;
		}

		const isAscending = !plan.descending;
		// When the bound PK column is DESC the BTree is physically ordered with that
		// column descending. The synthesized all-columns fallback definition carries
		// no `desc`, and a full-key prefix has no bound column, so the `?.` chain
		// yields false for both, which is correct.
		const isDescBoundColumn = schema.primaryKeyDefinition?.[boundPosition]?.desc === true;
		// NOTE: `walkStartKey` reads `keyArity > 1` as composite, whereas the key-shape flag
		// `comparators.keyIsTuple` uses `!== 1`.
		// They differ only for the zero-column singleton PK, which stores `[]`: neither
		// branch below can reach it (an `equalityPrefix` needs a PK column, and there is
		// no column for a bound to constrain), so the seek key is never built for it. If a
		// zero-arity plan ever does reach here, switch this to `keyIsTuple`.
		const keyArity = schema.primaryKeyDefinition?.length ?? schema.columns.length;

		// Seek-start selection must depend on the *physical* walk direction, not just
		// the bound column's declared direction. The four {isAscending}×{isDescBoundColumn}
		// combinations each seek from one bound and terminate at the other:
		//   ascending  + ASC bound column  → seek from lower, terminate at upper
		//   ascending  + DESC bound column → seek from upper, terminate at lower
		//   descending + ASC bound column  → seek from upper, terminate at lower
		//   descending + DESC bound column → seek from lower, terminate at upper
		// i.e. seek from the upper bound exactly when isAscending === isDescBoundColumn
		// (and terminate at the complement). Absent the chosen bound we fall back to
		// the tree end `safeIterate` picks for the direction, or to the prefix's group.
		const seekFromUpper = isAscending === isDescBoundColumn;
		const seekBound = seekFromUpper ? plan.upperBound : plan.lowerBound;
		const keys: WalkKeys<BTreeKeyForPrimary, Row> = { seekKey: seek => seek, structureKey: primaryKeyExtractorFromRow };
		const startKey = walkStartKey(tree, plan, seekBound, keyArity, keys, comparators);

		for (const value of safeIterate(tree, isAscending, startKey, primaryKeyExtractorFromRow)) {
			const row = value as Row;
			const primaryKey = primaryKeyExtractorFromRow(row);
			if (!planAppliesToKey(plan, primaryKey, primaryKeyComparator, comparators)) {
				if (walkIsExhausted(primaryKey, plan, seekFromUpper, comparators)) break;
				continue;
			}
			yield row;
		}
	} else {
		// Secondary Index Scan
		const secondaryIndex = layer.getSecondaryIndex(plan.indexName);
		if (!secondaryIndex) throw new QuereusError(`Secondary index '${plan.indexName}' not found.`, StatusCode.INTERNAL);
		const indexTree = secondaryIndex.data;
		const primaryTree = layer.getModificationTree('primary');
		if (!primaryTree) return;

		// Emits rows in `(indexKey…, pk…)` order, and on a backwards walk the exact reverse of
		// it, PK order inside one index value included. That is the composite sort key
		// `quereus-isolation` sorts its overlay rows by (negated whole for `reverse: true`) and
		// the order docs/design-isolation-layer.md documents for a secondary-index scan. The
		// tree holds one entry per row in exactly that order, so the walk yields it directly.
		if (plan.equalityKey !== undefined) {
			// NULL equality is UNKNOWN ⇒ no rows (see the primary branch above). Only
			// `undefined` falls through to the ordered walk.
			if (seekKeyHasNull(plan.equalityKey, comparators.keyIsTuple)) return;
			for (const pk of secondaryIndex.primaryKeysOf(plan.equalityKey as BTreeKeyForIndex, plan.descending === true)) {
				const value = primaryTree.get(pk);
				if (value) {
					yield value as Row;
				}
			}
			return;
		}

		const isAscending = !plan.descending;
		const indexDef = schema.indexes?.find(idx => idx.name === plan.indexName);
		const isDescBoundColumn = indexDef?.columns[boundPosition]?.desc === true;

		// Seek-from end depends on the physical walk direction (see the primary
		// branch for the full rationale): seek from the upper bound exactly when
		// isAscending === isDescBoundColumn, terminate at the complement.
		const keyArity = indexDef?.columns.length ?? 1;
		const seekFromUpper = isAscending === isDescBoundColumn;
		const seekBound = seekFromUpper ? plan.upperBound : plan.lowerBound;
		const sentinel = seekSentinel(isAscending, seekBound);
		const keys: WalkKeys<IndexTreeKey, MemoryIndexEntry> = {
			seekKey: seek => ({ indexKey: seek, primaryKey: sentinel }),
			structureKey: entry => entry.indexKey,
		};
		const startKey = walkStartKey(indexTree, plan, seekBound, keyArity, keys, comparators);

		for (const indexEntry of safeIterate(indexTree, isAscending, startKey, entry => entry)) {
			if (!planAppliesToKey(plan, indexEntry.indexKey, primaryKeyComparator, comparators)) {
				if (walkIsExhausted(indexEntry.indexKey, plan, seekFromUpper, comparators)) break;
				continue;
			}
			const value = primaryTree.get(indexEntry.primaryKey);
			if (value) {
				yield value as Row;
			}
		}
	}
}
