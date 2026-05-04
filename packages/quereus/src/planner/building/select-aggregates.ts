import type * as AST from '../../parser/ast.js';
import { isRelationalNode, type PlanNode, type RelationalPlanNode, type ScalarPlanNode } from '../nodes/plan-node.js';
import type { PlanningContext } from '../planning-context.js';
import { AggregateNode } from '../nodes/aggregate-node.js';
import { FilterNode } from '../nodes/filter.js';
import { SortNode, type SortKey } from '../nodes/sort.js';
import { type Projection } from '../nodes/project-node.js';
import { RegisteredScope } from '../scopes/registered.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import { buildExpression } from './expression.js';
import { buildFunctionCall } from './function-call.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { CapabilityDetectors } from '../framework/characteristics.js';
import type { Scope } from '../scopes/scope.js';
import { resolveFunctionSchema } from './schema-resolution.js';
import { isAggregateFunctionSchema } from '../../schema/function.js';
import { expressionToString } from '../../emit/ast-stringify.js';
import { AggregateFunctionCallNode } from '../nodes/aggregate-function.js';

/**
 * Processes GROUP BY, aggregates, and HAVING clauses
 */
export function buildAggregatePhase(
	input: RelationalPlanNode,
	stmt: AST.SelectStmt,
	selectContext: PlanningContext,
	aggregates: { expression: ScalarPlanNode; alias: string }[],
	hasAggregates: boolean,
	projections: Projection[],
	hasWrappedAggregates: boolean = false
): {
	output: RelationalPlanNode;
	aggregateScope?: RegisteredScope;
	needsFinalProjection: boolean;
	preAggregateSort: boolean;
	aggregateNode?: RelationalPlanNode;
	groupByExpressions?: ScalarPlanNode[];
	hasHavingOnlyAggregates?: boolean;
} {
	const hasGroupBy = stmt.groupBy && stmt.groupBy.length > 0;

	// Pre-collect aggregate functions from the HAVING clause that are not already
	// present in the SELECT list. These need to be added to the AggregateNode so
	// they are computed during aggregation and available for the HAVING filter.
	let hasHavingOnlyAggregates = false;
	if (stmt.having) {
		const havingAggs = collectHavingAggregates(stmt.having, selectContext, aggregates);
		if (havingAggs.length > 0) {
			aggregates.push(...havingAggs);
			hasAggregates = true;
			hasHavingOnlyAggregates = true;
		}
	}

	// If there is a HAVING clause but the SELECT contains **no aggregate functions**
	// AND **no GROUP BY**, we can safely treat the HAVING predicate as a regular filter
	// that runs *before* the aggregation (i.e. between the source and the AggregateNode).
	// This avoids the "missing column context" problem where the predicate refers to columns
	// that are not available after the AggregateNode (only grouping columns and
	// aggregate results are exposed). This behaviour is compatible with SQLite –
	// GROUP BY with a primary-key guarantees one row per group so the semantics
	// are unchanged.
	const shouldPushHavingBelowAggregate = Boolean(stmt.having && !hasAggregates && !hasGroupBy);

	if (!hasAggregates && !hasGroupBy) {
		return { output: input, needsFinalProjection: false, preAggregateSort: false };
	}

	// ---------------------------------------------------------------------------
	// Build HAVING predicate as *pre-aggregate* filter when appropriate
	// ---------------------------------------------------------------------------
	let currentInput: RelationalPlanNode = input;
	if (shouldPushHavingBelowAggregate) {
		// Build the predicate using the *pre-aggregate* scope because all columns
		// are still available here.
		const havingExpr = buildExpression(selectContext, stmt.having as AST.Expression, true);
		currentInput = new FilterNode(selectContext.scope, currentInput, havingExpr);
	}

	// After (optional) early HAVING filter we continue with the existing pipeline
	// ----------------------------------------------------------------------------
	// Handle pre-aggregate sorting for ORDER BY without GROUP BY
	const preAggregateSort = Boolean(hasAggregates && !hasGroupBy && stmt.orderBy && stmt.orderBy.length > 0);
	currentInput = handlePreAggregateSort(currentInput, stmt, selectContext, hasAggregates, !!hasGroupBy);

	// Build GROUP BY expressions
	const groupByExpressions = stmt.groupBy ?
		stmt.groupBy.map(expr => buildExpression(selectContext, expr, false)) : [];

	// Validate aggregate/non-aggregate mixing (must run after groupByExpressions are built
	// so we can check column-coverage of SELECT projections against GROUP BY)
	validateAggregateProjections(projections, hasAggregates, !!hasGroupBy, groupByExpressions);

	// Create AggregateNode
	const aggregateNode = new AggregateNode(selectContext.scope, currentInput, groupByExpressions, aggregates);
	currentInput = aggregateNode;

	// Create aggregate output scope
	const aggregateOutputScope = createAggregateOutputScope(
		selectContext.scope,
		currentInput,
		groupByExpressions,
		aggregates
	);

	// Handle HAVING clause *after* aggregation only when we did not already push
	// it below the AggregateNode.
	if (stmt.having && !shouldPushHavingBelowAggregate) {
		currentInput = buildHavingFilter(currentInput, stmt.having, selectContext, aggregateOutputScope, aggregates, groupByExpressions);
	}

	// Determine if final projection is needed.
	// Force a final projection when HAVING-only aggregates were added, to
	// strip them from the output (they exist only for the HAVING filter).
	const needsFinalProjection = hasHavingOnlyAggregates || hasWrappedAggregates || checkNeedsFinalProjection(projections);

	return {
		output: currentInput,
		aggregateScope: aggregateOutputScope,
		needsFinalProjection,
		preAggregateSort,
		aggregateNode,
		groupByExpressions,
		hasHavingOnlyAggregates
	};
}

