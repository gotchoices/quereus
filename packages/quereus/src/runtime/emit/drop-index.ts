import type { DropIndexNode } from '../../planner/nodes/drop-index-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import type { SqlValue } from '../../common/types.js';

export function emitDropIndex(plan: DropIndexNode, _ctx: EmissionContext): Instruction {
	async function run(rctx: RuntimeContext): Promise<SqlValue> {
		// Ensure we're in a transaction before DDL (lazy/JIT transaction start)
		await rctx.db._ensureTransaction();

		await rctx.db.schemaManager.dropIndex(plan.schemaName, plan.indexName, plan.ifExists);

		return null;
	}

	return {
		params: [],
		run: run as InstructionRun,
		note: `dropIndex(${plan.schemaName}.${plan.indexName})`
	};
}
