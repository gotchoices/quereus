import { registerWindowFunction, type WindowFunctionBinding } from '../../schema/window-function.js';
import type { AggregateFunctionSchema } from '../../schema/function.js';
import { bindAggregateSchema, cloneInitialValue, type AggValue } from '../registration.js';
import { avgFunc, countXFunc, sumFunc } from './aggregate.js';
import { INTEGER_RETURN_NOT_NULL, REAL_RETURN, REAL_RETURN_NOT_NULL } from './return-types.js';
import type { ScalarType } from '../../common/datatype.js';
import type { DeepReadonly, SqlValue } from '../../common/types.js';
import type { LogicalType } from '../../types/logical-type.js';
import { BINARY_COLLATION, compareSqlValuesFast, createSemanticValueComparator } from '../../util/comparison.js';
import { mergeSetOpAdvertisedType } from '../../planner/analysis/set-op-type-merge.js';

/**
 * Shared `inferReturnType` for pass-through window functions (MIN, MAX,
 * FIRST_VALUE, LAST_VALUE): the result follows arg[0]'s logical type because
 * the value is emitted unchanged at runtime. Each registration's fixed
 * `returnType` is the no-arg-types fallback.
 */
const passThroughArgType = (argTypes: ReadonlyArray<DeepReadonly<LogicalType>>): ScalarType => ({
	typeClass: 'scalar',
	logicalType: argTypes[0],
	nullable: true,
	isReadOnly: true
});

/**
 * LAG/LEAD `inferReturnType`: usually arg[0] passed through, but when the
 * offset runs off the partition the DEFAULT argument (arg[2]) is emitted
 * verbatim — one result column carrying values from two unconverted sources,
 * so the announced type folds both through the set-op merge rules
 * (`mergeSetOpAdvertisedType`: identical keeps, NULL yields, differing builtin
 * numerics → NUMERIC, irreconcilable → ANY). arg[1] (the offset) never
 * surfaces in the result and does not participate.
 */
const navigationArgType = (argTypes: ReadonlyArray<DeepReadonly<LogicalType>>): ScalarType => ({
	typeClass: 'scalar',
	logicalType: argTypes.length >= 3
		? mergeSetOpAdvertisedType(argTypes[0] as LogicalType, argTypes[2] as LogicalType)
		: argTypes[0],
	nullable: true,
	isReadOnly: true
});

/**
 * Window MIN/MAX step+final derived from ONE comparator — the window twin of
 * `extremumParts` in func/builtins/aggregate.ts. A raw JS `<` would disagree with
 * plain sorting for mixed storage classes (`5 < 'abc'` and `'abc' < 5` are both
 * false, so whichever arrived first wins), and would ignore semantic ordering
 * (TIMESPAN elapsed time, JSON structure) and collation entirely.
 *
 * Ties under a non-BINARY comparator ('a' vs 'A' under NOCASE, 'PT1H' vs 'PT60M'
 * for TIMESPAN) compare equal, so which raw value survives is unspecified — the
 * same latitude the MIN/MAX aggregate, DISTINCT, and GROUP BY take.
 */
function extremumWindowParts(
	direction: 'min' | 'max',
	compare: (a: SqlValue, b: SqlValue) => number,
): Required<Pick<WindowFunctionBinding, 'step' | 'final'>> {
	const wins = direction === 'min'
		? (candidate: SqlValue, incumbent: SqlValue): boolean => compare(candidate, incumbent) < 0
		: (candidate: SqlValue, incumbent: SqlValue): boolean => compare(candidate, incumbent) > 0;
	return {
		step: (state: SqlValue | undefined, value: SqlValue): SqlValue => {
			if (value === null) return state ?? null;   // Ignore NULLs
			if (state === null || state === undefined) return value; // First non-null value
			return wins(value, state) ? value : state;
		},
		final: (state: SqlValue | undefined): SqlValue => state ?? null,
	};
}

/**
 * Register window MIN or MAX. The registered default ranks by storage class under
 * BINARY — correct for untyped/ANY arguments and for any caller that never binds —
 * and `bindArgs` re-derives both hooks over the call site's semantic comparator, so
 * `min(x) over (…)` agrees with the `min(x)` aggregate and with `order by x limit 1`.
 */
function registerExtremumWindowFunction(direction: 'min' | 'max'): void {
	const defaults = extremumWindowParts(direction, (a, b) => compareSqlValuesFast(a, b, BINARY_COLLATION));
	registerWindowFunction({
		name: direction.toUpperCase(),
		argCount: 1,
		returnType: REAL_RETURN,
		// MIN/MAX pass the argument value through unchanged, so the result follows
		// the argument's logical type (mirrors the aggregate minFunc/maxFunc).
		inferReturnType: passThroughArgType,
		requiresOrderBy: false,
		kind: 'aggregate',
		step: defaults.step,
		final: defaults.final,
		bindArgs: (args) => extremumWindowParts(
			direction,
			createSemanticValueComparator(args[0]?.logicalType, args[0]?.collation),
		),
	});
}

