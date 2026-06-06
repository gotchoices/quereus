import type { PlanningContext } from '../planning-context.js';
import type * as AST from '../../parser/ast.js';
import { CreateAssertionNode } from '../nodes/create-assertion-node.js';

export function buildCreateAssertionStmt(ctx: PlanningContext, stmt: AST.CreateAssertionStmt): CreateAssertionNode {
	return new CreateAssertionNode(ctx.scope, stmt.name, stmt.check);
}
