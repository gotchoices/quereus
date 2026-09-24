import type { ScalarType } from '../common/datatype.js';
import { describeSqlValueViolation, isSqlValue, type SqlParameters, type SqlValue } from '../common/types.js';
import { inferLogicalTypeFromValue } from '../common/type-inference.js';
import { MisuseError } from '../common/errors.js';
import { canonicalizeSqlValue } from '../util/numeric-canonical.js';

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
				// Bound args have already passed through normalizeBoundParams, so the key is
				// bare; boundKeyToParamKey is idempotent on it and costs nothing, and it keeps
				// this function correct for any caller that hands it a raw object.
				results!.set(boundKeyToParamKey(key), getParameterScalarType(value));
			});
		}
	}
	return results;
}

/**
 * The parameter a bound-args entry names. A caller may spell a named parameter
 * `:name`, `$name` or the bare `name` — the parser accepts `:` and `$` as
 * interchangeable prefixes and keeps only the bare lexeme — and a positional slot
 * `1`, `'1'`, `':1'` or `':01'`. All of those name one parameter, and this is the
 * single function that says so.
 *
 * `@` is deliberately NOT stripped: the lexer has no `@` token, so `@p` can never
 * appear in Quereus SQL and normalizing it would promise a binding for a parameter
 * no statement can reference.
 */
export function boundKeyToParamKey(key: string): string | number {
	const bare = key.startsWith(':') || key.startsWith('$') ? key.substring(1) : key;
	return normalizeParamKey(bare);
}

/**
 * Canonicalizes a caller-supplied parameter object/array into the bound-args record
 * every downstream reader agrees on: one key per parameter ({@link boundKeyToParamKey}),
 * one canonical JS form per value ({@link canonicalizeSqlValue}).
 *
 * This is the ONLY place a bound key is decided. Normalizing at ingress is what makes
 * "which spelling names this parameter?" unanswerable-by-divergence downstream: the
 * runtime value lookup, the parameter type map, bind-time validation and change-scope
 * substitution all read the same key because only one was ever written.
 *
 * Two spellings of one parameter in a single object (`{ p: 1, ':p': 2 }`) is a
 * {@link MisuseError}, not a silent pick: either entry could be the one the caller
 * meant, and discarding a value they passed is worse than refusing it. The rule is
 * per-object — repeated `Statement.bind()` calls to one parameter stay last-wins,
 * since each call is a separate statement of intent.
 *
 * Throws before returning anything, so a caller assigning the result keeps `bindAll`'s
 * all-or-nothing contract for free.
 *
 * @param label the caller-facing operation name, used to prefix rejection messages
 */
export function normalizeBoundParams(
	params: SqlParameters | SqlValue[],
	label: string,
): Record<string | number, SqlValue> {
	const out: Record<string | number, SqlValue> = {};
	if (Array.isArray(params)) {
		params.forEach((value, index) => {
			assertSqlValue(value, `${label}: invalid value at index ${index}`);
			out[index + 1] = canonicalizeSqlValue(value);
		});
		return out;
	}
	// Rejection messages name the CALLER's spelling, so validate while iterating the
	// original entries rather than the normalized record.
	const spellingOf = new Map<string | number, string>();
	for (const [key, value] of Object.entries(params)) {
		assertSqlValue(value, `${label}: invalid value for key '${key}'`);
		const paramKey = boundKeyToParamKey(key);
		const previous = spellingOf.get(paramKey);
		if (previous !== undefined) {
			throw new MisuseError(`${label}: parameter '${paramKey}' bound twice, as '${previous}' and '${key}'`);
		}
		spellingOf.set(paramKey, key);
		out[paramKey] = canonicalizeSqlValue(value);
	}
	return out;
}

function assertSqlValue(value: SqlValue, context: string): void {
	if (!isSqlValue(value)) {
		throw new MisuseError(`${context}: expected SqlValue, got ${describeSqlValueViolation(value)}`);
	}
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
