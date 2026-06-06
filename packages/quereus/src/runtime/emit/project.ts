import type { ProjectNode } from '../../planner/nodes/project-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { type Row } from '../../common/types.js';
import { type OutputValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { buildRowDescriptor } from '../../util/row-descriptor.js';
import { createRowSlot } from '../context-helpers.js';

export function emitProject(plan: ProjectNode, ctx: EmissionContext): Instruction {
	const sourceInstruction = emitPlanNode(plan.source, ctx);
	const projectionFuncs = plan.projections.map((projection) => {
		return emitCallFromPlan(projection.node, ctx);
	});

	// Row descriptors
	const sourceRowDescriptor = buildRowDescriptor(plan.source.getAttributes());
	const outputRowDescriptor = buildRowDescriptor(plan.getAttributes());

	async function* run(rctx: RuntimeContext, source: AsyncIterable<Row>, ...projectionFunctions: Array<(ctx: RuntimeContext) => OutputValue>): AsyncIterable<Row> {
		// Output slot is created FIRST so it is older in the context Map.
		// resolveAttribute searches newest→oldest, so the source slot
		// (created second) wins during projection evaluation, preventing
		// stale output data from shadowing the current source row when
		// output and source descriptors share attribute IDs.
		const outputSlot = createRowSlot(rctx, outputRowDescriptor);
		const sourceSlot = createRowSlot(rctx, sourceRowDescriptor);
		try {
			for await (const sourceRow of source) {
				// Set source context for projection evaluation
				sourceSlot.set(sourceRow);
				const outputs: OutputValue[] = [];
				for (const fn of projectionFunctions) {
					outputs.push(await fn(rctx));
				}
				const outputRow = outputs as Row;

				// Set output context for downstream column resolution
				outputSlot.set(outputRow);
				yield outputRow;
			}
		} finally {
			sourceSlot.close();
			outputSlot.close();
		}
	}

	return {
		params: [sourceInstruction, ...projectionFuncs],
		run: run as InstructionRun,
		note: `project(${plan.projections.length} cols)`
	};
}
