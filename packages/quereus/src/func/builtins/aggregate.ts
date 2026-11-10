import { createLogger } from '../../common/logger.js';
import { StatusCode, type SqlValue } from '../../common/types.js';
import { QuereusError } from '../../common/errors.js';
import type { AggregateAlgebra, AggregateFinalizer, AggregateFunctionSchema, AggregateReducer, ArgTypeValidator } from '../../schema/function.js';
import { createAggregateFunction } from '../registration.js';
import { compareSqlValuesFast, createSemanticValueComparator, getSqlDataTypeName, BINARY_COLLATION } from '../../util/comparison.js';
import { canonicalizeInteger } from '../../util/numeric-canonical.js';
import { isSummableType } from '../../types/builtin-types.js';
import { valueToText } from '../../util/value-text.js';
import { INTEGER_RETURN_NOT_NULL, NUMERIC_RETURN, REAL_RETURN, REAL_RETURN_NOT_NULL, TEXT_RETURN } from './return-types.js';

const log = createLogger('func:builtins:aggregate');
const warnLog = log.extend('warn');

/** Add two INTEGER-DOMAIN values exactly, promoting to BigInt when either side is
 *  BigInt or the numeric sum would leave the safe-integer range.
 *
 *  PRECONDITION: each operand is `isExactIntegerDomain` — a `bigint`, or a `number`
 *  satisfying `Number.isSafeInteger`. Callers route every other numeric value
 *  (fractions, whole numbers past the safe boundary, ±Infinity, NaN) to a separate
 *  floating-point accumulator, so the `BigInt()` conversions here cannot throw. */
function addWithPromotion(a: number | bigint, b: number | bigint): number | bigint {
	if (typeof a === 'bigint' || typeof b === 'bigint') {
		// Narrow a sum that retracts back inside the safe range (R1) — shared by the
		// SUM step and merge/negate maintenance, so a maintained view's stored
		// partial and a direct evaluation agree on representation.
		return canonicalizeInteger(BigInt(a) + BigInt(b));
	}
	const sum = a + b;
	if (sum > Number.MAX_SAFE_INTEGER || sum < Number.MIN_SAFE_INTEGER) {
		// No narrowing needed, and this is sound only BECAUSE of the precondition: two
		// SAFE integers whose float sum left the safe range have an exact sum outside it
		// (an in-range exact sum is float-representable, so the float sum would have been
		// exact and in range). Without the precondition the premise is false — `1e308`
		// is a whole `number` outside the safe range — which is why the routing rule,
		// not this branch, decides what is exact.
		return BigInt(a) + BigInt(b);
	}
	return sum;
}

/** SUM's routing rule: does this contribution belong to the exact-integer part?
 *
 *  Deliberately `Number.isSafeInteger`, NOT `Number.isInteger`: `1e308` is a whole
 *  `number` that is not exact in the integer sense (R1 permits it as a `number`), and
 *  routing it to the exact part is what turns a REAL fold's total into an
 *  arbitrary-precision integer — a `bigint` in a REAL-typed result, violating R2. */
function isExactIntegerDomain(v: number | bigint): boolean {
	return typeof v === 'bigint' || Number.isSafeInteger(v);
}

// --- count(*) ---
export const countStarFunc = createAggregateFunction(
	{
		name: 'count', numArgs: 0, initialValue: 0,
		returnType: INTEGER_RETURN_NOT_NULL,
		algebra: {
			merge: (a: number, b: number): number => a + b,
			negate: (a: number): number => -a,
			// finalize is identity — the stored count IS the accumulator
			decode: (stored: SqlValue): number => Number(stored),
			decodeExact: true,
		},
	},
	(acc: number): number => acc + 1,
	(acc: number): number => acc
);

// --- What sum, avg and total accept ---
// Numbers add, booleans add as 1 / 0, NULL is skipped, and anything else is an error —
// never skipped. Skipping is what let avg's sum/count decomposition disagree with a
// direct avg: count(x) counts every non-NULL value, so every value it counts must be one
// sum either added or refused. A TEXT, JSON, BLOB or temporal argument is refused at
// prepare time; a value of those kinds can still arrive through an untyped (ANY)
// argument, and the step refuses it then. Departs from SQLite, which reads numeric text
// as a number and skips the rest.

