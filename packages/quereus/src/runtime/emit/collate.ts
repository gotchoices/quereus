import type { CollateNode } from '../../planner/nodes/scalar.js';
import type { Instruction } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import type { EmissionContext } from '../emission-context.js';

export function emitCollate(plan: CollateNode, ctx: EmissionContext): Instruction {
	// No runtime effect
	return emitPlanNode(plan.operand, ctx);
}