/**
 * The window step / final / inverse of a plain aggregate: its own step and finalize,
 * so the window cannot sum, count, or coerce differently from the grouped aggregate.
 * The inverse is the retraction the `AggregateAlgebra` contract defines,
 * `merge(state, negate(step(identity, value)))`, present only when the algebra
 * declares both `merge` and `negate`. For sum (and avg, which accumulates as sum)
 * the exact-integer part retracts exactly.
 *
 * NOTE: the floating-point part of sum's accumulator retracts in float (accepted when
 * this adapter replaced the float window copies). A slid frame over REAL values can
 * therefore differ from a fresh fold — by more than the last digits under
 * cancellation (frame `1e20, 0.5` sliding to `0.5, 5` gives 5, not 5.5) — and an
 * inexact retraction leaves a residue for the rest of the partition, so a later
 * all-integer frame finalizes as a float (`5, 7` gives 11.5 after the same slide).
 * The streaming ROWS path is the only one affected; RANGE and buffered frames refold.
 */
function aggregateWindowParts(aggSchema: AggregateFunctionSchema): WindowFunctionBinding {
	const { stepFunction: step, finalizeFunction: finalize, algebra } = aggSchema;
	const merge = algebra?.merge;
	const negate = algebra?.negate;
	return {
		step,
		final: (state: AggValue) => finalize(state),
		inverse: merge && negate
			? (state: AggValue, value: SqlValue) => merge(state, negate(step(cloneInitialValue(aggSchema.initialValue), value)))
			: undefined,
	};
}

/**
 * Register a plain aggregate as a window function. Everything that decides a value —
 * step, finalize, initial accumulator, return type, and any call-site `bindArgs`
 * specialization — comes from the aggregate's schema, so no window shape (frame walk,
 * running, sliding) keeps a copy of the aggregate's arithmetic.
 */
function registerAggregateAsWindowFunction(aggSchema: AggregateFunctionSchema): void {
	const parts = aggregateWindowParts(aggSchema);
	const aggBindArgs = aggSchema.bindArgs;
	registerWindowFunction({
		name: aggSchema.name.toUpperCase(),
		argCount: aggSchema.numArgs < 0 ? 'variadic' : aggSchema.numArgs,
		returnType: aggSchema.returnType,
		inferReturnType: aggSchema.inferReturnType,
		requiresOrderBy: false,
		kind: 'aggregate',
		initial: () => cloneInitialValue(aggSchema.initialValue),
		step: parts.step,
		final: parts.final,
		inverse: parts.inverse,
		bindArgs: aggBindArgs && ((args) => aggregateWindowParts(bindAggregateSchema(aggSchema, args))),
	});
}

// Built-in window function schemas
export function registerBuiltinWindowFunctions(): void {
	// Ranking functions
	registerWindowFunction({
		name: 'ROW_NUMBER',
		argCount: 0,
		returnType: INTEGER_RETURN_NOT_NULL,
		requiresOrderBy: true,
		kind: 'ranking'
	});

	registerWindowFunction({
		name: 'RANK',
		argCount: 0,
		returnType: INTEGER_RETURN_NOT_NULL,
		requiresOrderBy: true,
		kind: 'ranking'
	});

	registerWindowFunction({
		name: 'DENSE_RANK',
		argCount: 0,
		returnType: INTEGER_RETURN_NOT_NULL,
		requiresOrderBy: true,
		kind: 'ranking'
	});

	registerWindowFunction({
		name: 'NTILE',
		argCount: 1,
		returnType: INTEGER_RETURN_NOT_NULL,
		requiresOrderBy: true,
		kind: 'ranking'
	});

	// Navigation functions
	registerWindowFunction({
		name: 'LAG',
		argCount: 'variadic',
		returnType: REAL_RETURN,
		// arg[0] passed through, folded with the optional default arg[2] — see
		// navigationArgType.
		inferReturnType: navigationArgType,
		requiresOrderBy: true,
		kind: 'navigation'
	});

	registerWindowFunction({
		name: 'LEAD',
		argCount: 'variadic',
		returnType: REAL_RETURN,
		// arg[0] passed through, folded with the optional default arg[2] — see
		// navigationArgType.
		inferReturnType: navigationArgType,
		requiresOrderBy: true,
		kind: 'navigation'
	});

	// Value functions (frame-dependent)
	registerWindowFunction({
		name: 'FIRST_VALUE',
		argCount: 1,
		returnType: REAL_RETURN,
		// FIRST_VALUE passes its argument value through unchanged, so the result
		// follows the argument's logical type (mirrors the MIN/MAX pattern).
		inferReturnType: passThroughArgType,
		requiresOrderBy: false,
		kind: 'value'
	});

	registerWindowFunction({
		name: 'LAST_VALUE',
		argCount: 1,
		returnType: REAL_RETURN,
		// LAST_VALUE passes its argument value through unchanged, so the result
		// follows the argument's logical type (mirrors the MIN/MAX pattern).
		inferReturnType: passThroughArgType,
		requiresOrderBy: false,
		kind: 'value'
	});

	// Statistical ranking functions
	registerWindowFunction({
		name: 'PERCENT_RANK',
		argCount: 0,
		returnType: REAL_RETURN_NOT_NULL,
		requiresOrderBy: true,
		kind: 'ranking'
	});

	registerWindowFunction({
		name: 'CUME_DIST',
		argCount: 0,
		returnType: REAL_RETURN_NOT_NULL,
		requiresOrderBy: true,
		kind: 'ranking'
	});

	// Aggregate functions as window functions — derived from the grouped aggregates so
	// `f(x) over (…)` and `f(x)` compute identically.
	registerAggregateAsWindowFunction(countXFunc);
	registerAggregateAsWindowFunction(sumFunc);
	registerAggregateAsWindowFunction(avgFunc);

	registerExtremumWindowFunction('min');
	registerExtremumWindowFunction('max');
}