const CAST_HINT = 'use cast(x as integer) or cast(x as real)';

/** Prepare-time gate shared by sum, avg and total — see {@link isSummableType}. */
const validateSummableArg: ArgTypeValidator = (argTypes) =>
	isSummableType(argTypes[0]) || `requires a numeric or boolean argument, got ${argTypes[0].name}; ${CAST_HINT}`;

/** One value as sum/avg/total add it: the number, 1 / 0 for a boolean, or null (skip)
 *  for NULL. Throws for every other value. `label` names the aggregate for the error. */
function toSummand(label: string, value: SqlValue): number | bigint | null {
	if (value === null) return null;
	if (typeof value === 'number' || typeof value === 'bigint') return value;
	if (typeof value === 'boolean') return value ? 1 : 0;
	throw new QuereusError(
		`${label}: cannot add a ${getSqlDataTypeName(value)} value; ${CAST_HINT}`,
		StatusCode.MISMATCH,
	);
}

// --- SUM(X) ---
// The accumulator SPLITS the two number domains and never mixes them until finalize.
// One slot cannot decide per addition whether the running total is an exact integer
// or a float: promoting both sides because one is a bigint throws on a fractional
// side, and reinterpreting an overflowing FLOAT sum as an exact integer computation
// is only valid when both operands were safe integers. Either way the answer depends
// on the order rows happened to arrive, which breaks merge-associativity and so
// materialized-view maintenance.
//
// The count of counted (non-NULL) contributions rides alongside so retraction
// stays observational: merge(a, negate(a)) must finalize to NULL (the empty-group
// value), which a bare running sum cannot distinguish from contributions cancelling
// to 0. A fold that counted nothing still finalizes to NULL.
//
// `realCount` does the same for the floating-point part: the result's storage class
// follows what the accumulator currently HOLDS, not whether its float total happens to
// be 0. A window frame that slides past its last REAL value retracts back to an exact
// total, and a fold whose REAL values cancel to 0 is still a REAL total (as in SQLite).
type SumAccumulator = {
	/** Exact integer part: every `bigint` and every safe-integer `number` contribution. */
	exact: number | bigint;
	/** Floating-point part: everything else — fractions, whole numbers outside the
	 *  safe-integer range, ±Infinity, NaN. Its true value is `approx + comp`.
	 *
	 *  NOTE: compensated (Neumaier) summation, so a large value cancelling out — added
	 *  and later retracted by a sliding window frame — does not take the small values
	 *  added beside it with it. It reduces rounding error; it does not make REAL
	 *  retraction exact, and re-associating rows can still shift the last digits. That
	 *  is why the delta-maintenance gate still refuses a REAL argument (see `decode`
	 *  below); revisit only if a REAL sum ever needs the fast path, which is a design
	 *  change and not a relaxation of that gate. */
	approx: number;
	/** Neumaier compensation: the accumulated rounding error of the additions into `approx`. */
	comp: number;
	/** How many contributions currently held went to `approx`. When it returns to 0,
	 *  `merge` resets `approx` and `comp` to exactly 0, discarding the residue an
	 *  inexact retraction leaves behind. */
	realCount: number;
	count: number;
} | null;

/** The rounding error of `sum = a + b` (Neumaier's two-sum): the exact sum is
 *  `sum + error`. A non-finite `sum` has no error to recover — the formula would give
 *  NaN (`Infinity - Infinity`) — so it contributes 0 and finalize uses `approx` alone. */
function additionError(a: number, b: number, sum: number): number {
	if (!Number.isFinite(sum)) return 0;
	return Math.abs(a) >= Math.abs(b) ? (a - sum) + b : (b - sum) + a;
}

/** Fold one numeric contribution into the accumulator, routing it by `isExactIntegerDomain`. */
function addSumContribution(acc: SumAccumulator, value: number | bigint): SumAccumulator {
	const base = acc ?? { exact: 0, approx: 0, comp: 0, realCount: 0, count: 0 };
	if (isExactIntegerDomain(value)) {
		return { ...base, exact: addWithPromotion(base.exact, value), count: base.count + 1 };
	}
	const real = value as number;
	const approx = base.approx + real;
	return {
		exact: base.exact,
		approx,
		comp: base.comp + additionError(base.approx, real, approx),
		realCount: base.realCount + 1,
		count: base.count + 1,
	};
}

