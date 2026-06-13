import { registerWindowFunction } from '../../schema/window-function.js';
import { AggValue } from '../registration.js';
import { INTEGER_TYPE, REAL_TYPE } from '../../types/builtin-types.js';
import type { ScalarType } from '../../common/datatype.js';
import type { DeepReadonly } from '../../common/types.js';
import type { LogicalType } from '../../types/logical-type.js';

/**
 * Shared `inferReturnType` for pass-through window functions (MIN, MAX,
 * FIRST_VALUE, LAST_VALUE, LAG, LEAD): the result follows arg[0]'s logical
 * type because the value is emitted unchanged at runtime. Only arg[0] (the
 * value expression) participates — LAG/LEAD's offset and default arguments do
 * not widen the result. Each registration's fixed `returnType` is the
 * no-arg-types fallback.
 */
const passThroughArgType = (argTypes: ReadonlyArray<DeepReadonly<LogicalType>>): ScalarType => ({
	typeClass: 'scalar',
	logicalType: argTypes[0],
	nullable: true,
	isReadOnly: true
});

// Built-in window function schemas
export function registerBuiltinWindowFunctions(): void {
	// Ranking functions
	registerWindowFunction({
		name: 'ROW_NUMBER',
		argCount: 0,
		returnType: {
			typeClass: 'scalar',
			logicalType: INTEGER_TYPE,
			nullable: false,
			isReadOnly: true
		},
		requiresOrderBy: true,
		kind: 'ranking'
	});

	registerWindowFunction({
		name: 'RANK',
		argCount: 0,
		returnType: {
			typeClass: 'scalar',
			logicalType: INTEGER_TYPE,
			nullable: false,
			isReadOnly: true
		},
		requiresOrderBy: true,
		kind: 'ranking'
	});

	registerWindowFunction({
		name: 'DENSE_RANK',
		argCount: 0,
		returnType: {
			typeClass: 'scalar',
			logicalType: INTEGER_TYPE,
			nullable: false,
			isReadOnly: true
		},
		requiresOrderBy: true,
		kind: 'ranking'
	});

	registerWindowFunction({
		name: 'NTILE',
		argCount: 1,
		returnType: {
			typeClass: 'scalar',
			logicalType: INTEGER_TYPE,
			nullable: false,
			isReadOnly: true
		},
		requiresOrderBy: true,
		kind: 'ranking'
	});

	// Navigation functions
	registerWindowFunction({
		name: 'LAG',
		argCount: 'variadic',
		returnType: {
			typeClass: 'scalar',
			logicalType: REAL_TYPE,
			nullable: true,
			isReadOnly: true
		},
		// LAG passes arg[0] (the value expression) through unchanged; arg[1] is the
		// offset and arg[2] is an optional default — their types do not widen the result.
		inferReturnType: passThroughArgType,
		requiresOrderBy: true,
		kind: 'navigation'
	});

	registerWindowFunction({
		name: 'LEAD',
		argCount: 'variadic',
		returnType: {
			typeClass: 'scalar',
			logicalType: REAL_TYPE,
			nullable: true,
			isReadOnly: true
		},
		// LEAD passes arg[0] (the value expression) through unchanged; arg[1] is the
		// offset and arg[2] is an optional default — their types do not widen the result.
		inferReturnType: passThroughArgType,
		requiresOrderBy: true,
		kind: 'navigation'
	});

	// Value functions (frame-dependent)
	registerWindowFunction({
		name: 'FIRST_VALUE',
		argCount: 1,
		returnType: {
			typeClass: 'scalar',
			logicalType: REAL_TYPE,
			nullable: true,
			isReadOnly: true
		},
		// FIRST_VALUE passes its argument value through unchanged, so the result
		// follows the argument's logical type (mirrors the MIN/MAX pattern).
		inferReturnType: passThroughArgType,
		requiresOrderBy: false,
		kind: 'value'
	});

	registerWindowFunction({
		name: 'LAST_VALUE',
		argCount: 1,
		returnType: {
			typeClass: 'scalar',
			logicalType: REAL_TYPE,
			nullable: true,
			isReadOnly: true
		},
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
		returnType: {
			typeClass: 'scalar',
			logicalType: REAL_TYPE,
			nullable: false,
			isReadOnly: true
		},
		requiresOrderBy: true,
		kind: 'ranking'
	});

	registerWindowFunction({
		name: 'CUME_DIST',
		argCount: 0,
		returnType: {
			typeClass: 'scalar',
			logicalType: REAL_TYPE,
			nullable: false,
			isReadOnly: true
		},
		requiresOrderBy: true,
		kind: 'ranking'
	});

	// Aggregate functions as window functions
	registerWindowFunction({
		name: 'COUNT',
		argCount: 1,
		returnType: {
			typeClass: 'scalar',
			logicalType: INTEGER_TYPE,
			nullable: false,
			isReadOnly: true
		},
		requiresOrderBy: false,
		kind: 'aggregate',
		step: (state: AggValue, value: AggValue) => {
			if (state === null || state === undefined) {
				state = 0;
			}
			return value !== null ? state + 1 : state;
		},
		final: (state: AggValue) => state || 0
	});

	registerWindowFunction({
		name: 'SUM',
		argCount: 1,
		returnType: {
			typeClass: 'scalar',
			logicalType: REAL_TYPE,
			nullable: true,
			isReadOnly: true
		},
		requiresOrderBy: false,
		kind: 'aggregate',
		step: (state: AggValue, value: AggValue) => {
			if (value === null) return state;
			if (state === null || state === undefined) {
				return Number(value);
			}
			return state + Number(value);
		},
		final: (state: AggValue) => state
	});

	registerWindowFunction({
		name: 'AVG',
		argCount: 1,
		returnType: {
			typeClass: 'scalar',
			logicalType: REAL_TYPE,
			nullable: true,
			isReadOnly: true
		},
		requiresOrderBy: false,
		kind: 'aggregate',
		step: (state: AggValue, value: AggValue) => {
			if (value === null) return state;
			if (!state) {
				state = { sum: 0, count: 0 };
			}
			state.sum += Number(value);
			state.count += 1;
			return state;
		},
		final: (state: AggValue) => state ? state.sum / state.count : null
	});

	registerWindowFunction({
		name: 'MIN',
		argCount: 1,
		returnType: {
			typeClass: 'scalar',
			logicalType: REAL_TYPE,
			nullable: true,
			isReadOnly: true
		},
		// MIN passes the argument value through unchanged, so the result follows
		// the argument's logical type (mirrors the aggregate minFunc).
		inferReturnType: passThroughArgType,
		requiresOrderBy: false,
		kind: 'aggregate',
		step: (state: AggValue, value: AggValue) => {
			if (value === null) return state;
			if (state === null || state === undefined) {
				return value;
			}
			return value < state ? value : state;
		},
		final: (state: AggValue) => state
	});

	registerWindowFunction({
		name: 'MAX',
		argCount: 1,
		returnType: {
			typeClass: 'scalar',
			logicalType: REAL_TYPE,
			nullable: true,
			isReadOnly: true
		},
		// MAX passes the argument value through unchanged, so the result follows
		// the argument's logical type (mirrors the aggregate maxFunc).
		inferReturnType: passThroughArgType,
		requiresOrderBy: false,
		kind: 'aggregate',
		step: (state: AggValue, value: AggValue) => {
			if (value === null) return state;
			if (state === null || state === undefined) {
				return value;
			}
			return value > state ? value : state;
		},
		final: (state: AggValue) => state
	});
}
