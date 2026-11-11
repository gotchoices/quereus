import type * as AST from '../../parser/ast.js';
import type { PlanNode, ScalarPlanNode } from '../nodes/plan-node.js';
import type { PlanningContext } from '../planning-context.js';
import { buildExpression } from './expression.js';
import { constantNumber } from '../nodes/limit-offset.js';
import { ParameterReferenceNode } from '../nodes/reference.js';
import { ANY_TYPE, INTEGER_TYPE } from '../../types/builtin-types.js';
import { rowCountError, toRowCount, type RowCountClause } from '../../util/row-count.js';

/**
 * Build a LIMIT / OFFSET expression, rejecting at prepare time what can never be a row
 * count: an expression that may be NULL for a reason other than its parameters, and a
 * negative constant. What is only knowable per execution — a parameter's value, a
 * non-constant expression's sign — is checked by the runtime's `toRowCount` before any
 * source row is read. See docs/sql-select.md §3.6.
 */
export function buildRowCountExpression(
	ctx: PlanningContext,
	expr: AST.Expression,
	clause: RowCountClause,
): ScalarPlanNode {
	const node = buildExpression(ctx, expr);
	const at = expr.loc?.start;
	if (node.getType().nullable && !isNullableOnlyThroughParameters(node)) {
		throw rowCountError(`${clause} expression may be NULL; wrap it in coalesce(…), or omit the clause instead`, at);
	}
	const constant = constantNumber(node);
	if (constant !== undefined) toRowCount(constant, clause, at);
	return node;
}

/**
 * True when a nullable expression would be non-null if every nullable parameter in it
 * held a non-null value. A parameter's nullability says nothing about the value a given
 * execution binds — an inferred type is always nullable (`getParameterScalarType` in
 * core/param.ts) — so rejecting on it would break `prepare('… limit ? + 1')` and pin a
 * reused statement to failing; its NULL is left to the runtime check instead.
 *
 * Judged on a copy (see {@link withParametersAssumedNonNull}) that is then discarded:
 * the plan keeps each parameter's real, nullable type, or a rule could simplify
 * `coalesce(?, 10)` to `?` and turn a NULL into an error instead of 10.
 */
function isNullableOnlyThroughParameters(node: ScalarPlanNode): boolean {
	const assumed = withParametersAssumedNonNull(node);
	return assumed !== node && !assumed.getType().nullable;
}

/**
 * Rebuild a scalar expression with each nullable parameter replaced by a non-null copy.
 * Only scalar children are descended: a scalar subquery's body is left as it is, since a
 * subquery is nullable for its own reasons (no row). Rebuilt nodes recompute their type
 * from the new children (`ScalarFunctionCallNode.withChildren` re-runs inference).
 * Returns the input itself when it holds no nullable parameter.
 */
function withParametersAssumedNonNull(expr: ScalarPlanNode): ScalarPlanNode {
	if (expr instanceof ParameterReferenceNode) return assumeNonNull(expr);
	const children = expr.getChildren();
	if (children.length === 0) return expr;

	const newChildren: PlanNode[] = [];
	let changed = false;
	for (const child of children) {
		if (child.getType().typeClass === 'scalar') {
			const replaced = withParametersAssumedNonNull(child as ScalarPlanNode);
			newChildren.push(replaced);
			if (replaced !== child) changed = true;
		} else {
			newChildren.push(child);
		}
	}
	if (!changed) return expr;
	return expr.withChildren(newChildren) as ScalarPlanNode;
}

/**
 * The parameter as the row-count check assumes it: non-null, and — when its type is ANY
 * (unbound, first bound to NULL, or declared ANY) — an INTEGER, the kind of value a row
 * count is. ANY arithmetic is nullable because the runtime reads the operand per row, so
 * without that assumption `limit ? + 1` on an unbound parameter would still be rejected.
 * A parameter declared `nullable: false` is judged as it is.
 */
function assumeNonNull(param: ParameterReferenceNode): ParameterReferenceNode {
	const type = param.targetType;
	if (!type.nullable) return param;
	const logicalType = type.logicalType === ANY_TYPE ? INTEGER_TYPE : type.logicalType;
	return new ParameterReferenceNode(param.scope, param.expression, param.nameOrIndex, { ...type, logicalType, nullable: false });
}
