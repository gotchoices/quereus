import { SqlDataType, type SqlValue } from "./types.js";
import type { LogicalType } from "../types/logical-type.js";
import { NULL_TYPE, INTEGER_TYPE, REAL_TYPE, TEXT_TYPE, BLOB_TYPE, BOOLEAN_TYPE } from "../types/builtin-types.js";
import { JSON_TYPE } from "../types/json-type.js";

export function getLiteralSqlType(v: SqlValue): SqlDataType {
	if (v === null) return SqlDataType.NULL;
	if (typeof v === 'number') {
		if (Number.isInteger(v)) return SqlDataType.INTEGER;
		return SqlDataType.REAL;
	}
	if (typeof v === 'bigint') return SqlDataType.INTEGER;
	if (typeof v === 'string') return SqlDataType.TEXT;
	if (v instanceof Uint8Array) return SqlDataType.BLOB;
	if (typeof v === 'object') return SqlDataType.TEXT; // JSON objects use TEXT affinity for SQL compat
	return SqlDataType.BLOB;
}

/**
 * Infer LogicalType from a SqlValue for parameters.
 * Uses JavaScript type to determine the logical type:
 * - null → NULL
 * - number (integer) → INTEGER
 * - number (float) → REAL
 * - bigint → INTEGER
 * - boolean → BOOLEAN
 * - string → TEXT
 * - Uint8Array → BLOB
 * - object/array → JSON
 */
export function inferLogicalTypeFromValue(v: SqlValue): LogicalType {
	if (v === null) return NULL_TYPE;
	if (typeof v === 'number') {
		return Number.isInteger(v) ? INTEGER_TYPE : REAL_TYPE;
	}
	if (typeof v === 'bigint') return INTEGER_TYPE;
	if (typeof v === 'boolean') return BOOLEAN_TYPE;
	if (typeof v === 'string') return TEXT_TYPE;
	if (v instanceof Uint8Array) return BLOB_TYPE;
	if (typeof v === 'object') return JSON_TYPE;
	return BLOB_TYPE;
}
