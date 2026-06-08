import type { ReturningNode } from '../../planner/nodes/returning-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import type { Row, OutputValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { buildRowDescriptor } from '../../util/row-descriptor.js';
import { createRowSlot } from '../context-helpers.js';

export function emitReturning(plan: ReturningNode, ctx: EmissionContext): Instruction {
	// Use the executor's attributes to build the row descriptor
	// The executor should already output the correct flat OLD/NEW format for mutation operations
	const sourceRowDescriptor = buildRowDescriptor(plan.executor.getAttributes());

	// Pre-emit the projection expressions
	const projectionEvaluators = plan.projections.map(proj =>
		emitCallFromPlan(proj.node, ctx)
	);

	async function* run(
		rctx: RuntimeContext,
		executorRows: AsyncIterable<Row>,
		...projectionCallbacks: Array<(ctx: RuntimeContext) => OutputValue>
	): AsyncIterable<Row> {
		const slot = createRowSlot(rctx, sourceRowDescriptor);
		try {
			for await (const sourceRow of executorRows) {
				slot.set(sourceRow);
				// Sequential evaluation: parallel callbacks that share a plan
				// subtree (e.g. two scalar subqueries against the same CTE)
				// would race on the shared inner-scan RowSlot. See ticket
				// serialize-project-subquery-evaluation for the canonical fix.
				const outputs: OutputValue[] = [];
				for (const func of projectionCallbacks) {
					outputs.push(await func(rctx));
				}
				yield outputs as Row;
			}
		} finally {
			slot.close();
		}
	}

	// Emit the executor (now always produces rows)
	const executorInstruction = emitPlanNode(plan.executor, ctx);

	return {
		params: [executorInstruction, ...projectionEvaluators],
		run: run as InstructionRun,
		note: `returning(${plan.projections.length} cols)`
	};
}
