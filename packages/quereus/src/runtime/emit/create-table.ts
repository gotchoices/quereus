import type { CreateTableNode } from '../../planner/nodes/create-table-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import { type SqlValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { createMaintainedTable } from './materialized-view-helpers.js';

export function emitCreateTable(plan: CreateTableNode, _ctx: EmissionContext): Instruction {
	async function run(rctx: RuntimeContext): Promise<SqlValue> {
		// Ensure we're in a transaction before DDL (lazy/JIT transaction start)
		await rctx.db._ensureTransaction();

		if (plan.statementAst.maintained) {
			// `create table … maintained as <body>` — the declared-shape maintained
			// form: shape-verify against the body BEFORE registration, then create +
			// attach-to-empty through the shared attach core (all-or-nothing).
			await createMaintainedTable(rctx.db, plan.statementAst);
			return null;
		}

		await rctx.db.schemaManager.createTable(plan.statementAst);
		// The specific error handling for IF NOT EXISTS is within SchemaManager.defineTable.

		return null; // Explicitly return null for successful void operations
	}

	return { params: [], run: asRun(run), note: `createTable(${plan.statementAst.table.name})` };
}
