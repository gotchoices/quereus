import type { DropIndexNode } from '../../planner/nodes/drop-index-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import type { SqlValue } from '../../common/types.js';
import { requireVtabModule } from '../../schema/table.js';
import { assertDdlTransactionPolicy } from './ddl-transaction-policy.js';

export function emitDropIndex(plan: DropIndexNode, _ctx: EmissionContext): Instruction {
	async function run(rctx: RuntimeContext): Promise<SqlValue> {
		// Strict-policy gate (see ddl-transaction-policy.ts). Locate the owning table
		// the same way SchemaManager.dropIndex does — a bare read-only scan, no
		// mutation — so we can consult its module's tier. If nothing owns the index,
		// skip the gate and let dropIndex handle IF EXISTS / not-found.
		const schema = rctx.db.schemaManager.getSchema(plan.schemaName);
		const lowerIndexName = plan.indexName.toLowerCase();
		const owner = schema && Array.from(schema.getAllTables()).find(
			t => t.indexes?.some(idx => idx.name.toLowerCase() === lowerIndexName),
		);
		if (owner) {
			assertDdlTransactionPolicy(
				rctx.db, requireVtabModule(owner), owner.vtabModuleName,
				`DROP INDEX ${plan.indexName}`,
			);
		}

		// Ensure we're in a transaction before DDL (lazy/JIT transaction start)
		await rctx.db._ensureTransaction();

		await rctx.db.schemaManager.dropIndex(plan.schemaName, plan.indexName, plan.ifExists);

		return null;
	}

	return {
		params: [],
		run: asRun(run),
		note: `dropIndex(${plan.schemaName}.${plan.indexName})`
	};
}
