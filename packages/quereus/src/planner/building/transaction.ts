import * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { TransactionPlanNode } from '../nodes/transaction-node.js';

export function buildBeginStmt(ctx: PlanningContext, stmt: AST.BeginStmt): TransactionPlanNode {
	return new TransactionPlanNode(ctx.scope, 'begin', stmt);
}

export function buildCommitStmt(ctx: PlanningContext, stmt: AST.CommitStmt): TransactionPlanNode {
	return new TransactionPlanNode(ctx.scope, 'commit', stmt);
}

export function buildRollbackStmt(ctx: PlanningContext, stmt: AST.RollbackStmt): TransactionPlanNode {
	return new TransactionPlanNode(ctx.scope, 'rollback', stmt, stmt.savepoint);
}

export function buildSavepointStmt(ctx: PlanningContext, stmt: AST.SavepointStmt): TransactionPlanNode {
	return new TransactionPlanNode(ctx.scope, 'savepoint', stmt, stmt.name);
}

export function buildReleaseStmt(ctx: PlanningContext, stmt: AST.ReleaseStmt): TransactionPlanNode {
	return new TransactionPlanNode(ctx.scope, 'release', stmt, stmt.savepoint);
}
