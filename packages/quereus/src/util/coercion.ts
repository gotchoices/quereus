import type { SqlValue } from '../common/types.js';
import { integerFromDigits } from './numeric-canonical.js';

/**
 * SQL type coercion utilities.
 * Different SQL contexts have different coercion rules.
 */

/**
 * What a piece of text means as a number: the single text-to-number rule behind arithmetic,
 * unary operators and aggregate-argument conversion. A whole-number digit string
 * past the safe-integer range is an exact `bigint`, agreeing with `cast(... as integer)`;
 * everything else keeps `Number()`'s reading. NaN means "names no number" — each caller
 * maps that to its own rule.
 */
export function parseNumericText(text: string): number | bigint {
	const trimmed = text.trim();
	const approx = Number(trimmed);
	// NaN and everything inside the safe range: Number() was already exact or is float by nature.
	if (!(Math.abs(approx) > Number.MAX_SAFE_INTEGER)) return approx;
	// NOTE: hex past 2^53 ('0x20000000000001') keeps Number()'s rounding. `cast` reads that
	// text as 0, so there is no exact sibling for it to agree with; if `cast` ever learns
	// hex, widen this test to match.
	return /^[+-]?\d+$/.test(trimmed) ? integerFromDigits(trimmed) : approx;
}

/**
 * Attempts to convert a value to a number if it's a numeric string: exact (`bigint`) for
 * a whole number past the safe-integer range, per {@link parseNumericText}.
 * Returns the original value if conversion is not appropriate.
 */
export function tryCoerceToNumber(value: SqlValue): SqlValue {
	if (typeof value === 'string' && value.trim() !== '') {
		const parsed = parseNumericText(value);
		if (typeof parsed === 'bigint' || Number.isFinite(parsed)) return parsed;
	}
	return value;
}

/**
 * Converts a value to a number for arithmetic contexts.
 * Non-numeric strings become 0 (SQL arithmetic semantics); numeric strings read per
 * {@link parseNumericText}, so one past the safe-integer range stays exact as a `bigint`.
 * Used for +, -, *, /, % operations.
 */
export function coerceToNumberForArithmetic(value: SqlValue): number | bigint {
	if (typeof value === 'number' || typeof value === 'bigint') {
		return value;
	} else if (typeof value === 'boolean') {
		return value ? 1 : 0;
	} else if (typeof value === 'string') {
		const parsed = parseNumericText(value);
		return typeof parsed === 'number' && isNaN(parsed) ? 0 : parsed; // Non-numeric strings become 0
	} else {
		return 0; // Blobs, null, etc. become 0
	}
}

/**
 * Reads a non-null unary-operator operand as a number. NaN means the operand names no
 * number, which the unary operators turn into NULL rather than arithmetic's 0.
 */
export function coerceUnaryOperand(value: SqlValue): number | bigint {
	if (typeof value === 'string') return parseNumericText(value);
	return typeof value === 'bigint' ? value : Number(value);
}

/**
 * Performs SQL type coercion for comparison operations.
 * If one operand is numeric and the other is text that can be converted to a number,
 * converts the text to a number before comparison.
 *
 * @deprecated Cross-category coercion is now inserted at plan time via explicit
 * CastNodes in the planner. This function is no longer called from comparison or
 * BETWEEN emission and will be removed in a future release.
 */
export function coerceForComparison(v1: SqlValue, v2: SqlValue): [SqlValue, SqlValue] {
	// If either value is null, no coercion needed
	if (v1 === null || v2 === null) {
		return [v1, v2];
	}

	const v1IsNumeric = typeof v1 === 'number' || typeof v1 === 'bigint' || typeof v1 === 'boolean';
	const v2IsNumeric = typeof v2 === 'number' || typeof v2 === 'bigint' || typeof v2 === 'boolean';
	const v1IsText = typeof v1 === 'string';
	const v2IsText = typeof v2 === 'string';

	// Case 1: v1 is numeric, v2 is text -> try to convert v2 to numeric
	if (v1IsNumeric && v2IsText) {
		const coercedV2 = tryCoerceToNumber(v2);
		return [v1, coercedV2];
	}

	// Case 2: v1 is text, v2 is numeric -> try to convert v1 to numeric
	if (v1IsText && v2IsNumeric) {
		const coercedV1 = tryCoerceToNumber(v1);
		return [coercedV1, v2];
	}

	// No coercion needed or possible
	return [v1, v2];
}

/** Aggregates whose arguments are never pre-converted from text. MIN and MAX rank values
 *  in the argument's own order, so `min(text_col)` agrees with `order by text_col limit 1`.
 *  SUM, AVG and TOTAL refuse text outright (func/builtins/aggregate.ts, `toSummand`), so a
 *  numeric string arriving through an untyped argument must reach them as text to raise. */
const UNCOERCED_AGGREGATES = new Set(['COUNT', 'GROUP_CONCAT', 'MIN', 'MAX', 'SUM', 'AVG', 'TOTAL']);

/**
 * Does this aggregate read numeric-looking text arguments as numbers? False for COUNT,
 * GROUP_CONCAT, MIN, MAX, SUM, AVG, TOTAL and the `JSON_*` family, which take their
 * arguments as-is. True for the rest — the var/stddev family and user aggregates.
 *
 * Split out so the routing decision has one home: the aggregate emitters resolve it once
 * per call site at emit time (`computeAggregateValueTransforms`,
 * runtime/emit/aggregate-setup.ts) rather than per row, and must reach the same verdict
 * this function does.
 */
export function aggregateCoercesArguments(functionName: string): boolean {
	const upperName = functionName.toUpperCase();
	return !UNCOERCED_AGGREGATES.has(upperName) && !upperName.startsWith('JSON_');
}

/**
 * The value-level half of aggregate-argument coercion: a numeric-looking string becomes
 * a number, everything else passes through. Callers that have already established the
 * aggregate coerces at all (see {@link aggregateCoercesArguments}) use this directly.
 */
export function coerceAggregateValue(value: SqlValue): SqlValue {
	return tryCoerceToNumber(value);
}

/**
 * Coerces a value for aggregate function arguments: a numeric-looking string becomes a
 * number for the aggregates {@link aggregateCoercesArguments} says coerce (var/stddev,
 * user aggregates). COUNT, MIN/MAX, GROUP_CONCAT, JSON_* and SUM/AVG/TOTAL see the value
 * unchanged — SUM/AVG/TOTAL reject text rather than read it as a number.
 */
export function coerceForAggregate(value: SqlValue, functionName: string): SqlValue {
	return aggregateCoercesArguments(functionName) ? coerceAggregateValue(value) : value;
}

/**
 * Determines if a value should be treated as numeric in the given context.
 */
export function isNumericValue(value: SqlValue): boolean {
	if (value === null) return false;
	if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
		return true;
	}
	if (typeof value === 'string') {
		return tryCoerceToNumber(value) !== value;
	}
	return false;
}
