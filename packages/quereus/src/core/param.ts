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
				results!.set(key.startsWith(':') ? key.substring(1) : key, getParameterScalarType(value));
			});
		}
	}
	return results;
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
