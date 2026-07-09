import type { ScanPlan } from './scan-plan.js';
import type { BTreeKey } from '../types.js';
import { IndexConstraintOp } from '../../../common/constants.js';
import { BINARY_COLLATION, compareSqlValuesFast } from '../../../util/comparison.js';
import type { CollationFunction, CollationResolver } from '../../../types/logical-type.js';

/**
 * The collation *functions* a {@link ScanPlan}'s name-valued collations resolve to.
 * A `ScanPlan` stays plain data (it is logged and compared as such), so the
 * name→function step happens once per scan and the result is threaded to every
 * per-row comparison. Resolving inside the row loop would add a registry lookup
 * per row and regress `test/performance-sentinels.spec.ts`.
 */
export interface ResolvedScanCollations {
	/** Parallel to {@link ScanPlan.equalityPrefix}; BINARY where the plan declares none. */
	readonly equalityPrefix: readonly CollationFunction[];
	/** {@link ScanPlan.boundCollation} resolved; BINARY when the plan declares none. */
	readonly bound: CollationFunction;
}

/**
 * Resolves a plan's declared collation names against the owning database once,
 * ahead of the scan. Throws (via the resolver) if the plan names a collation that
 * is not registered — an unresolvable collation is never downgraded to BINARY.
 *
 * NOTE: this runs once per `scanLayer` call, not per row. A BINARY-only plan (the
 * common case) costs one empty array and one branch. If per-scan setup ever shows
 * up on a workload of very many tiny scans, memoize the result on the plan object
 * via a `WeakMap` keyed by `ScanPlan`.
 */
export function resolveScanCollations(plan: ScanPlan, collationResolver: CollationResolver): ResolvedScanCollations {
	const equalityPrefix = (plan.equalityPrefix ?? []).map((_, i) => {
		const name = plan.equalityPrefixCollations?.[i];
		return name ? collationResolver(name) : BINARY_COLLATION;
	});
	const bound = plan.boundCollation ? collationResolver(plan.boundCollation) : BINARY_COLLATION;
	return { equalityPrefix, bound };
}

/**
 * Checks whether a given BTree key satisfies the constraints in a ScanPlan.
 * Handles equality, prefix-range, and simple bound constraints.
 */
export function planAppliesToKey(
	plan: ScanPlan,
	key: BTreeKey,
	keyComparator: (a: BTreeKey, b: BTreeKey) => number,
	collations: ResolvedScanCollations,
): boolean {
	if (plan.equalityKey != null) {
		return keyComparator(key, plan.equalityKey) === 0;
	}

	// A NULL seek value admits no key: `v <op> NULL` and `v = NULL` are NULL,
	// never true. Reachable when a parameter or correlated value binds NULL at
	// runtime — plan-time literal NULLs never get here (constraint extraction
	// declines range bounds; the access-path rule emits EmptyResult for seeks).
	// Without this, compareSqlValuesFast ranks every key above a NULL bound (key
	// ordering), so `col > ?` bound to NULL would admit every row, and a NULL
	// prefix component would equality-match stored NULL index entries.
	if (plan.lowerBound?.value === null || plan.upperBound?.value === null) return false;
	if (plan.equalityPrefix?.some(v => v === null)) return false;

	// Prefix-range: check prefix equality + trailing column bounds. The prefix and
	// bound compares honour the index columns' declared collations (resolved once per
	// scan into `collations`) so a non-BINARY seek matches exactly the
	// collation-correct window; an undeclared collation resolves to BINARY.
	if (plan.equalityPrefix) {
		const keyArr = Array.isArray(key) ? key : [key];
		for (let i = 0; i < plan.equalityPrefix.length; i++) {
			if (compareSqlValuesFast(keyArr[i], plan.equalityPrefix[i], collations.equalityPrefix[i]) !== 0) return false;
		}
		const trailingValue = keyArr[plan.equalityPrefix.length];
		// A NULL trailing value never satisfies a range comparison (`NULL <op> v` is
		// NULL, never true), so exclude it when a trailing bound is present. The seek
		// covers the predicate (no residual `Filter` is kept above it), so this filter
		// is what enforces the bound's NULL semantics. `undefined` means the key tuple
		// is shorter than the prefix+1 (column absent), which the bound cannot constrain.
		if (trailingValue === null && (plan.lowerBound || plan.upperBound)) return false;
		if (trailingValue !== undefined && trailingValue !== null) {
			if (plan.lowerBound) {
				const cmp = compareSqlValuesFast(trailingValue, plan.lowerBound.value, collations.bound);
				if (cmp < 0 || (cmp === 0 && plan.lowerBound.op === IndexConstraintOp.GT)) return false;
			}
			if (plan.upperBound) {
				const cmp = compareSqlValuesFast(trailingValue, plan.upperBound.value, collations.bound);
				if (cmp > 0 || (cmp === 0 && plan.upperBound.op === IndexConstraintOp.LT)) return false;
			}
		}
		return true;
	}

	const keyForBoundComparison = Array.isArray(key) ? key[0] : key;
	// A NULL bound-column value never satisfies a range comparison (`NULL <op> v` is
	// NULL, never true), so a NULL key is excluded whenever a range bound is present.
	// The seek covers the predicate (the planner drops the residual `Filter`), so this
	// is what enforces the bound's NULL semantics — without it a pure upper-bound seek
	// walks the leading NULL block and yields it. `undefined` (column absent from a
	// short key tuple) stays lenient, as the bound cannot constrain a missing column.
	if (keyForBoundComparison === null && (plan.lowerBound || plan.upperBound)) return false;
	if (plan.lowerBound && (keyForBoundComparison !== undefined && keyForBoundComparison !== null)) {
		const cmp = compareSqlValuesFast(keyForBoundComparison, plan.lowerBound.value, collations.bound);
		if (cmp < 0 || (cmp === 0 && plan.lowerBound.op === IndexConstraintOp.GT)) return false;
	}
	if (plan.upperBound && (keyForBoundComparison !== undefined && keyForBoundComparison !== null)) {
		const cmp = compareSqlValuesFast(keyForBoundComparison, plan.upperBound.value, collations.bound);
		if (cmp > 0 || (cmp === 0 && plan.upperBound.op === IndexConstraintOp.LT)) return false;
	}
	return true;
}
