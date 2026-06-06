import type { Row } from '../../common/types.js';
import type { InternalRecursiveCTERefNode } from '../../planner/nodes/internal-recursive-cte-ref-node.js';
import type { EmissionContext } from '../emission-context.js';
import { createValidatedInstruction } from '../emitters.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { buildRowDescriptor } from '../../util/row-descriptor.js';
import { createRowSlot } from '../context-helpers.js';

export function emitInternalRecursiveCTERef(plan: InternalRecursiveCTERefNode, ctx: EmissionContext): Instruction {
	// Create row descriptor for output attributes
	const rowDescriptor = buildRowDescriptor(plan.getAttributes());

	async function* run(rctx: RuntimeContext): AsyncIterable<Row> {
		// Look up the working table from runtime context using the tableDescriptor
		const tableGetter = rctx.tableContexts.get(plan.workingTableDescriptor);
		if (!tableGetter) {
			throw new QuereusError(
				`Internal recursive CTE '${plan.cteName}' working table not found in context`,
				StatusCode.INTERNAL
			);
		}

		const slot = createRowSlot(rctx, rowDescriptor);
		try {
			for await (const row of tableGetter()) {
				slot.set(row);
				yield row;
			}
		} finally {
			slot.close();
		}
	}

	return createValidatedInstruction(
		[], // No instruction parameters - data comes from table context
		run,
		ctx,
		`internal_recursive_ref(${plan.cteName}${plan.alias ? ` AS ${plan.alias}` : ''})`
	);
}
