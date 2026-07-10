import type { CreateIndexNode } from '../../planner/nodes/create-index-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import { type SqlValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';

export function emitCreateIndex(plan: CreateIndexNode, _ctx: EmissionContext): Instruction {
	async function run(rctx: RuntimeContext): Promise<SqlValue> {
		// Ensure we're in a transaction before DDL (lazy/JIT transaction start)
		await rctx.db._ensureTransaction();

		await rctx.db.schemaManager.createIndex(plan.statementAst);
		// The specific error handling for IF NOT EXISTS is within SchemaManager.createIndex.

		return null; // Explicitly return null for successful void operations
	}

	return { params: [], run: asRun(run), note: `createIndex(${plan.statementAst.index.name})` };
}
