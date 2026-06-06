import type { SqlValue } from '../common/types.js';
import { StatusCode } from '../common/types.js';
import { QuereusError } from '../common/errors.js';
import type { LogicalType } from './logical-type.js';

/**
 * Validate a value against a logical type.
 * Throws an error if the value is invalid.
 *
 * @param value The value to validate
 * @param type The logical type to validate against
 * @param columnName Optional column name for better error messages
 * @returns The validated value
 * @throws QuereusError if validation fails
 */
export function validateValue(
	value: SqlValue,
	type: LogicalType,
	columnName?: string
): SqlValue {
	// NULL is always valid
	if (value === null) return null;

	// Type-specific validation
	if (type.validate && !type.validate(value)) {
		const colInfo = columnName ? ` for column '${columnName}'` : '';
		throw new QuereusError(
			`Type mismatch${colInfo}: expected ${type.name}, got ${typeof value}`,
			StatusCode.MISMATCH
		);
	}

	return value;
}

/**
 * Parse/convert a value to match a logical type.
 * This performs type conversion and normalization.
 *
 * @param value The value to parse
 * @param type The logical type to convert to
 * @param columnName Optional column name for better error messages
 * @returns The parsed/converted value
 * @throws QuereusError if conversion fails
 */
export function parseValue(
	value: SqlValue,
	type: LogicalType,
	columnName?: string
): SqlValue {
	// NULL is always valid
	if (value === null) return null;

	// Type-specific parsing
	if (type.parse) {
		try {
			return type.parse(value);
		} catch (error) {
			const colInfo = columnName ? ` for column '${columnName}'` : '';
			const message = error instanceof Error ? error.message : String(error);
			throw new QuereusError(
				`Type conversion failed${colInfo}: ${message}`,
				StatusCode.MISMATCH
			);
		}
	}

	return value;
}

/**
 * Validate and parse a value in one step.
 * This is the main entry point for type checking at INSERT/UPDATE boundaries.
 *
 * @param value The value to validate and parse
 * @param type The logical type
 * @param columnName Optional column name for better error messages
 * @returns The validated and parsed value
 * @throws QuereusError if validation or parsing fails
 */
export function validateAndParse(
	value: SqlValue,
	type: LogicalType,
	columnName?: string
): SqlValue {
	// Parse first (which may convert the value)
	const parsed = parseValue(value, type, columnName);

	// Then validate the parsed result
	return validateValue(parsed, type, columnName);
}

/**
 * Check if a value is compatible with a logical type without throwing.
 *
 * @param value The value to check
 * @param type The logical type
 * @returns True if the value is valid for the type
 */
export function isValidForType(value: SqlValue, type: LogicalType): boolean {
	if (value === null) return true;
	if (!type.validate) return true;
	return type.validate(value);
}

/**
 * Try to parse a value, returning null if parsing fails.
 *
 * @param value The value to parse
 * @param type The logical type
 * @returns The parsed value, or null if parsing fails
 */
export function tryParse(value: SqlValue, type: LogicalType): SqlValue | null {
	try {
		return parseValue(value, type);
	} catch {
		return null;
	}
}