/**
 * Handles pre-aggregate sorting for special cases
 */
function handlePreAggregateSort(
	input: RelationalPlanNode,
	stmt: AST.SelectStmt,
	selectContext: PlanningContext,
	hasAggregates: boolean,
	hasGroupBy: boolean
): RelationalPlanNode {
	// Special handling for ORDER BY with aggregates but no GROUP BY
	if (hasAggregates && !hasGroupBy && stmt.orderBy && stmt.orderBy.length > 0) {
		// Apply ORDER BY before aggregation
		const sortKeys: SortKey[] = stmt.orderBy.map(orderByClause => {
			const expression = buildExpression(selectContext, orderByClause.expr);
			return {
				expression,
				direction: orderByClause.direction,
				nulls: orderByClause.nulls
			};
		});

		return new SortNode(selectContext.scope, input, sortKeys);
	}

	return input;
}

/**
 * Validates that aggregate and non-aggregate projections don't mix inappropriately.
 * With GROUP BY, every non-aggregate column reference in the SELECT list must
 * either (a) match a GROUP BY column by attribute id, or (b) appear inside a
 * subtree whose AST matches a GROUP BY expression. This is intentionally
 * stricter than full functional-dependency coverage — it matches SQL-92 and
 * the corpus assertions, without importing SQLite's permissive "bare columns" rule.
 */
function validateAggregateProjections(
	projections: Projection[],
	hasAggregates: boolean,
	hasGroupBy: boolean,
	groupByExpressions: ScalarPlanNode[]
): void {
	if (projections.length === 0) return;

	if (hasAggregates && !hasGroupBy) {
		throw new QuereusError(
			'Cannot mix aggregate and non-aggregate columns in SELECT list without GROUP BY',
			StatusCode.ERROR
		);
	}

	if (!hasGroupBy) return;

	const groupByAttrIds = new Set<number>();
	const groupByExprFingerprints = new Set<string>();
	for (const expr of groupByExpressions) {
		if (CapabilityDetectors.isColumnReference(expr)) {
			groupByAttrIds.add(expr.attributeId);
		}
		groupByExprFingerprints.add(expressionToString(expr.expression));
	}

	for (const proj of projections) {
		const ungrouped = findUngroupedColumnRef(proj.node, groupByAttrIds, groupByExprFingerprints);
		if (ungrouped) {
			throw new QuereusError(
				'Cannot mix aggregate and non-aggregate columns in SELECT list without GROUP BY',
				StatusCode.ERROR
			);
		}
	}
}