/** SUM's step. Also AVG's: avg accumulates exactly as sum does (see avgFunc), so the
 *  two share this one step and its error. NULL is skipped; a value that is not a number
 *  or boolean throws (see toSummand). */
function stepSum(acc: SumAccumulator, value: SqlValue): SumAccumulator {
	const summand = toSummand('sum/avg', value);
	return summand === null ? acc : addSumContribution(acc, summand);
}

function mergeSum(a: SumAccumulator, b: SumAccumulator): SumAccumulator {
	if (a === null) return b;
	if (b === null) return a;
	// Each part combines within its own domain — the exact parts exactly, the
	// approx parts in compensated float. Mixing them here is what made the fold
	// order-dependent.
	const exact = addWithPromotion(a.exact, b.exact);
	const count = a.count + b.count;
	const realCount = a.realCount + b.realCount;
	// No REAL contribution left (a sliding frame retracted its last one): whatever
	// remains in approx/comp is rounding residue, not value.
	if (realCount === 0) return { exact, approx: 0, comp: 0, realCount, count };
	const approx = a.approx + b.approx;
	return { exact, approx, comp: a.comp + b.comp + additionError(a.approx, b.approx, approx), realCount, count };
}

function negateSum(a: SumAccumulator): SumAccumulator {
	return a === null
		? null
		: { exact: -a.exact, approx: -a.approx, comp: -a.comp, realCount: -a.realCount, count: -a.count };
}

function finalizeSum(acc: SumAccumulator): number | bigint | null {
	// SQLite returns NULL for SUM of empty set, INTEGER or REAL result.
	// count === 0 (all contributions retracted) is observationally the empty group.
	if (acc === null || acc.count === 0) return null;
	// An accumulator holding only exact contributions finalizes to its exact part
	// untouched (still R1-canonical); one holding a REAL contribution combines, and
	// lands in float even when its REAL parts cancel to 0.
	if (acc.realCount === 0) return acc.exact;
	// NOTE: a non-finite total propagates (±Infinity, and NaN for Infinity + -Infinity)
	// rather than becoming NULL. Deliberate: sum matches the other float-summing
	// aggregates, `total()` and `avg()`, over identical rows. Binary `+` is the
	// outlier — `runtime/emit/binary.ts` nulls a non-finite result — so a caller
	// comparing `sum(v)` against a hand-written `a + b` sees them diverge at overflow.
	// NOTE: a non-finite approx does not survive retraction: a sliding window frame that
	// drops an Infinity (or an addend of a finite total that overflowed) leaves NaN or
	// Infinity in approx while other REAL values remain, so the frame finalizes
	// non-finite until no REAL value is left in it. Tracked as
	// `backlog/bug-sliding-window-sum-poisoned-by-non-finite-real`.
	const real = Number.isFinite(acc.approx) ? acc.approx + acc.comp : acc.approx;
	return Number(acc.exact) + real;
}

