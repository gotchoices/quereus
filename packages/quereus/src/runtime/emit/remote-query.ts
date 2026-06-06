import type { Instruction, RuntimeContext } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import type { Row } from '../../common/types.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { RemoteQueryNode } from '../../planner/nodes/remote-query-node.js';
import type { AnyVirtualTableModule } from '../../vtab/module.js';
import { disconnectVTable } from '../utils.js';

/**
 * Emitter for RemoteQueryNode.
 * Calls the virtual table's executePlan() method to execute the pushed-down pipeline.
 */
export function emitRemoteQuery(plan: RemoteQueryNode, _ctx: EmissionContext): Instruction {
	async function* run(rctx: RuntimeContext): AsyncIterable<Row> {
		// Retrieve virtual table connection via module context
		const { tableRef, moduleCtx } = plan;
		// Get the table instance - need to resolve this from the table reference
		const tableSchema = tableRef.tableSchema;
		const vtabModule = (moduleCtx as { vtabModule?: AnyVirtualTableModule } | undefined)?.vtabModule ?? tableRef.vtabModule;

		// Connect to the table to get the instance
		const table = await vtabModule.connect(
			rctx.db,
			undefined, // pAux
			tableSchema.vtabModuleName,
			tableSchema.schemaName,
			tableSchema.name,
			{} // empty config for now
		);

		if (!table.executePlan) {
			throw new QuereusError(
				`Virtual table module for '${tableSchema.name}' does not implement executePlan() ` +
				`despite indicating support via supports() method.`,
				StatusCode.INTERNAL
			);
		}

		try {
			for await (const row of table.executePlan(rctx.db, plan.source, plan.moduleCtx)) {
				yield row;
			}
		} finally {
			await disconnectVTable(rctx, table);
		}
	}

	return {
		params: [],
		run,
		note: `remoteQuery(${plan.tableRef.tableSchema.name})`
	};
}
