import { quereusError } from '../common/errors.js';
import { SqlValue } from '../common/types.js';
import type { Expression, LiteralExpr } from './ast.js';

export function getSyncLiteral(literal: LiteralExpr): SqlValue {
	if (literal.value instanceof Promise) {
		quereusError('Literal value is a promise');
	}
	return literal.value;
}

/**
 * Returns the SqlValue if `expr` is a literal (or a unary +/- applied to a
 * numeric literal), else undefined. Used by paths that need a constant default
 * value without invoking the planner — e.g. ALTER TABLE ADD COLUMN backfill.
 *
 * Note: parens around an expression do not produce their own AST node, so
 * `(-123.0)` is just a UnaryExpr the same as `-123.0`.
 */
export function tryFoldLiteral(expr: Expression): SqlValue | undefined {
	if (expr.type === 'literal') {
		return getSyncLiteral(expr);
	}
	if (expr.type === 'unary' && (expr.operator === '-' || expr.operator === '+')) {
		const inner = tryFoldLiteral(expr.expr);
		if (inner === undefined) return undefined;
		if (typeof inner === 'number' || typeof inner === 'bigint') {
			return expr.operator === '-' ? (typeof inner === 'bigint' ? -inner : -inner) : inner;
		}
		return undefined;
	}
	return undefined;
}