export const sumFunc = createAggregateFunction(
	{
		name: 'sum', numArgs: 1, initialValue: null,
		// NUMERIC (number | bigint), not REAL, and deliberately NOT narrowed by the
		// argument's static type: the exact/approx routing below is per-VALUE
		// (`isExactIntegerDomain`), so even a REAL-typed argument whose rows happen to
		// hold safe integers accumulates in the exact part and can finalize a `bigint`
		// past 2^53 (`addWithPromotion`). No static argument type promises `number`.
		returnType: NUMERIC_RETURN,
		validateArgTypes: validateSummableArg,
		// NOTE: declared unconditionally; exactness under retraction is a value-domain
		// property (floats drift) the function cannot see, so the write-side delta arm
		// gates on the argument's static type before exploiting negate.
		algebra: {
			merge: mergeSum,
			negate: negateSum,
			// Stored NULL (empty group) decodes to the empty accumulator, never a
			// wrapped NULL. A stored value decodes with an ABSORBING count witness
			// (Infinity): the stored sum cannot recover the true non-NULL contribution
			// count, so the witness must (a) be non-zero (the group is non-empty) and
			// (b) STAY non-zero under any finite retraction — a finite witness (e.g. 1)
			// would collapse to 0 on the first retraction and finalize a spurious NULL
			// while contributions remain. This is deliberately NOT `decodeExact`: the
			// delta arm may retract through this decode only when it can prove the true
			// count stays positive (NOT NULL argument + multiplicity witness), and
			// otherwise re-derives the group from live source state.
			// NOTE: type-trusts its input — a non-numeric stored value poisons the
			// accumulator. Sound while the only caller is the delta arm reading back a
			// value this same aggregate wrote.
			// NOTE: OBSERVATIONAL DOMAIN IS THE EXACT-INTEGER PART ONLY. The backing table
			// stores one finalized value per group, which cannot carry the exact/approx
			// split apart — a fold that saw both parts cannot be reconstructed from it, and
			// no single-slot representation could. The write side already guards this: the
			// delta-aggregate arm only delta-maintains `sum` over an INTEGER-physical
			// argument column ("exact numeric domain" gate,
			// core/database-materialized-views-plan-builders.ts), where the approx part is
			// always empty and this decode IS observational. Do not relax that gate without
			// giving the backing store somewhere to keep both parts.
			// A float stored value gets an absorbing `realCount` for the same reason `count`
			// is absorbing: its REAL contributions are unknown, so a finite retraction must
			// not reach realCount 0 and reset the float part away.
			decode: (stored: SqlValue): SumAccumulator => {
				if (stored === null) return null;
				const value = stored as number | bigint;
				const count = Number.POSITIVE_INFINITY;
				return isExactIntegerDomain(value)
					? { exact: value, approx: 0, comp: 0, realCount: 0, count }
					: { exact: 0, approx: value as number, comp: 0, realCount: Number.POSITIVE_INFINITY, count };
			},
		},
	},
	stepSum,
	finalizeSum,
);

// --- AVG(X) ---
// Accumulates exactly as SUM does — the same accumulator, step, merge, and negate —
// and divides only at finalize. The numerator is therefore sum's exact total (a float
// running sum loses whole numbers past 2^53), and the divisor is sum's count of
// contributions: every non-NULL value, because a value sum cannot add raises instead of
// being skipped. That is what lets the decomposition use count(x) as its divisor.
// Direct evaluation and the sum/count decomposition share one quotient
// (`avgQuotient`), so the two cannot drift apart.

/** avg's value from a sum total and a contribution count; an empty group (count 0 /
 *  NULL) ⇒ NULL. Real division, so the result is always a float. */
function avgQuotient(sumTotal: SqlValue, count: SqlValue): number | null {
	if (count === null || count === undefined || Number(count) === 0) return null;
	return Number(sumTotal) / Number(count);
}

export const avgFunc = createAggregateFunction(
	{
		name: 'avg', numArgs: 1, initialValue: null,
		returnType: REAL_RETURN,
		validateArgTypes: validateSummableArg,
		// No decode — the stored quotient forgets the count and cannot reconstruct
		// an accumulator. Maintained/rolled up via its decomposition instead.
		algebra: {
			merge: mergeSum,
			negate: negateSum,
			decompose: {
				partials: [
					{ func: 'sum', arg: 'same-arg' },
					{ func: 'count', arg: 'same-arg' },
				],
				combine: (partialValues: readonly SqlValue[]): SqlValue => avgQuotient(partialValues[0], partialValues[1]),
			},
		},
	},
	stepSum,
	(acc: SumAccumulator): number | null => avgQuotient(finalizeSum(acc), acc?.count ?? 0),
);

// --- MIN(X) / MAX(X) ---
// One aggregate with the sign flipped: a fold keeping whichever value the
// comparator ranks first (min) or last (max). The factory derives step, merge,
// decode, and finalize from ONE comparator, so step and merge can never rank
// differently — that agreement is what keeps materialized-view maintenance
// (algebra.merge) byte-identical to direct evaluation (stepFunction).
//
// The registered default compares by storage class under BINARY (correct for
// untyped/ANY arguments, and for any consumer that never binds); `bindArgs`
// re-derives the whole set over the argument's semantic-ordering comparator
// (createSemanticValueComparator: TIMESPAN → elapsed time, JSON → structural,
// collated TEXT → the declared collation), so `min(x)` agrees with
// `order by x limit 1` at every call site.
//
// Ties under a non-BINARY comparator ('a' vs 'A' under NOCASE, 'PT1H' vs
// 'PT60M' for TIMESPAN) compare equal, so which raw value survives is
// unspecified — the same latitude DISTINCT and GROUP BY take when choosing a
// group representative.
type ExtremumAccumulator = { v: SqlValue } | null;

