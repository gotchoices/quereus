import type * as AST from '../../parser/ast.js';
import type { ScalarPlanNode } from '../nodes/plan-node.js';
import type { PlanningContext } from '../planning-context.js';
import { buildExpression } from './expression.js';
import { constantNumber } from '../nodes/limit-offset.js';
import { CastNode, CollateNode } from '../nodes/scalar.js';
import { ParameterReferenceNode } from '../nodes/reference.js';
import { ANY_TYPE } from '../../types/builtin-types.js';
import { rowCountError, toRowCount, type RowCountClause } from '../../util/row-count.js';

/**
 * Build a LIMIT / OFFSET expression, rejecting at prepare time what can never be a row
 * count: an expression whose type admits NULL, and a negative constant. What is only
 * knowable per execution — an untyped parameter's value, a non-constant expression's
 * sign — is checked by the runtime's `toRowCount` before any source row is read.
 * See docs/sql-select.md §3.6.
 */
export function buildRowCountExpression(
	ctx: PlanningContext,
	expr: AST.Expression,
	clause: RowCountClause,
): ScalarPlanNode {
	const node = buildExpression(ctx, expr);
	const at = expr.loc?.start;
	if (node.getType().nullable && !isUntypedParameter(node)) {
		throw rowCountError(`${clause} expression may be NULL; wrap it in coalesce(…), or omit the clause instead`, at);
	}
	const constant = constantNumber(node);
	if (constant !== undefined) toRowCount(constant, clause, at);
	return node;
}

/**
 * A parameter typed ANY when the plan is built is still unbound (no declared type, no
 * bind-time hint), was first bound to NULL, which types it ANY rather than NULL (see
 * `getParameterScalarType` in core/param.ts), or was declared ANY by a hint map. In each
 * case it is nullable only because nothing is known about its later values. Rejecting it would break `prepare('… limit ?')`
 * before any bind, and would pin a statement first run with NULL to failing forever, so
 * its value is left to the runtime check. A typed parameter carries its own nullability
 * and is judged like any other expression.
 */
function isUntypedParameter(node: ScalarPlanNode): boolean {
	let cur: ScalarPlanNode = node;
	while (cur instanceof CastNode || cur instanceof CollateNode) {
		cur = cur.operand;
	}
	return cur instanceof ParameterReferenceNode && cur.targetType.logicalType === ANY_TYPE;
}
