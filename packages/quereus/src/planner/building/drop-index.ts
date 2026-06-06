import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { DropIndexNode } from '../nodes/drop-index-node.js';

/**
 * Builds a plan node for DROP INDEX statements.
 */
export function buildDropIndexStmt(ctx: PlanningContext, stmt: AST.DropStmt): DropIndexNode {
	const schemaName = stmt.name.schema || 'main';
	const indexName = stmt.name.name;

	return new DropIndexNode(
		ctx.scope,
		indexName,
		schemaName,
		stmt.ifExists
	);
}
