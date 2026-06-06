import type { DropViewNode } from '../../planner/nodes/drop-view-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue } from '../../common/types.js';

export function emitDropView(plan: DropViewNode, _ctx: EmissionContext): Instruction {
	async function run(rctx: RuntimeContext): Promise<SqlValue> {
		// Ensure we're in a transaction before DDL (lazy/JIT transaction start)
		await rctx.db._ensureTransaction();

		// A materialized view must be dropped with DROP MATERIALIZED VIEW.
		if (rctx.db.schemaManager.getMaterializedView(plan.schemaName, plan.viewName)) {
			throw new QuereusError(
				`'${plan.viewName}' is a materialized view — use DROP MATERIALIZED VIEW`,
				StatusCode.ERROR
			);
		}

		// Check if view exists
		const existingView = rctx.db.schemaManager.getView(plan.schemaName, plan.viewName);

		if (!existingView && !plan.ifExists) {
			throw new QuereusError(
				`View '${plan.schemaName}.${plan.viewName}' does not exist`,
				StatusCode.ERROR
			);
		}

		if (!existingView && plan.ifExists) {
			// View doesn't exist but IF EXISTS was specified, so this is a no-op
			return null;
		}

		// Remove the view from the schema manager
		const schema = rctx.db.schemaManager.getSchema(plan.schemaName);
		if (!schema) {
			throw new QuereusError(
				`Schema '${plan.schemaName}' does not exist`,
				StatusCode.ERROR
			);
		}

		const removed = schema.removeView(plan.viewName);
		if (!removed && !plan.ifExists) {
			throw new QuereusError(
				`View '${plan.schemaName}.${plan.viewName}' does not exist`,
				StatusCode.ERROR
			);
		}

		return null; // Explicitly return null for successful void operations
	}

	return {
		params: [],
		run,
		note: `dropView(${plan.schemaName}.${plan.viewName})`
	};
}