/**
 * Walks a scalar expression tree looking for a ColumnReferenceNode whose attribute
 * id is not covered by GROUP BY. Stops descending when it hits an aggregate-function
 * subtree (inner column refs are aggregated), a relational subtree (subqueries
 * resolve their own scope), or any subtree whose AST fingerprint matches a GROUP BY
 * expression (the whole subtree is grouped, e.g. SELECT id+1 ... GROUP BY id+1).
 */
function findUngroupedColumnRef(
	node: PlanNode,
	groupByAttrIds: Set<number>,
	groupByExprFingerprints: Set<string>
): ColumnReferenceNode | null {
	if (CapabilityDetectors.isAggregateFunction(node)) {
		return null;
	}

	if ('expression' in node) {
		const fp = expressionToString((node as ScalarPlanNode).expression);
		if (groupByExprFingerprints.has(fp)) {
			return null;
		}
	}

	if (CapabilityDetectors.isColumnReference(node)) {
		if (!groupByAttrIds.has(node.attributeId)) {
			return node as ColumnReferenceNode;
		}
		return null;
	}

	for (const child of node.getChildren()) {
		if (isRelationalNode(child)) continue;
		const found = findUngroupedColumnRef(child, groupByAttrIds, groupByExprFingerprints);
		if (found) return found;
	}
	return null;
}

/**
 * Creates a scope that includes the aggregate output columns
 */
function createAggregateOutputScope(
	parentScope: Scope,
	aggregateNode: RelationalPlanNode,
	groupByExpressions: ScalarPlanNode[],
	aggregates: { expression: ScalarPlanNode; alias: string }[]
): RegisteredScope {
	const aggregateOutputScope = new RegisteredScope(parentScope);
	const aggregateAttributes = aggregateNode.getAttributes();

	// Register GROUP BY columns
	groupByExpressions.forEach((expr, index) => {
		const attr = aggregateAttributes[index];
		aggregateOutputScope.registerSymbol(attr.name.toLowerCase(), (exp, s) =>
			new ColumnReferenceNode(s, exp as AST.ColumnExpr, expr.getType(), attr.id, index));
	});

	// Register aggregate columns by their aliases
	aggregates.forEach((agg, index) => {
		const columnIndex = groupByExpressions.length + index;
		const attr = aggregateAttributes[columnIndex];
		aggregateOutputScope.registerSymbol(agg.alias.toLowerCase(), (exp, s) =>
			new ColumnReferenceNode(s, exp as AST.ColumnExpr, agg.expression.getType(), attr.id, columnIndex));
	});

	// Register source columns for HAVING clause access
	// Start after GROUP BY and aggregate columns
	const sourceColumnStartIndex = groupByExpressions.length + aggregates.length;
	for (let i = sourceColumnStartIndex; i < aggregateAttributes.length; i++) {
		const attr = aggregateAttributes[i];
		// Only register if not already registered (avoid conflicts with GROUP BY columns)
		const symbolName = attr.name.toLowerCase();
		const existingSymbols = aggregateOutputScope.getSymbols();
		const alreadyRegistered = existingSymbols.some(([key]) => key === symbolName);
		if (!alreadyRegistered) {
			aggregateOutputScope.registerSymbol(symbolName, (exp, s) =>
				new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, i));
		}
	}

	return aggregateOutputScope;
}

/**
 * Builds HAVING filter clause
 */
