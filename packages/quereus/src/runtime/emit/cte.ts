import type { CTENode } from '../../planner/nodes/cte-node.js';
import type { Instruction, InstructionRun, RuntimeContext } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitPlanNode } from '../emitters.js';
import type { Row } from '../../common/types.js';

export function emitCTE(plan: CTENode, ctx: EmissionContext): Instruction {
	// Emit the underlying query
	const queryInstruction = emitPlanNode(plan.source, ctx);

	// For now, we'll implement CTEs as simply executing the underlying query
	// In a full implementation, this would handle materialization based on the hint
	async function* run(rctx: RuntimeContext, queryResult: AsyncIterable<Row>): AsyncIterable<Row> {
		// If materialization is explicitly requested or beneficial,
		// we could materialize the result here
		if (plan.materializationHint === 'materialized') {
			// Materialize the CTE result
			const materializedRows: Row[] = [];
			for await (const row of queryResult) {
				materializedRows.push(row);
			}
			// Yield all materialized rows
			for (const row of materializedRows) {
				yield row;
			}
		} else {
			// Stream the results directly
			for await (const row of queryResult) {
				yield row;
			}
		}
	}

	return {
		params: [queryInstruction],
		run: run as InstructionRun,
		note: `cte(${plan.cteName})`
	};
}
