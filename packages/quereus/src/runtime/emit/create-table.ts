import type { CreateTableNode } from '../../planner/nodes/create-table-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import { type SqlValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';

export function emitCreateTable(plan: CreateTableNode, _ctx: EmissionContext): Instruction {
	async function run(rctx: RuntimeContext): Promise<SqlValue | undefined> {
		// Ensure we're in a transaction before DDL (lazy/JIT transaction start)
		await rctx.db._ensureTransaction();

		await rctx.db.schemaManager.createTable(plan.statementAst);
		// The specific error handling for IF NOT EXISTS is within SchemaManager.defineTable.

		return null; // Explicitly return null for successful void operations
	}

	return { params: [], run: run as InstructionRun, note: `createTable(${plan.statementAst.table.name})` };
}
