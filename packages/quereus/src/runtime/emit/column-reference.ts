import type { ColumnReferenceNode } from '../../planner/nodes/reference.js';
import type { Instruction, RuntimeContext } from '../types.js';
import type { SqlValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { resolveAttribute } from '../context-helpers.js';

export function emitColumnReference(plan: ColumnReferenceNode, _ctx: EmissionContext): Instruction {
	function run(rctx: RuntimeContext): SqlValue {
		return resolveAttribute(rctx, plan.attributeId, plan.expression.name);
	}

	return {
		params: [],
		run,
		note: `column(${plan.expression.name})`
	};
}
