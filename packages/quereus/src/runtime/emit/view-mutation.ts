import type { ViewMutationNode } from '../../planner/nodes/view-mutation-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import type { RuntimeValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitPlanNode } from '../emitters.js';

/**
 * Emit a view-/MV-mediated mutation.
 *
 * Each child is a fully-built base-table DML subtree (Sink-topped for the
 * non-RETURNING single-source spine). The children are passed as params, so the
 * scheduler evaluates them — draining each Sink fires its base write — in list
 * order before this instruction runs. For the single-source spine there is
 * exactly one child, so this degenerates to driving that one base op.
 *
 * RETURNING-through-view is rejected until 3.2, so the node is a side-effect
 * statement: it yields nothing. The block emitter treats it like a Sink for
 * result selection.
 */
export function emitViewMutation(plan: ViewMutationNode, ctx: EmissionContext): Instruction {
	const children = plan.baseOps.map(op => emitPlanNode(op, ctx));

	function run(_rctx: RuntimeContext, ..._args: RuntimeValue[]): null {
		// Side effects already fired via the param children (the base ops).
		return null;
	}

	return {
		params: children,
		run: run as InstructionRun,
		note: `viewMutation(${children.length} base op${children.length === 1 ? '' : 's'})`,
	};
}