function extremumParts(
	direction: 'min' | 'max',
	compare: (a: SqlValue, b: SqlValue) => number,
): { stepFunction: AggregateReducer; finalizeFunction: AggregateFinalizer; algebra: AggregateAlgebra } {
	const wins = direction === 'min'
		? (candidate: SqlValue, incumbent: SqlValue): boolean => compare(candidate, incumbent) < 0
		: (candidate: SqlValue, incumbent: SqlValue): boolean => compare(candidate, incumbent) > 0;
	return {
		stepFunction: (acc: ExtremumAccumulator, value: SqlValue): ExtremumAccumulator => {
			if (value === null) return acc; // Ignore NULLs
			if (acc === null) return { v: value }; // First non-null value
			return wins(value, acc.v) ? { v: value } : acc;
		},
		// Tighten-only: merge but no negate (a retracted extremum cannot be undone locally).
		algebra: {
			merge: (a: ExtremumAccumulator, b: ExtremumAccumulator): ExtremumAccumulator => {
				if (a === null) return b;
				if (b === null) return a;
				return wins(b.v, a.v) ? b : a;
			},
			// Stored NULL (empty group) decodes to the empty accumulator.
			decode: (stored: SqlValue): ExtremumAccumulator => stored === null ? null : { v: stored },
		},
		finalizeFunction: (acc: ExtremumAccumulator): SqlValue => acc?.v ?? null,
	};
}

function createExtremumFunction(direction: 'min' | 'max'): AggregateFunctionSchema {
	const defaults = extremumParts(direction, (a, b) => compareSqlValuesFast(a, b, BINARY_COLLATION));
	return createAggregateFunction(
		{
			name: direction,
			numArgs: 1,
			initialValue: null,
			// Type inference: return the same type as the input argument
			inferReturnType: (argTypes) => ({
				typeClass: 'scalar',
				logicalType: argTypes[0],
				nullable: true, // NULL if all values are NULL or no rows
				isReadOnly: true
			}),
			algebra: defaults.algebra,
			bindArgs: (args) =>
				extremumParts(direction, createSemanticValueComparator(args[0]?.logicalType, args[0]?.collation)),
		},
		defaults.stepFunction,
		defaults.finalizeFunction,
	);
}

export const minFunc = createExtremumFunction('min');
export const maxFunc = createExtremumFunction('max');

// --- COUNT(X) ---
// Counts non-NULL values of X
export const countXFunc = createAggregateFunction(
	{
		name: 'count', numArgs: 1, initialValue: 0,
		returnType: INTEGER_RETURN_NOT_NULL,
		algebra: {
			merge: (a: number, b: number): number => a + b,
			negate: (a: number): number => -a,
			// finalize is identity — the stored count IS the accumulator
			decode: (stored: SqlValue): number => Number(stored),
			decodeExact: true,
		},
	},
	(acc: number, value: SqlValue): number => {
		if (value === null) return acc; // Do not count NULLs
		return acc + 1;
	},
	(acc: number): number => acc
);

// --- GROUP_CONCAT(X, Y?) ---
interface GroupConcatAccumulator {
	values: string[];
	separator: string;
}
export const groupConcatFuncRev = createAggregateFunction(
	{ name: 'group_concat', numArgs: -1, initialValue: () => ({ values: [], separator: ',' }), returnType: TEXT_RETURN },
	(acc: GroupConcatAccumulator, value: SqlValue, separator: SqlValue = ','): GroupConcatAccumulator => {
		const currentSeparator = (separator === undefined || separator === null) ? acc.separator : valueToText(separator);
		acc.separator = currentSeparator;

		if (value === null) {
			return acc;
		}

		acc.values.push(valueToText(value));
		return acc;
	},
	(acc: GroupConcatAccumulator): string | null => {
		if (acc.values.length === 0) {
			return null;
		}
		return acc.values.join(acc.separator);
	}
);

