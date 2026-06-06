import type * as AST from '../../parser/ast.js';
import type { RelationalPlanNode } from '../nodes/plan-node.js';
import { PlanNode } from '../nodes/plan-node.js';
import type { PlanningContext } from '../planning-context.js';
import type { CTEScopeNode } from '../nodes/cte-node.js';
import type { Scope } from '../scopes/scope.js';
import { SetOperationNode, type SetOpMembershipSpec } from '../nodes/set-operation-node.js';
import { SortNode, type SortKey } from '../nodes/sort.js';
import { LimitOffsetNode } from '../nodes/limit-offset.js';
import { LiteralNode } from '../nodes/scalar.js';
import { RegisteredScope } from '../scopes/registered.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import { buildExpression } from './expression.js';
import { buildValuesStmt } from './select.js';
import { buildInsertStmt } from './insert.js';
import { buildUpdateStmt } from './update.js';
import { buildDeleteStmt } from './delete.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

/**
 * Builds a compound SELECT statement (UNION, INTERSECT, EXCEPT)
 */
export function buildCompoundSelect(
	stmt: AST.SelectStmt,
	contextWithCTEs: PlanningContext,
	cteNodes: Map<string, CTEScopeNode>,
	buildSelectStmt: (ctx: PlanningContext, stmt: AST.SelectStmt, parentCTEs?: Map<string, CTEScopeNode>) => RelationalPlanNode
): RelationalPlanNode {
	if (!stmt.compound) {
		throw new QuereusError('buildCompoundSelect called without compound clause', StatusCode.INTERNAL);
	}

	// Build left side by cloning the statement without compound and stripping ORDER BY/LIMIT/OFFSET that belong to outer query
	const { compound: _outerCompound, orderBy: outerOrderBy, limit: outerLimit, offset: outerOffset, ...leftCore } = stmt;

	const leftPlan = buildSelectStmt(contextWithCTEs, leftCore as AST.SelectStmt, cteNodes) as RelationalPlanNode;

	// Right side: any QueryExpr. SELECT legs strip ORDER BY/LIMIT/OFFSET (those
	// belong to the outer compound). VALUES legs build directly. DML legs
	// (RETURNING enforced by the parser) build through the standard DML
	// builders; their RETURNING projection supplies the compound-leg arity.
	const rightStmt = stmt.compound.select;
	let rightPlan: RelationalPlanNode;
	switch (rightStmt.type) {
		case 'select': {
			const { orderBy: _rightOrderBy, limit: _rightLimit, offset: _rightOffset, ...rightCore } = rightStmt;
			rightPlan = buildSelectStmt(contextWithCTEs, rightCore as AST.SelectStmt, cteNodes) as RelationalPlanNode;
			break;
		}
		case 'values':
			rightPlan = buildValuesStmt(contextWithCTEs, rightStmt);
			break;
		case 'insert':
			rightPlan = buildInsertStmt(contextWithCTEs, rightStmt) as RelationalPlanNode;
			break;
		case 'update':
			rightPlan = buildUpdateStmt(contextWithCTEs, rightStmt) as RelationalPlanNode;
			break;
		case 'delete':
			rightPlan = buildDeleteStmt(contextWithCTEs, rightStmt) as RelationalPlanNode;
			break;
	}

	// Membership-flag columns (`<setop> exists <branch> as <name>`, read half). Mint a
	// stable attribute id per clause (once, here — so it survives `withChildren`
	// rebuilds) and pass the specs into the SetOperationNode, which appends one boolean
	// `{true,false}` NOT NULL flag column per spec AFTER the data columns. The flag
	// resolves by its `as` name through `createSetOperationScope` (which iterates the
	// appended columns), so an outer ORDER BY / the enclosing view can reference it.
	let membership: SetOpMembershipSpec[] | undefined;
	if (stmt.compound.existence && stmt.compound.existence.length > 0) {
		if (stmt.compound.op === 'diff') {
			// Defensive: the parser already rejects membership on DIFF (ambiguous over its
			// two EXCEPTs). Guard here too so a hand-built AST cannot smuggle it through.
			throw new QuereusError('membership columns are not valid on DIFF (symmetric difference)', StatusCode.ERROR);
		}
		membership = stmt.compound.existence.map(e => ({ attrId: PlanNode.nextAttrId(), name: e.name, branch: e.branch }));
	}

	// Expand DIFF as (A EXCEPT B) UNION (B EXCEPT A)
	let setNode: RelationalPlanNode;
	if (stmt.compound.op === 'diff') {
		const leftMinusRight = new SetOperationNode(contextWithCTEs.scope, leftPlan, rightPlan, 'except');
		const rightMinusLeft = new SetOperationNode(contextWithCTEs.scope, rightPlan, leftPlan, 'except');
		setNode = new SetOperationNode(contextWithCTEs.scope, leftMinusRight, rightMinusLeft, 'union');
	} else {
		setNode = new SetOperationNode(contextWithCTEs.scope, leftPlan, rightPlan, stmt.compound.op, membership);
	}

	// After set operation, apply ORDER BY / LIMIT / OFFSET from the *outer* (original) statement
	let input: RelationalPlanNode = setNode;

	// Build scope for output columns
	const setScope = createSetOperationScope(input);
	const selectContext: PlanningContext = { ...contextWithCTEs, scope: setScope };

	// Apply outer modifiers
	input = applyOuterOrderBy(input, outerOrderBy, selectContext);
	input = applyOuterLimitOffset(input, outerLimit, outerOffset, selectContext);

	return input;
}

/**
 * Creates a scope for set operation output columns
 */
function createSetOperationScope(setNode: RelationalPlanNode): RegisteredScope {
	const setScope = new RegisteredScope();
	const attrs = setNode.getAttributes();

	setNode.getType().columns.forEach((c, i: number) => {
		const attr = attrs[i];
		// Ensure column has a name - use attribute name as fallback
		const columnName = c.name || attr.name;
		if (!columnName) {
			throw new QuereusError(`Column at index ${i} has no name in set operation`, StatusCode.ERROR);
		}
		setScope.registerSymbol(columnName.toLowerCase(), (exp: AST.Expression, s: Scope) =>
			new ColumnReferenceNode(s, exp as AST.ColumnExpr, c.type, attr.id, i));
	});

	return setScope;
}

/**
 * Applies ORDER BY clause from outer compound statement
 */
function applyOuterOrderBy(
	input: RelationalPlanNode,
	outerOrderBy: AST.OrderByClause[] | undefined,
	selectContext: PlanningContext
): RelationalPlanNode {
	if (outerOrderBy && outerOrderBy.length > 0) {
		const sortKeys: SortKey[] = outerOrderBy.map((ob) => ({
			expression: buildExpression(selectContext, ob.expr),
			direction: ob.direction,
			nulls: ob.nulls,
		}));
		return new SortNode(selectContext.scope, input, sortKeys);
	}
	return input;
}

/**
 * Applies LIMIT and OFFSET clauses from outer compound statement
 */
function applyOuterLimitOffset(
	input: RelationalPlanNode,
	outerLimit: AST.Expression | undefined,
	outerOffset: AST.Expression | undefined,
	selectContext: PlanningContext
): RelationalPlanNode {
	if (outerLimit || outerOffset) {
		const literalNull = new LiteralNode(selectContext.scope, { type: 'literal', value: null });
		const limitExpr = outerLimit ? buildExpression(selectContext, outerLimit) : literalNull;
		const offsetExpr = outerOffset ? buildExpression(selectContext, outerOffset) : literalNull;
		return new LimitOffsetNode(selectContext.scope, input, limitExpr, offsetExpr);
	}
	return input;
}
