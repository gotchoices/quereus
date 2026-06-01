import type { ViewMutationNode } from '../../planner/nodes/view-mutation-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import type { RuntimeValue, OutputValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitCallFromPlan } from '../emitters.js';
import { isAsyncIterable } from '../utils.js';

/**
 * Emit a view-/MV-mediated mutation.
 *
 * Each base op is a fully-built base-table DML subtree (Sink-topped for the
 * non-RETURNING spine). They are emitted as **callbacks** (`emitCallFromPlan`
 * wraps each subtree in its own sub-program) rather than bare params, then this
 * instruction's `run` invokes them **sequentially**, awaiting each to completion
 * before starting the next.
 *
 * This sequencing is load-bearing for multi-source decomposition: the scheduler
 * kicks off sibling params concurrently (it does not await one before starting
 * the next — see `Scheduler.runAsync`), so a bare-param fan-out would interleave
 * the base writes and lose the FK-parent-before-child ordering that `propagate`
 * decided. Driving the callbacks in list order here makes the emitted order the
 * executed order. For the single-source spine there is exactly one base op, so
 * this degenerates to driving that one to completion (parity with the prior
 * single-param form).
 *
 * RETURNING-through-view is rejected until a later phase, so every base op is a
 * side-effect statement that yields nothing and this node yields nothing; the
 * block emitter treats it like a Sink for result selection.
 */
export function emitViewMutation(plan: ViewMutationNode, ctx: EmissionContext): Instruction {
	const callbacks = plan.baseOps.map(op => emitCallFromPlan(op, ctx));

	async function run(rctx: RuntimeContext, ...cbs: RuntimeValue[]): Promise<null> {
		for (const cb of cbs) {
			// Each callback is `(ctx) => program.run(ctx)` — run the base op's
			// sub-program to completion before advancing to the next base op.
			const result = (cb as (c: RuntimeContext) => OutputValue)(rctx);
			const resolved = result instanceof Promise ? await result : result;
			// A Sink-topped base op resolves to null; defensively drain a relational
			// result (a future RETURNING op) so its writes fire before the next op.
			if (isAsyncIterable(resolved)) {
				for await (const _row of resolved) { /* drain side effects */ }
			}
		}
		return null;
	}

	return {
		params: callbacks,
		run: run as InstructionRun,
		note: `viewMutation(${callbacks.length} base op${callbacks.length === 1 ? '' : 's'})`,
	};
}
