import type * as AST from '../../parser/ast.js';
import { isRelationalNode, type Attribute, type PlanNode, type RelationalPlanNode, type ScalarPlanNode } from '../nodes/plan-node.js';
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
import { resolveOrdinalReference } from './select-ordinal.js';

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
	hasWrappedAggregates: boolean = false,
	selectListAsts: AST.Expression[] = []
): {
	output: RelationalPlanNode;
	aggregateScope?: RegisteredScope;
	needsFinalProjection: boolean;
	preAggregateSort: boolean;
	aggregateNode?: RelationalPlanNode;
	groupByExpressions?: ScalarPlanNode[];
	hasHavingOnlyAggregates?: boolean;
	hasOrderByOnlyAggregates?: boolean;
	orderByHasAggregates?: boolean;
	aggregatesContext?: PlanningContext['aggregates'];
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

	// Detect aggregate function references in ORDER BY. They are only legal when
	// the query is otherwise an aggregate query (has aggregates in SELECT/HAVING
	// or has a GROUP BY). When legal, any ORDER BY aggregate not already present
	// in the SELECT or HAVING aggregate list must be added to the AggregateNode
	// so it is computed and available to the post-aggregate sort.
	const orderByHasAggregates = orderByContainsAggregates(stmt.orderBy, selectContext);
	let hasOrderByOnlyAggregates = false;
	if (orderByHasAggregates && (hasAggregates || hasGroupBy)) {
		const orderByAggs = collectOrderByAggregates(stmt.orderBy!, selectContext, aggregates);
		if (orderByAggs.length > 0) {
			aggregates.push(...orderByAggs);
			hasAggregates = true;
			hasOrderByOnlyAggregates = true;
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
	// Handle pre-aggregate sorting for ORDER BY without GROUP BY. Skip when the
	// ORDER BY contains aggregates — those need to run against the post-aggregate
	// row(s), not the per-input rows.
	const preAggregateSort = Boolean(
		hasAggregates && !hasGroupBy && stmt.orderBy && stmt.orderBy.length > 0 && !orderByHasAggregates
	);
	currentInput = handlePreAggregateSort(currentInput, stmt, selectContext, hasAggregates, !!hasGroupBy, orderByHasAggregates, selectListAsts);

	// Build GROUP BY expressions, resolving 1-based positional references against the SELECT list.
	const groupByExpressions = stmt.groupBy ?
		stmt.groupBy.map(expr => {
			const resolved = resolveOrdinalReference(expr, selectListAsts, 'GROUP BY');
			return buildExpression(selectContext, resolved ?? expr, false);
		}) : [];

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

	// Build the aggregates planning context entries so downstream builders
	// (final projection, ORDER BY) can resolve aggregate function references
	// to ColumnReferenceNodes against the AggregateNode output.
	const aggregateAttributes = aggregateNode.getAttributes();
	const aggregatesContext = aggregates.map((agg, index) => {
		const columnIndex = groupByExpressions.length + index;
		const attr = aggregateAttributes[columnIndex];
		return {
			expression: agg.expression,
			alias: agg.alias,
			columnIndex,
			attributeId: attr.id,
		};
	});

	// Handle HAVING clause *after* aggregation only when we did not already push
	// it below the AggregateNode.
	if (stmt.having && !shouldPushHavingBelowAggregate) {
		currentInput = buildHavingFilter(currentInput, stmt.having, selectContext, aggregateOutputScope, aggregates, groupByExpressions);
	}

	// Determine if final projection is needed.
	// Force a final projection when HAVING-only or ORDER-BY-only aggregates were
	// added, to strip them from the output (they exist only for those clauses).
	const needsFinalProjection = hasHavingOnlyAggregates || hasOrderByOnlyAggregates || hasWrappedAggregates || checkNeedsFinalProjection(projections);

	return {
		output: currentInput,
		aggregateScope: aggregateOutputScope,
		needsFinalProjection,
		preAggregateSort,
		aggregateNode,
		groupByExpressions,
		hasHavingOnlyAggregates,
		hasOrderByOnlyAggregates,
		orderByHasAggregates,
		aggregatesContext,
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
	hasGroupBy: boolean,
	orderByHasAggregates: boolean,
	selectListAsts: AST.Expression[]
): RelationalPlanNode {
	// Special handling for ORDER BY with aggregates but no GROUP BY.
	// Skip when ORDER BY itself references aggregates — those must run
	// post-aggregation, not on the per-row input.
	if (hasAggregates && !hasGroupBy && stmt.orderBy && stmt.orderBy.length > 0 && !orderByHasAggregates) {
		// Apply ORDER BY before aggregation
		const sortKeys: SortKey[] = stmt.orderBy.map(orderByClause => {
			const resolved = resolveOrdinalReference(orderByClause.expr, selectListAsts, 'ORDER BY');
			const expression = buildExpression(selectContext, resolved ?? orderByClause.expr);
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

	// Note: the aggregate node advertises exactly its GROUP BY + aggregate columns.
	// Source columns for HAVING / correlated access are resolved through the runtime
	// row-descriptor context and the source-column fallback in buildHavingFilter's
	// hybrid scope — not through extra output attributes on the aggregate.

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
	// then falls back to the original source scope for column resolution.
	// Parent is set so parameters (and named params) resolve via the ancestor chain.
	const hybridScope = new RegisteredScope(selectContext.scope);

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

	// Reject HAVING references to non-grouped, non-aggregated columns.
	// With GROUP BY: only GROUP BY columns/expressions and aggregates are allowed.
	// Without GROUP BY (implicit single group, only reachable here when aggregates
	// are present): only aggregates are allowed.
	// HAVING references resolve through `hybridScope`: GROUP BY columns and
	// aggregate aliases land on AggregateNode-output attribute IDs, while bare
	// source columns (registered as a fallback) land on source attribute IDs.
	// We accept both flavors of "grouped" attribute, plus any subtree whose AST
	// fingerprint matches a GROUP BY expression.
	const allowedAttrIds = new Set<number>();
	const groupByExprFingerprints = new Set<string>();
	for (const expr of groupByExpressions) {
		if (CapabilityDetectors.isColumnReference(expr)) {
			allowedAttrIds.add(expr.attributeId);
		}
		groupByExprFingerprints.add(expressionToString(expr.expression));
	}
	for (let i = 0; i < groupByExpressions.length + aggregates.length; i++) {
		allowedAttrIds.add(aggregateAttributes[i].id);
	}
	const ungrouped = findUngroupedColumnRef(havingExpression, allowedAttrIds, groupByExprFingerprints);
	if (ungrouped) {
		throw new QuereusError(
			`HAVING references non-grouped column '${ungrouped.expression.name}'; ` +
			`HAVING may only reference GROUP BY columns or aggregate expressions`,
			StatusCode.ERROR,
			undefined,
			ungrouped.expression.loc?.start.line,
			ungrouped.expression.loc?.start.column,
		);
	}

	return new FilterNode(hybridScope, input, havingExpression);
}

/**
 * Checks if a final projection is needed for complex expressions or for
 * aliasing simple column refs whose alias differs from the underlying column.
 */
function checkNeedsFinalProjection(projections: Projection[]): boolean {
	if (projections.length === 0) {
		return false;
	}

	return projections.some(proj => {
		// Non-trivial expression — always needs the projection.
		if (!CapabilityDetectors.isColumnReference(proj.node)) return true;
		// Simple column ref — needs projection if the alias renames it, so the
		// SELECT-list alias survives to the output column name.
		const underlyingName = (proj.node as ColumnReferenceNode).expression.name.toLowerCase();
		return Boolean(proj.alias && proj.alias.toLowerCase() !== underlyingName);
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
	return dedupeNewAggregates(funcExprs, selectContext, existingAggregates);
}

/**
 * Collects aggregate functions from each ORDER BY clause expression that are not
 * already present in the existing aggregates list. Returns new aggregates to add.
 */
function collectOrderByAggregates(
	orderBy: AST.OrderByClause[],
	selectContext: PlanningContext,
	existingAggregates: { expression: ScalarPlanNode; alias: string }[]
): { expression: ScalarPlanNode; alias: string }[] {
	const funcExprs: AST.FunctionExpr[] = [];
	for (const clause of orderBy) {
		findAggregateFunctionExprs(clause.expr, selectContext, funcExprs);
	}
	return dedupeNewAggregates(funcExprs, selectContext, existingAggregates);
}

/**
 * Returns true if any ORDER BY clause expression contains an aggregate function call.
 */
function orderByContainsAggregates(
	orderBy: AST.OrderByClause[] | undefined,
	selectContext: PlanningContext
): boolean {
	if (!orderBy || orderBy.length === 0) return false;
	const found: AST.FunctionExpr[] = [];
	for (const clause of orderBy) {
		findAggregateFunctionExprs(clause.expr, selectContext, found);
		if (found.length > 0) return true;
	}
	return false;
}

/**
 * Given a list of aggregate function call AST nodes, builds aggregate plan nodes
 * for the entries that are not already present in `existingAggregates` (matched by
 * canonical AST string), de-duplicating against each other as well.
 */
function dedupeNewAggregates(
	funcExprs: AST.FunctionExpr[],
	selectContext: PlanningContext,
	existingAggregates: { expression: ScalarPlanNode; alias: string }[]
): { expression: ScalarPlanNode; alias: string }[] {
	if (funcExprs.length === 0) return [];

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

		if (existingKeys.has(key)) continue;
		if (newAggregates.some(a => a.alias.toLowerCase() === key)) continue;

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

	// Fingerprint each GROUP BY expression to its output-column index on the
	// AggregateNode. A non-bare SELECT-list item whose *whole* expression matches
	// a GROUP BY expression is exactly that group key's value, so we reference the
	// aggregate's own group output column instead of recomputing the expression
	// over the representative source row. The recompute resolves the inner column
	// to a *base-table* attribute id (the group symbol is registered under
	// `group_N`, not the inner column name, for non-bare group exprs), which is
	// absent from the aggregate output — so `deriveProjectionColumnMap` can't map
	// it and the unique group-key FD is silently dropped at the projection
	// (`keysOf(root) = []`). Referencing the aggregate group column keeps the key
	// and republishes it under exactly its grouping collation (trivially sound).
	const groupByFingerprints = new Map<string, number>();
	groupByExpressions.forEach((expr, index) => {
		const fp = expressionToString(expr.expression);
		if (!groupByFingerprints.has(fp)) groupByFingerprints.set(fp, index);
	});

	for (const column of stmt.columns) {
		if (column.type === 'column') {
			// Bare columns (`type === 'column'`) already resolve against the aggregate
			// group symbol (registered under the column name) in recompute, so their
			// key survives; only non-bare group expressions need the direct reference.
			const gbIdx = column.expr.type !== 'column'
				? groupByFingerprints.get(expressionToString(column.expr))
				: undefined;
			if (gbIdx !== undefined) {
				const colRef = buildGroupKeyColumnRef(aggregateOutputScope, aggregateAttributes[gbIdx], column.expr, gbIdx);
				finalProjections.push({
					node: colRef,
					alias: column.alias,
					attributeId: colRef.attributeId
				});
				continue;
			}

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

/**
 * Synthesizes a bare {@link ColumnReferenceNode} to an AggregateNode group output
 * column for a SELECT-list item that fingerprint-matches a GROUP BY expression.
 *
 * The reference publishes the aggregate column's `type` (the grouping collation,
 * e.g. NOCASE) and `id` (which IS in the aggregate output, so the projection's
 * group-key FD survives). The synthesized AST name is the whole grouped
 * expression's string (e.g. `"b collate nocase"`) so an *unaliased* output column
 * keeps the same name `ProjectNode.buildOutputType` would have produced for the
 * recomputed expression.
 */
function buildGroupKeyColumnRef(
	aggregateOutputScope: RegisteredScope,
	groupAttr: Attribute,
	selectExpr: AST.Expression,
	columnIndex: number,
): ColumnReferenceNode {
	const colExpr: AST.ColumnExpr = { type: 'column', name: expressionToString(selectExpr) };
	return new ColumnReferenceNode(aggregateOutputScope, colExpr, groupAttr.type, groupAttr.id, columnIndex);
}
