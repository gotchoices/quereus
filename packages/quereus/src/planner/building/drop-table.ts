import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { DropTableNode } from '../nodes/drop-table-node.js';

export function buildDropTableStmt(
  ctx: PlanningContext,
  stmt: AST.DropStmt,
): DropTableNode {
  return new DropTableNode(
    ctx.scope,
    stmt,
  );
}