function buildHavingFilter(
	input: RelationalPlanNode,
	havingClause: AST.Expression,
	selectContext: PlanningContext,
	aggregateOutputScope: RegisteredScope,
	aggregates: { expression: ScalarPlanNode; alias: string }[],
	groupByExpressions: ScalarPlanNode[]
): RelationalPlanNode {
	const aggregateAttributes = input.getAttributes();

	// Create a hybrid scope that first tries the aggregate output scope,
	// then falls back to the original source scope for column resolution
	const hybridScope = new RegisteredScope();

	// Copy all symbols from aggregate output scope
	for (const [symbolKey, callback] of aggregateOutputScope.getSymbols()) {
		hybridScope.registerSymbol(symbolKey, callback);
	}

	// For any source columns not already registered, register them with
	// references to the source table
	const sourceInput = input.getRelations()[0]; // The AggregateNode's source
	const sourceAttributes = sourceInput.getAttributes();

	sourceAttributes.forEach((sourceAttr, sourceIndex) => {
		const symbolName = sourceAttr.name.toLowerCase();
		const existingSymbols = hybridScope.getSymbols();
		const alreadyRegistered = existingSymbols.some(([key]) => key === symbolName);

		if (!alreadyRegistered) {
			hybridScope.registerSymbol(symbolName, (exp, s) =>
				new ColumnReferenceNode(s, exp as AST.ColumnExpr, sourceAttr.type, sourceAttr.id, sourceIndex));
		}
	});

	// Build HAVING expression with the hybrid scope
	const havingContext: PlanningContext = {
		...selectContext,
		scope: hybridScope,
		aggregates: aggregates.map((agg, index) => {
			const columnIndex = groupByExpressions.length + index;
			const attr = aggregateAttributes[columnIndex];
			return {
				expression: agg.expression,
				alias: agg.alias,
				columnIndex,
				attributeId: attr.id
			};
		})
	};

	const havingExpression = buildExpression(havingContext, havingClause, true);

	return new FilterNode(hybridScope, input, havingExpression);
}

/**
 * Checks if a final projection is needed for complex expressions
 */
function checkNeedsFinalProjection(projections: Projection[]): boolean {
	if (projections.length === 0) {
		return false;
	}

	// Check if any of the projections are complex expressions (not just column refs)
	return projections.some(proj => {
		// If it's not a simple ColumnReferenceNode, we need final projection
		return !CapabilityDetectors.isColumnReference(proj.node);
	});
}

/**
 * Walks an AST expression tree and collects FunctionExpr nodes that resolve
 * to aggregate functions. Does not descend into aggregate arguments (nested
 * aggregates are invalid SQL).
 */
function findAggregateFunctionExprs(
	expr: AST.Expression,
	ctx: PlanningContext,
	results: AST.FunctionExpr[]
): void {
	switch (expr.type) {
		case 'function': {
			const schema = resolveFunctionSchema(ctx, expr.name, expr.args.length);
			if (schema && isAggregateFunctionSchema(schema)) {
				results.push(expr);
				return; // Don't recurse into aggregate arguments
			}
			for (const arg of expr.args) {
				findAggregateFunctionExprs(arg, ctx, results);
			}
			break;
		}
		case 'binary':
			findAggregateFunctionExprs(expr.left, ctx, results);
			findAggregateFunctionExprs(expr.right, ctx, results);
			break;
		case 'unary':
			findAggregateFunctionExprs(expr.expr, ctx, results);
			break;
		case 'cast':
			findAggregateFunctionExprs(expr.expr, ctx, results);
			break;
		case 'collate':
			findAggregateFunctionExprs(expr.expr, ctx, results);
			break;
		case 'between':
			findAggregateFunctionExprs(expr.expr, ctx, results);
			findAggregateFunctionExprs(expr.lower, ctx, results);
			findAggregateFunctionExprs(expr.upper, ctx, results);
			break;
		case 'in':
			findAggregateFunctionExprs(expr.expr, ctx, results);
			if (expr.values) {
				for (const val of expr.values) {
					findAggregateFunctionExprs(val, ctx, results);
				}
			}
			break;
		case 'case':
			if (expr.baseExpr) findAggregateFunctionExprs(expr.baseExpr, ctx, results);
			for (const clause of expr.whenThenClauses) {
				findAggregateFunctionExprs(clause.when, ctx, results);
				findAggregateFunctionExprs(clause.then, ctx, results);
			}
			if (expr.elseExpr) findAggregateFunctionExprs(expr.elseExpr, ctx, results);
			break;
		// Leaf nodes and subqueries – nothing to recurse
		case 'literal':
		case 'column':
		case 'identifier':
		case 'parameter':
		case 'subquery':
		case 'exists':
		case 'windowFunction':
			break;
	}
}

