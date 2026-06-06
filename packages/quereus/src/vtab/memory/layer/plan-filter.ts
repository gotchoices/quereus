import type { ScanPlan } from './scan-plan.js';
import type { BTreeKey } from '../types.js';
import { IndexConstraintOp } from '../../../common/constants.js';
import { compareSqlValues } from '../../../util/comparison.js';

/**
 * Checks whether a given BTree key satisfies the constraints in a ScanPlan.
 * Handles equality, prefix-range, and simple bound constraints.
 */
export function planAppliesToKey(
	plan: ScanPlan,
	key: BTreeKey,
	keyComparator: (a: BTreeKey, b: BTreeKey) => number
): boolean {
	if (plan.equalityKey != null) {
		return keyComparator(key, plan.equalityKey) === 0;
	}

	// Prefix-range: check prefix equality + trailing column bounds
	if (plan.equalityPrefix) {
		const keyArr = Array.isArray(key) ? key : [key];
		for (let i = 0; i < plan.equalityPrefix.length; i++) {
			if (compareSqlValues(keyArr[i], plan.equalityPrefix[i]) !== 0) return false;
		}
		const trailingValue = keyArr[plan.equalityPrefix.length];
		if (trailingValue !== undefined && trailingValue !== null) {
			if (plan.lowerBound) {
				const cmp = compareSqlValues(trailingValue, plan.lowerBound.value);
				if (cmp < 0 || (cmp === 0 && plan.lowerBound.op === IndexConstraintOp.GT)) return false;
			}
			if (plan.upperBound) {
				const cmp = compareSqlValues(trailingValue, plan.upperBound.value);
				if (cmp > 0 || (cmp === 0 && plan.upperBound.op === IndexConstraintOp.LT)) return false;
			}
		}
		return true;
	}

	const keyForBoundComparison = Array.isArray(key) ? key[0] : key;
	if (plan.lowerBound && (keyForBoundComparison !== undefined && keyForBoundComparison !== null)) {
		const cmp = compareSqlValues(keyForBoundComparison, plan.lowerBound.value);
		if (cmp < 0 || (cmp === 0 && plan.lowerBound.op === IndexConstraintOp.GT)) return false;
	}
	if (plan.upperBound && (keyForBoundComparison !== undefined && keyForBoundComparison !== null)) {
		const cmp = compareSqlValues(keyForBoundComparison, plan.upperBound.value);
		if (cmp > 0 || (cmp === 0 && plan.upperBound.op === IndexConstraintOp.LT)) return false;
	}
	return true;
}