// --- TOTAL(X) ---
// Accepts what sum accepts (toSummand), but always adds in floating point and returns
// 0.0 rather than NULL for an empty set.
// NOTE: deliberately declares no algebra — a float running sum drifts under
// retraction and would diverge byte-exactly from a fresh live re-sum, which the
// maintenance-equivalence oracle compares byte-exactly. Residual-only is correct,
// just not incremental. Same for group_concat / var_* / stddev_* below.
export const totalFunc = createAggregateFunction(
	{ name: 'total', numArgs: 1, initialValue: 0.0, returnType: REAL_RETURN_NOT_NULL, validateArgTypes: validateSummableArg },
	(acc: number, value: SqlValue): number => {
		const summand = toSummand('total', value);
		return summand === null ? acc : acc + Number(summand);
	},
	(acc: number): number => acc // Returns 0.0 for empty set or only NULL inputs
);

// --- Statistical Aggregates (Variance, Standard Deviation) ---
interface StatAccumulator {
	count: number;
	sum: number;
	sumSq: number;
}

// NOTE: still skips non-numbers (and reads numeric text as a number), unlike
// sum/avg/total, which raise. Safe because these declare no algebra, so no materialized
// view can disagree with them; aligning them with sum is a separate decision.
const statReducer = (acc: StatAccumulator, value: SqlValue): StatAccumulator => {
	if (value === null) {
		return acc; // Ignore NULLs
	}
	try {
		const numValue = Number(value);
		if (isNaN(numValue)) {
			return acc; // Ignore non-numeric
		}
		// Use floating-point for calculations
		return {
			count: acc.count + 1,
			sum: acc.sum + numValue,
			sumSq: acc.sumSq + (numValue * numValue),
		};
	} catch (e) {
		warnLog("Error during statistical aggregate step coercion: %O", e);
		return acc;
	}
};

// Population Variance (VAR_POP)
export const varPopFunc = createAggregateFunction(
	{ name: 'var_pop', numArgs: 1, initialValue: { count: 0, sum: 0, sumSq: 0 }, returnType: REAL_RETURN },
	statReducer,
	(acc: StatAccumulator): number | null => {
		if (acc.count === 0) return null; // NULL for empty set
		const avg = acc.sum / acc.count;
		const variance = (acc.sumSq / acc.count) - (avg * avg);
		return variance;
	}
);

// Sample Variance (VAR_SAMP)
export const varSampFunc = createAggregateFunction(
	{ name: 'var_samp', numArgs: 1, initialValue: { count: 0, sum: 0, sumSq: 0 }, returnType: REAL_RETURN },
	statReducer,
	(acc: StatAccumulator): number | null => {
		if (acc.count <= 1) return null; // NULL if count is 0 or 1
		// Sample variance: (sumSq - n*avg^2) / (n-1) == (sumSq - sum*sum/n) / (n-1)
		const variance = (acc.sumSq - (acc.sum * acc.sum) / acc.count) / (acc.count - 1);
		return variance;
	}
);

// Population Standard Deviation (STDDEV_POP)
export const stdDevPopFunc = createAggregateFunction(
	{ name: 'stddev_pop', numArgs: 1, initialValue: { count: 0, sum: 0, sumSq: 0 }, returnType: REAL_RETURN },
	statReducer,
	(acc: StatAccumulator): number | null => {
		if (acc.count === 0) return null;
		const avg = acc.sum / acc.count;
		const variance = (acc.sumSq / acc.count) - (avg * avg);
		return variance < 0 ? null : Math.sqrt(variance);
	}
);

// Sample Standard Deviation (STDDEV_SAMP)
export const stdDevSampFunc = createAggregateFunction(
	{ name: 'stddev_samp', numArgs: 1, initialValue: { count: 0, sum: 0, sumSq: 0 }, returnType: REAL_RETURN },
	statReducer,
	(acc: StatAccumulator): number | null => {
		if (acc.count <= 1) return null;
		const variance = (acc.sumSq - (acc.sum * acc.sum) / acc.count) / (acc.count - 1);
		return variance < 0 ? null : Math.sqrt(variance);
	}
);
