import type { SqlValue } from '../common/types.js';
import { expressionToString } from '../emit/ast-stringify.js';
import type * as AST from '../parser/ast.js';

/**
 * Converts a SqlValue to its SQL literal string representation.
 * This is used for mutation logging to create deterministic, replayable SQL statements.
 * Uses the existing expressionToString function for consistency.
 *
 * @param value The value to convert to a SQL literal
 * @returns SQL literal string representation
 */
export function sqlValueToLiteral(value: SqlValue): string {
	// Create a literal expression AST node and use expressionToString
	const literalExpr: AST.LiteralExpr = {
		type: 'literal',
		value: value
	};

	return expressionToString(literalExpr);
}

