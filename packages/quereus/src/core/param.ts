import type { ScalarType } from '../common/datatype.js';
import { type SqlParameters, type SqlValue } from '../common/types.js';
import { inferLogicalTypeFromValue } from '../common/type-inference.js';

/**
 * Generate type hints for parameters based on their JavaScript values.
 * This is used during planning to assign strong types to parameters.
 *
 * Type inference rules:
 * - null → NULL
 * - number (integer) → INTEGER
 * - number (float) → REAL
 * - bigint → INTEGER
 * - boolean → BOOLEAN
 * - string → TEXT
 * - Uint8Array → BLOB
 *
 * @param params The parameter values (positional array or named object)
 * @returns Map of parameter keys to their inferred ScalarTypes
 */
export function getParameterTypes(params: SqlParameters | undefined): Map<string | number, ScalarType> | undefined {
	let results: Map<string | number, ScalarType> | undefined;
	if (params) {
		results = new Map<string | number, ScalarType>();
		if (Array.isArray(params)) {
			params.forEach((paramValue, index) => {
				// ParameterScope resolves '?' to 1-based indices internally when it sees the AST node.
				// The hints should be keyed by these 1-based indices for anonymous params.
				results!.set(index + 1, getParameterScalarType(paramValue));
			});
		} else {
			Object.entries(params).forEach(([key, value]) => {
				// For named params like ':name', ParameterScope expects 'name' as key for hints.
				// A positional param bound after prepare (bind/bindAll) lands here too, keyed
				// by its stringified index (`boundArgs[index + 1]`) — normalize it back to a
				// number so it lines up with the array branch above and with ParameterScope's
				// own key, rather than silently missing the hint lookup.
				// One bound object can carry BOTH spellings of a name (':p' and 'p'). The
				// bind-time value lookup (Statement.validateParameterTypes) gives the BARE
				// key precedence, so the hint has to come from the same entry — otherwise
				// the plan is typed from one value and validated against another.
				if (key.startsWith(':') && Object.hasOwn(params, key.substring(1))) return;
				results!.set(boundKeyToParamKey(key), getParameterScalarType(value));
			});
		}
	}
	return results;
}

/**
 * The parameter a bound-args entry names. A bound key carries whatever spelling the
 * caller used — `:name`, the bare `name`, or a stringified positional index — while
 * parameter types and `ParameterScope` are keyed by the bare name or the number. One
 * function so the type map and {@link import('./statement.js').Statement}'s
 * stale-plan check cannot drift on what counts as the same parameter.
 */
export function boundKeyToParamKey(key: string): string | number {
	return normalizeParamKey(key.startsWith(':') ? key.substring(1) : key);
}

/**
 * Normalizes a parameter name to a number when it is an all-digits index,
 * matching how positional params are keyed elsewhere (array index + 1,
 * ParameterScope's `:N` handling). Leading zeros are part of that convention —
 * `:007` names positional slot 7 — so they normalize too. A name that merely
 * starts with digits ('1abc') stays a string, so it can't be silently
 * reassigned to an unrelated positional slot.
 */
export function normalizeParamKey(name: string): string | number {
	if (!/^\d+$/.test(name)) return name;
	const index = Number(name);
	// Past 2^53 distinct names would collapse onto one key; keep those as names.
	return Number.isSafeInteger(index) ? index : name;
}

/**
 * Infer the ScalarType for a parameter value based on its JavaScript type.
 *
 * @param value The parameter value
 * @returns The inferred ScalarType
 */
function getParameterScalarType(value: SqlValue): ScalarType {
	const logicalType = inferLogicalTypeFromValue(value);

	return {
		typeClass: 'scalar',
		logicalType,
		nullable: value === null,
		isReadOnly: true,
	};
}
