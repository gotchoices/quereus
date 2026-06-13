import type * as AST from '../../parser/ast.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { RelationalPlanNode } from '../nodes/plan-node.js';
import type { Scope } from '../scopes/scope.js';
import { ColumnReferenceNode } from '../nodes/reference.js';

/**
 * Builds the source-order list of AST expressions for a SELECT list, with
 * SELECT * / table.* expanded against the input relation's attributes.
 * Each entry corresponds to one output column, in source order. Used so that
 * GROUP BY / ORDER BY ordinal references (1-based) can resolve back to the
 * AST expression that produced the Nth output column.
 */
export function buildSelectListAsts(
	columns: AST.ResultColumn[],
	input: RelationalPlanNode,
): AST.Expression[] {
	const result: AST.Expression[] = [];
	for (const column of columns) {
		if (column.type === 'all') {
			const allAttrs = input.getAttributes();
			const matching = column.table
				? allAttrs.filter(attr => attr.relationName?.toLowerCase() === column.table!.toLowerCase())
				: allAttrs;
			for (const attr of matching) {
				const colExpr: AST.ColumnExpr = { type: 'column', name: attr.name };
				result.push(colExpr);
			}
		} else if (column.type === 'column') {
			result.push(column.expr);
		}
	}
	return result;
}

/**
 * If `expr` is a bare integer literal (or a unary `-` applied to one), treats it
 * as a 1-based positional reference into `selectListAsts` and returns the
 * corresponding AST expression. Out-of-range / zero / negative ordinals raise
 * an error. Any other expression shape returns null so the caller can fall
 * through to normal expression building (e.g., `group by 1 + 0` keeps its
 * constant-expression semantics).
 */
export function resolveOrdinalReference(
	expr: AST.Expression,
	selectListAsts: AST.Expression[],
	clauseName: 'GROUP BY' | 'ORDER BY',
): AST.Expression | null {
	const value = extractOrdinalValue(expr);
	if (value === null) return null;
	if (value < 1 || value > selectListAsts.length) {
		throw new QuereusError(
			`${clauseName} position ${value} is not in the SELECT list (1..${selectListAsts.length})`,
			StatusCode.ERROR,
			undefined,
			expr.loc?.start.line,
			expr.loc?.start.column,
		);
	}
	return selectListAsts[value - 1];
}

/**
 * Resolves a 1-based positional ORDER BY ordinal against a *compound* (set
 * operation) result. A compound has no single SELECT-list AST to map the
 * ordinal onto (each arm has its own), so `resolveOrdinalReference` does not
 * apply — instead the ordinal maps directly to the Nth OUTPUT column of the set
 * node, returning a `ColumnReferenceNode` over that column's attribute/type
 * (index `n-1`). The reference therefore inherits the column's RESOLVED type —
 * including its cross-input `collationName`/`collationSource` — so an ordinal
 * ORDER BY stays in lockstep with dedup, exactly like the column-name form.
 *
 * Returns null for any non-ordinal expression shape (mirrors
 * `extractOrdinalValue`) so the caller falls through to normal expression
 * building. Out-of-range / zero / negative ordinals raise the same prepare-time
 * error as `resolveOrdinalReference`.
 */
export function resolveCompoundOrdinalColumn(
	expr: AST.Expression,
	setNode: RelationalPlanNode,
	scope: Scope,
): ColumnReferenceNode | null {
	const value = extractOrdinalValue(expr);
	if (value === null) return null;
	const columns = setNode.getType().columns;
	if (value < 1 || value > columns.length) {
		throw new QuereusError(
			`ORDER BY position ${value} is not in the SELECT list (1..${columns.length})`,
			StatusCode.ERROR,
			undefined,
			expr.loc?.start.line,
			expr.loc?.start.column,
		);
	}
	const index = value - 1;
	const column = columns[index];
	const attr = setNode.getAttributes()[index];
	const colExpr: AST.ColumnExpr = { type: 'column', name: column.name || attr.name };
	return new ColumnReferenceNode(scope, colExpr, column.type, attr.id, index);
}

function extractOrdinalValue(expr: AST.Expression): number | null {
	if (expr.type === 'literal') {
		const v = expr.value;
		if (typeof v === 'number' && Number.isInteger(v)) return v;
		return null;
	}
	// Unary `-N` parses as UnaryExpr(-, Literal(N)). Likewise `+N`.
	if (expr.type === 'unary' && (expr.operator === '-' || expr.operator === '+') && expr.expr.type === 'literal') {
		const v = expr.expr.value;
		if (typeof v === 'number' && Number.isInteger(v)) {
			return expr.operator === '-' ? -v : v;
		}
	}
	return null;
}
