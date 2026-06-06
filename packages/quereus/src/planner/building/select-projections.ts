import type * as AST from '../../parser/ast.js';
import { type ScalarPlanNode } from '../nodes/plan-node.js';
import type { PlanningContext } from '../planning-context.js';
import type { Projection } from '../nodes/project-node.js';
import { buildExpression } from './expression.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import { expressionToString } from '../../emit/ast-stringify.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { WindowFunctionCallNode } from '../nodes/window-function.js';
import { type RelationalPlanNode } from '../nodes/plan-node.js';
import type { Scope } from '../scopes/scope.js';
import { CapabilityDetectors } from '../framework/characteristics.js';
import { AggregateFunctionCallNode } from '../nodes/aggregate-function.js';

/**
 * Checks if an expression contains aggregate functions
 */
export function isAggregateExpression(node: ScalarPlanNode): boolean {
	if (CapabilityDetectors.isAggregateFunction(node)) {
		return true;
	}

	// Recursively check children (only scalar children)
	for (const child of node.getChildren()) {
		// Check if child is a scalar node and recursively check it
		if ('expression' in child && isAggregateExpression(child as ScalarPlanNode)) {
			return true;
		}
	}

	return false;
}

/**
 * Checks if an expression contains window functions
 */
export function isWindowExpression(node: ScalarPlanNode): boolean {
	if (CapabilityDetectors.isWindowFunction(node)) {
		return true;
	}

	// Recursively check children (only scalar children)
	for (const child of node.getChildren()) {
		// Check if child is a scalar node and recursively check it
		if ('expression' in child && isWindowExpression(child as ScalarPlanNode)) {
			return true;
		}
	}

	return false;
}

/**
 * Builds projections for SELECT * or table.*
 */
export function buildStarProjections(
	column: { type: 'all'; table?: string },
	source: RelationalPlanNode,
	selectScope: Scope
): Projection[] {
	const allAttributes = source.getAttributes();

	// Filter by relation name if qualified (e.g., SELECT t1.*)
	const matchingAttributes = column.table
		? allAttributes.filter(attr =>
			attr.relationName && attr.relationName.toLowerCase() === column.table!.toLowerCase()
		)
		: allAttributes;

	if (column.table && matchingAttributes.length === 0) {
		throw new QuereusError(
			`Table '${column.table}' not found in FROM clause for qualified SELECT *`,
			StatusCode.ERROR
		);
	}

	// Convert to projections
	return matchingAttributes.map((attr, index) => {
		const columnExpr: AST.ColumnExpr = {
			type: 'column',
			name: attr.name,
		};

		const columnRef = new ColumnReferenceNode(
			selectScope,
			columnExpr,
			attr.type,
			attr.id,
			index
		);

		return {
			node: columnRef,
			alias: attr.name
		};
	});
}

/**
 * Collects all inner AggregateFunctionCallNode instances from a scalar expression tree.
 * Used when a scalar function wraps aggregates (e.g. coalesce(max(val), 0)).
 * Does not recurse into aggregate arguments (aggregates can't nest).
 */
function collectInnerAggregates(
	node: ScalarPlanNode,
	aggregates: { expression: ScalarPlanNode; alias: string }[]
): void {
	if (CapabilityDetectors.isAggregateFunction(node)) {
		const funcNode = node as AggregateFunctionCallNode;
		const key = expressionToString(funcNode.expression).toLowerCase();
		// Deduplicate against existing entries
		if (!aggregates.some(a => a.alias.toLowerCase() === key)) {
			aggregates.push({
				expression: funcNode,
				alias: expressionToString(funcNode.expression)
			});
		}
		return; // Don't recurse into aggregate arguments
	}

	for (const child of node.getChildren()) {
		if ('expression' in child) {
			collectInnerAggregates(child as ScalarPlanNode, aggregates);
		}
	}
}

/**
 * Analyzes SELECT columns and categorizes them into different types
 */
export function analyzeSelectColumns(
	columns: AST.ResultColumn[],
	selectContext: PlanningContext
): {
	projections: Projection[];
	aggregates: { expression: ScalarPlanNode; alias: string }[];
	windowFunctions: { func: WindowFunctionCallNode; alias?: string }[];
	hasAggregates: boolean;
	hasWindowFunctions: boolean;
	hasWrappedAggregates: boolean;
} {
	const projections: Projection[] = [];
	const aggregates: { expression: ScalarPlanNode; alias: string }[] = [];
	const windowFunctions: { func: WindowFunctionCallNode; alias?: string }[] = [];
	let hasAggregates = false;
	let hasWindowFunctions = false;
	let hasWrappedAggregates = false;

	for (const column of columns) {
		if (column.type === 'all') {
			// Handle SELECT * - will be processed separately
			continue;
		} else if (column.type === 'column') {
			const scalarNode = buildExpression(selectContext, column.expr, true);

			if (isWindowExpression(scalarNode)) {
				hasWindowFunctions = true;
				collectWindowFunctions(scalarNode, column.alias, windowFunctions);
				projections.push({
					node: scalarNode,
					alias: column.alias
				});
			} else if (isAggregateExpression(scalarNode)) {
				hasAggregates = true;
				if (CapabilityDetectors.isAggregateFunction(scalarNode)) {
					// Direct aggregate — add as-is (existing behavior)
					aggregates.push({
						expression: scalarNode,
						alias: column.alias || expressionToString(column.expr)
					});
				} else {
					// Scalar wrapping aggregate(s) — extract only the inner aggregate(s)
					collectInnerAggregates(scalarNode, aggregates);
					hasWrappedAggregates = true;
				}
			} else {
				projections.push({
					node: scalarNode,
					alias: column.alias
				});
			}
		}
	}

	return {
		projections,
		aggregates,
		windowFunctions,
		hasAggregates,
		hasWindowFunctions,
		hasWrappedAggregates
	};
}

/**
 * Collects all window functions from an expression tree, along with their aliases
 */
function collectWindowFunctions(
	node: ScalarPlanNode,
	alias?: string,
	windowFunctions: { func: WindowFunctionCallNode; alias?: string }[] = []
): { func: WindowFunctionCallNode; alias?: string }[] {
	if (CapabilityDetectors.isWindowFunction(node)) {
		windowFunctions.push({ func: node as WindowFunctionCallNode, alias });
	}

	// Recursively check children (only scalar children)
	for (const child of node.getChildren()) {
		if ('expression' in child) {
			collectWindowFunctions(child as ScalarPlanNode, undefined, windowFunctions);
		}
	}

	return windowFunctions;
}
