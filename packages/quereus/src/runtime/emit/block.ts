import type { BlockNode } from '../../planner/nodes/block.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import type { RuntimeValue, OutputValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { PlanNodeType } from '../../planner/nodes/plan-node-type.js';

export function emitBlock(plan: BlockNode, ctx: EmissionContext): Instruction {
	// For blocks, our result is the last statement that is not a sink or view
	// mutation (both are void side-effect statements, not result relations)
	const valueIndex = plan.statements.findLastIndex(stmt =>
		stmt.nodeType !== PlanNodeType.Sink && stmt.nodeType !== PlanNodeType.ViewMutation);

	async function run(ctx: RuntimeContext, ...args: RuntimeValue[]): Promise<OutputValue> {
		return valueIndex === -1 ? null : args[valueIndex];
	}

	const statements = plan.statements.map(stmt => emitPlanNode(stmt, ctx));

	return {
		params: statements,
		run: run as InstructionRun,
		note: `block(${plan.statements.length} stmts, result idx: ${valueIndex})`
	};
}
