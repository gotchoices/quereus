import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import type { CTEScopeNode } from '../nodes/cte-node.js';
import { RegisteredScope } from '../scopes/registered.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import { buildWithClause } from './with.js';

/**
 * Builds context with CTEs if present
 */
export function buildWithContext(
	ctx: PlanningContext,
	stmt: AST.SelectStmt,
	parentCTEs: Map<string, CTEScopeNode> = new Map()
): {
	contextWithCTEs: PlanningContext;
	cteNodes: Map<string, CTEScopeNode>;
} {
	// Start with parent CTEs - either from parameter or from context
	const cteNodes: Map<string, CTEScopeNode> = new Map(parentCTEs.size > 0 ? parentCTEs : (ctx.cteNodes ?? new Map()));
	let contextWithCTEs = ctx;

	if (stmt.withClause) {
		const newCteNodes = buildWithClause(ctx, stmt.withClause);
		// Merge parent CTEs with new ones (new ones take precedence)
		for (const [name, node] of newCteNodes) {
			cteNodes.set(name, node);
		}

		// Create a new scope that includes the CTEs
		const cteScope = createCTEScope(cteNodes, ctx);
		contextWithCTEs = { ...ctx, scope: cteScope, cteNodes, cteReferenceCache: ctx.cteReferenceCache };
	} else if (cteNodes.size > 0) {
		// No WITH clause but we have parent CTEs, create scope for them
		const cteScope = createCTEScope(cteNodes, ctx);
		contextWithCTEs = { ...ctx, scope: cteScope, cteNodes, cteReferenceCache: ctx.cteReferenceCache };
	}

	return { contextWithCTEs, cteNodes };
}

/**
 * Creates a scope that includes CTE references
 * CRITICAL: Uses stable input attribute IDs only, ignoring any projection output scopes
 * that might cause attribute ID collisions in correlated subqueries
 */
function createCTEScope(
	cteNodes: Map<string, CTEScopeNode>,
	ctx: PlanningContext
): RegisteredScope {
	// Keep ParameterScope in the chain so parameters can be resolved in queries using CTEs
	const cteScope = new RegisteredScope(ctx.scope);

	// Register each CTE in the scope
	for (const [cteName, cteNode] of cteNodes) {
		// CRITICAL: Use only the stable input attributes from the CTE definition
		// Do NOT use any projection output attributes that might have fresh IDs
		const attributes = cteNode.getAttributes();
		const columnTypes = cteNode.getType().columns;

		// Only register columns that are stable input attributes
		// This prevents scope pollution from projection output attributes
		columnTypes.forEach((col, i) => {
			if (i < attributes.length) {
				const attr = attributes[i];
				// Register CTE columns with qualified names to avoid collisions
				const qualifiedColumnName = `${cteName}.${col.name.toLowerCase()}`;
				cteScope.registerSymbol(qualifiedColumnName, (exp, s) =>
					new ColumnReferenceNode(s, exp as AST.ColumnExpr, col.type, attr.id, i));
			}
		});
	}

	return cteScope;
}
