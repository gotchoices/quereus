import type { PlanningContext } from '../planning-context.js';
import type * as AST from '../../parser/ast.js';
import type { PlanNode } from '../nodes/plan-node.js';
import { AnalyzePlanNode } from '../nodes/analyze-node.js';

export function buildAnalyzeStmt(ctx: PlanningContext, stmt: AST.AnalyzeStmt): PlanNode {
	return new AnalyzePlanNode(ctx.scope, stmt, stmt.tableName, stmt.schemaName);
}
