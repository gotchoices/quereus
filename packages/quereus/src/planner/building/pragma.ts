import type { PlanningContext } from '../planning-context.js';
import * as AST from '../../parser/ast.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue } from '../../common/types.js';
import { PragmaPlanNode } from '../nodes/pragma.js';
import { SinkNode } from '../nodes/sink-node.js';
import { getSyncLiteral } from '../../parser/utils.js';
import type { PlanNode } from '../nodes/plan-node.js';

export function buildPragmaStmt(ctx: PlanningContext, stmt: AST.PragmaStmt): PlanNode {
	const pragmaName = stmt.name.toLowerCase();

	let value: SqlValue | undefined;
	if (stmt.value) {
		if (stmt.value.type === 'literal') {
			value = getSyncLiteral(stmt.value);
		} else if (stmt.value.type === 'identifier') {
			value = stmt.value.name;
		} else {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			throw new QuereusError(`Unsupported PRAGMA value type: ${(stmt.value as any).type}`, StatusCode.ERROR);
		}
	}

	const pragmaNode = new PragmaPlanNode(ctx.scope, pragmaName, stmt, value);

	// If this is a setting operation (has a value), wrap with SinkNode to ensure execution
	if (value !== undefined) {
		return new SinkNode(ctx.scope, pragmaNode, 'pragma-set');
	}

	// Reading operation - return the PRAGMA node directly
	return pragmaNode;
}