/**
 * Collects aggregate functions from a HAVING clause AST that are not already
 * present in the existing aggregates list. Returns new aggregates to add.
 */
function collectHavingAggregates(
	havingExpr: AST.Expression,
	selectContext: PlanningContext,
	existingAggregates: { expression: ScalarPlanNode; alias: string }[]
): { expression: ScalarPlanNode; alias: string }[] {
	const funcExprs: AST.FunctionExpr[] = [];
	findAggregateFunctionExprs(havingExpr, selectContext, funcExprs);

	if (funcExprs.length === 0) return [];

	// Build canonical keys from the AST expression stored in existing aggregate plan nodes
	const existingKeys = new Set<string>();
	for (const agg of existingAggregates) {
		if (CapabilityDetectors.isAggregateFunction(agg.expression)) {
			const aggNode = agg.expression as AggregateFunctionCallNode;
			existingKeys.add(expressionToString(aggNode.expression).toLowerCase());
		}
	}

	const newAggregates: { expression: ScalarPlanNode; alias: string }[] = [];

	for (const funcExpr of funcExprs) {
		const key = expressionToString(funcExpr).toLowerCase();

		// Skip if already in SELECT aggregates or already collected
		if (existingKeys.has(key)) continue;
		if (newAggregates.some(a => a.alias.toLowerCase() === key)) continue;

		// Build the aggregate plan node in the pre-aggregate scope
		const aggNode = buildFunctionCall(selectContext, funcExpr, true);
		newAggregates.push({ expression: aggNode, alias: expressionToString(funcExpr) });
	}

	return newAggregates;
}

/**
 * Builds final projections for the complete SELECT list in aggregate context
 */
export function buildFinalAggregateProjections(
	stmt: AST.SelectStmt,
	selectContext: PlanningContext,
	aggregateOutputScope: RegisteredScope,
	aggregateNode: RelationalPlanNode,
	aggregates: { expression: ScalarPlanNode; alias: string }[],
	groupByExpressions: ScalarPlanNode[]
): Projection[] {
	const finalProjections: Projection[] = [];
	const aggregateAttributes = aggregateNode.getAttributes();

	// Build context with aggregates so buildFunctionCall can resolve aggregate references
	const aggregatesContext = aggregates.map((agg, index) => {
		const columnIndex = groupByExpressions.length + index;
		const attr = aggregateAttributes[columnIndex];
		return {
			expression: agg.expression,
			alias: agg.alias,
			columnIndex,
			attributeId: attr.id
		};
	});

	for (const column of stmt.columns) {
		if (column.type === 'column') {
			// Re-build the expression in the context of the aggregate output
			const finalContext: PlanningContext = {
				...selectContext,
				scope: aggregateOutputScope,
				aggregates: aggregatesContext
			};
			const scalarNode = buildExpression(finalContext, column.expr, true);

			let attrId: number | undefined = undefined;
			if (CapabilityDetectors.isColumnReference(scalarNode)) {
				attrId = scalarNode.attributeId;
			}

			finalProjections.push({
				node: scalarNode,
				alias: column.alias || (column.expr.type === 'column' ? column.expr.name : undefined),
				attributeId: attrId
			});
		}
	}

	return finalProjections;
}
