import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { DropViewNode } from '../nodes/drop-view-node.js';

/**
 * Builds a plan node for DROP VIEW statements.
 */
export function buildDropViewStmt(ctx: PlanningContext, stmt: AST.DropStmt): DropViewNode {
	// Extract schema and view name
	const schemaName = stmt.name.schema || 'main';
	const viewName = stmt.name.name;

	return new DropViewNode(
		ctx.scope,
		viewName,
		schemaName,
		stmt.ifExists
	);
}
