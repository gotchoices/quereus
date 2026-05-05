import type * as AST from '../../parser/ast.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

/**
 * Validates that RETURNING expressions use appropriate NEW/OLD qualifiers
 * for the operation type. Operates on the AST so it can run before column
 * resolution — otherwise resolution failures would mask the qualifier guard.
 */
export function validateReturningQualifiers(
	expr: AST.Expression,
	operationType: 'INSERT' | 'UPDATE' | 'DELETE',
): void {
	function check(e: AST.Expression): void {
		if (e.type === 'column') {
			const tbl = e.table?.toLowerCase();
			if (tbl === 'old' && operationType === 'INSERT') {
				throw new QuereusError(
					'OLD qualifier cannot be used in INSERT RETURNING clause',
					StatusCode.ERROR,
				);
			}
			if (tbl === 'new' && operationType === 'DELETE') {
				throw new QuereusError(
					'NEW qualifier cannot be used in DELETE RETURNING clause',
					StatusCode.ERROR,
				);
			}
		} else if (e.type === 'binary') {
			check(e.left);
			check(e.right);
		} else if (e.type === 'unary') {
			check(e.expr);
		} else if (e.type === 'function') {
			e.args.forEach(check);
		} else if (e.type === 'case') {
			if (e.baseExpr) check(e.baseExpr);
			e.whenThenClauses.forEach(clause => {
				check(clause.when);
				check(clause.then);
			});
			if (e.elseExpr) check(e.elseExpr);
		} else if (e.type === 'cast') {
			check(e.expr);
		} else if (e.type === 'collate') {
			check(e.expr);
		} else if (e.type === 'in') {
			check(e.expr);
			if (e.values) e.values.forEach(check);
		} else if (e.type === 'windowFunction') {
			check(e.function);
		}
		// Subquery / EXISTS expressions are not traversed here — qualifier
		// scoping inside a subquery is independent of the outer DML operation.
	}

	check(expr);
}
