import { BTree } from 'inheritree';
import type { ScanPlan } from './scan-plan.js';
import type { Layer } from './interface.js';
import type { BTreeKey, BTreeKeyForPrimary, BTreeKeyForIndex } from '../types.js';
import { IndexConstraintOp } from '../../../common/constants.js';
import { compareSqlValues } from '../../../util/comparison.js';
import { StatusCode, type Row } from '../../../common/types.js';
import { safeIterate } from './safe-iterate.js';
import { QuereusError } from '../../../common/errors.js';
import { planAppliesToKey } from './plan-filter.js';

/**
 * True if a multi-seek key is SQL NULL (scalar) or contains any NULL component
 * (composite tuple). Such a key contributes no match: `x IN (…, NULL)` is TRUE on
 * a non-null equal element else NULL, so the WHERE excludes the row; for a tuple
 * seek, a NULL in any component makes the row-value comparison NULL ⇒ no match.
 */
function seekKeyHasNull(key: BTreeKey): boolean {
	return Array.isArray(key) ? key.some(v => v === null) : key === null;
}

/**
 * Scans a layer (base or transaction) according to a ScanPlan, yielding matching rows.
 * Operates on the Layer interface — the inherited BTrees handle data inheritance transparently.
 */
export async function* scanLayer(
	layer: Layer,
	plan: ScanPlan
): AsyncIterable<Row> {
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
		const { primaryKeyExtractorFromRow, primaryKeyComparator } =
			layer.getPkExtractorsAndComparators(seekSchema);
		const seen = new BTree<BTreeKeyForPrimary, BTreeKeyForPrimary>(
			(k: BTreeKeyForPrimary) => k,
			primaryKeyComparator,
		);
		for (const key of plan.equalityKeys) {
			if (seekKeyHasNull(key)) continue;
			const singlePlan: ScanPlan = { ...plan, equalityKey: key, equalityKeys: undefined };
			for await (const row of scanLayer(layer, singlePlan)) {
				const pk = primaryKeyExtractorFromRow(row);
				// insert returns a path whose `.on` is true only for a newly added key;
				// a false `.on` means this row was already yielded by an earlier seek.
				if (!seen.insert(pk).on) continue;
				yield row;
			}
		}
		return;
	}

	// Multi-range: iterate over multiple range specs
	if (plan.ranges && plan.ranges.length > 0) {
		for (const range of plan.ranges) {
			const singlePlan: ScanPlan = {
				...plan,
				ranges: undefined,
				lowerBound: range.lowerBound,
				upperBound: range.upperBound,
			};
			yield* scanLayer(layer, singlePlan);
		}
		return;
	}

	const schema = layer.getSchema();
	const { primaryKeyExtractorFromRow, primaryKeyComparator } = layer.getPkExtractorsAndComparators(schema);

	if (plan.indexName === 'primary') {
		const tree = layer.getModificationTree('primary');
		if (!tree) return;

		if (plan.equalityKey !== undefined) {
			// A NULL (or NULL-containing) equality key is UNKNOWN under SQL three-valued
			// logic ⇒ no row matches. Short-circuit before `tree.get`: a literal `null`
			// could otherwise match a stored NULL index entry for a composite key. Only
			// `undefined` (no equality key) falls through to the full/range walk below.
			if (seekKeyHasNull(plan.equalityKey)) return;
			const value = tree.get(plan.equalityKey as BTreeKeyForPrimary);
			if (value) {
				yield value as Row;
			}
			return;
		}

		const isAscending = !plan.descending;
		// When the leading PK column is DESC the BTree is physically ordered with
		// that column descending. The synthesized all-columns fallback definition
		// carries no `desc`, so the `?.` chain yields false there, which is correct.
		const isDescFirstColumn = schema.primaryKeyDefinition?.[0]?.desc === true;
		const isComposite = (schema.primaryKeyDefinition?.length ?? schema.columns.length) > 1;

		// Seek-start selection must depend on the *physical* walk direction, not just
		// the key's declared direction. The four {isAscending}×{isDescFirstColumn}
		// combinations each seek from one bound and terminate at the other:
		//   ascending  + ASC-leading  → seek from lower, terminate at upper
		//   ascending  + DESC-leading → seek from upper, terminate at lower
		//   descending + ASC-leading  → seek from upper, terminate at lower
		//   descending + DESC-leading → seek from lower, terminate at upper
		// i.e. seek from the upper bound exactly when isAscending === isDescFirstColumn
		// (and terminate at the complement). Absent the chosen bound we fall back to
		// the tree end `safeIterate` picks for the direction.
		const seekFromUpper = isAscending === isDescFirstColumn;

		// Determine start key for range scans
		let startKey: { value: BTreeKeyForPrimary } | undefined;
		if (plan.equalityPrefix) {
			const compositeStart = [...plan.equalityPrefix];
			if (plan.lowerBound) compositeStart.push(plan.lowerBound.value);
			startKey = { value: compositeStart as BTreeKeyForPrimary };
		} else {
			// Composite PKs store array-shaped keys; wrap the scalar leading-column
			// bound in a single-element array so the comparator's prefix handling
			// positions the seek before all full keys sharing that prefix.
			const seekBound = seekFromUpper ? plan.upperBound : plan.lowerBound;
			if (seekBound) {
				const seekValue = isComposite ? [seekBound.value] : seekBound.value;
				startKey = { value: seekValue as BTreeKeyForPrimary };
			}
		}

		for await (const value of safeIterate(tree, isAscending, startKey)) {
			const row = value as Row;
			const primaryKey = primaryKeyExtractorFromRow(row);
			if (!planAppliesToKey(plan, primaryKey, primaryKeyComparator)) {
				// Early termination for prefix-range: break when prefix no longer matches
				if (plan.equalityPrefix) {
					const keyArr = Array.isArray(primaryKey) ? primaryKey : [primaryKey];
					let prefixMismatch = false;
					for (let i = 0; i < plan.equalityPrefix.length; i++) {
						if (compareSqlValues(keyArr[i], plan.equalityPrefix[i], plan.equalityPrefixCollations?.[i]) !== 0) {
							prefixMismatch = true;
							break;
						}
					}
					if (prefixMismatch) break;
				} else {
					// Past the bound we terminate at — early exit. We seek from one end
					// and terminate at the other, so this is the complement of
					// seekFromUpper and holds for both physical walk directions. The
					// terminating compare uses the bound column's declared collation so a
					// non-BINARY walk terminates at the collation-correct boundary.
					const keyForComparison = Array.isArray(primaryKey) ? primaryKey[0] : primaryKey;
					if (!seekFromUpper && plan.upperBound) {
						const cmp = compareSqlValues(keyForComparison, plan.upperBound.value, plan.boundCollation);
						if (cmp > 0 || (cmp === 0 && plan.upperBound.op === IndexConstraintOp.LT)) {
							break;
						}
					} else if (seekFromUpper && plan.lowerBound) {
						const cmp = compareSqlValues(keyForComparison, plan.lowerBound.value, plan.boundCollation);
						if (cmp < 0 || (cmp === 0 && plan.lowerBound.op === IndexConstraintOp.GT)) {
							break;
						}
					}
				}
				continue;
			}
			yield row;
		}
	} else {
		// Secondary Index Scan
		const indexTree = layer.getSecondaryIndexTree(plan.indexName);
		if (!indexTree) throw new QuereusError(`Secondary index '${plan.indexName}' not found.`, StatusCode.INTERNAL);

		const primaryTree = layer.getModificationTree('primary');

		if (plan.equalityKey !== undefined) {
			// NULL equality is UNKNOWN ⇒ no rows (see the primary branch above). Only
			// `undefined` falls through to the ordered walk.
			if (seekKeyHasNull(plan.equalityKey)) return;
			const indexEntry = indexTree.get(plan.equalityKey as BTreeKeyForIndex);
			if (indexEntry && primaryTree) {
				for (const pk of indexEntry.primaryKeys) {
					const value = primaryTree.get(pk);
					if (value) {
						yield value as Row;
					}
				}
			}
			return;
		}

		const isAscending = !plan.descending;
		const indexDef = schema.indexes?.find(idx => idx.name === plan.indexName);
		const isDescFirstColumn = indexDef?.columns[0]?.desc === true;

		// Seek-from end depends on the physical walk direction (see the primary
		// branch for the full rationale): seek from the upper bound exactly when
		// isAscending === isDescFirstColumn, terminate at the complement. Composite
		// secondary indexes store array-shaped keys, so wrap the scalar
		// leading-column bound so the comparator's prefix handling positions the
		// seek correctly (mirrors the primary branch).
		const isComposite = (indexDef?.columns.length ?? 1) > 1;
		const seekFromUpper = isAscending === isDescFirstColumn;

		// Determine start key
		let startKey: { value: BTreeKeyForIndex } | undefined;
		if (plan.equalityPrefix) {
			const compositeStart = [...plan.equalityPrefix];
			if (plan.lowerBound) compositeStart.push(plan.lowerBound.value);
			startKey = { value: compositeStart as BTreeKeyForIndex };
		} else {
			const seekBound = seekFromUpper ? plan.upperBound : plan.lowerBound;
			if (seekBound) {
				const seekValue = isComposite ? [seekBound.value] : seekBound.value;
				startKey = { value: seekValue as BTreeKeyForIndex };
			}
		}

		for await (const indexEntry of safeIterate(indexTree, isAscending, startKey)) {
			if (!planAppliesToKey(plan, indexEntry.indexKey, primaryKeyComparator)) {
				// Early termination for prefix-range: break when prefix no longer matches
				if (plan.equalityPrefix) {
					const keyArr = Array.isArray(indexEntry.indexKey) ? indexEntry.indexKey : [indexEntry.indexKey];
					let prefixMismatch = false;
					for (let i = 0; i < plan.equalityPrefix.length; i++) {
						if (compareSqlValues(keyArr[i], plan.equalityPrefix[i], plan.equalityPrefixCollations?.[i]) !== 0) {
							prefixMismatch = true;
							break;
						}
					}
					if (prefixMismatch) break;
					continue;
				}
				// Early termination: break once the leading column passes the bound we
				// terminate at (the complement of seekFromUpper; holds for both
				// physical walk directions). Uses the bound column's declared collation
				// so a non-BINARY index walk terminates at the collation-correct boundary.
				const keyForComparison = Array.isArray(indexEntry.indexKey) ? indexEntry.indexKey[0] : indexEntry.indexKey;
				if (!seekFromUpper && plan.upperBound) {
					const cmp = compareSqlValues(keyForComparison, plan.upperBound.value, plan.boundCollation);
					if (cmp > 0 || (cmp === 0 && plan.upperBound.op === IndexConstraintOp.LT)) {
						break;
					}
				} else if (seekFromUpper && plan.lowerBound) {
					const cmp = compareSqlValues(keyForComparison, plan.lowerBound.value, plan.boundCollation);
					if (cmp < 0 || (cmp === 0 && plan.lowerBound.op === IndexConstraintOp.GT)) {
						break;
					}
				}
				continue;
			}
			if (!primaryTree) continue;
			for (const pk of indexEntry.primaryKeys) {
				const value = primaryTree.get(pk);
				if (value) {
					yield value as Row;
				}
			}
		}
	}
}
