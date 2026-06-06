import type * as AST from '../parser/ast.js';

/**
 * Extract a numeric value from a literal AST expression. Recognizes plain
 * numeric/bigint literals and unary +/- on numeric literals.
 *
 * Returns `undefined` for anything else — column references, parameters,
 * function calls, computed expressions. Used by both the runtime (frame offsets)
 * and the optimizer (LAG/LEAD literal-offset recognition).
 */
export function tryExtractNumericLiteral(expr: AST.Expression): number | undefined {
	if (expr.type === 'literal') {
		const v = expr.value;
		if (typeof v === 'number') return v;
		if (typeof v === 'bigint') return Number(v);
		return undefined;
	}

	if (expr.type === 'unary' && (expr.operator === '+' || expr.operator === '-')) {
		const inner = tryExtractNumericLiteral(expr.expr);
		if (inner === undefined) return undefined;
		return expr.operator === '-' ? -inner : inner;
	}

	return undefined;
}
