import type { LimitChoiceNode } from '../../planner/nodes/limit-choice-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import { emitCallFromPlan } from '../emitters.js';
import { resolveWindow } from './limit-offset.js';
import type { EmissionContext } from '../emission-context.js';
import type { MaybePromise, Row, SqlValue } from '../../common/types.js';
import { createLogger } from '../../common/logger.js';

const log = createLogger('runtime:emit:limit-choice');

/** A branch emitted as a sub-program: nothing opens until it is called. */
type BranchCallback = (ctx: RuntimeContext) => AsyncIterable<Row>;
type ScalarCallback = (ctx: RuntimeContext) => MaybePromise<SqlValue>;

/**
 * Emit a LimitChoice: evaluate the LIMIT / OFFSET once per execution and stream one
 * branch. Both branches are on-demand sub-programs (as a nested-loop join's right side
 * is), so the branch not taken never opens a cursor.
 *
 * The LimitOffset above evaluates the same expressions through the same `resolveWindow`
 * before it first pulls from this node, so a value that is not a row count has already
 * thrown there, and the two cannot read the value differently.
 */
export function emitLimitChoice(plan: LimitChoiceNode, ctx: EmissionContext): Instruction {
	async function* run(
		rctx: RuntimeContext,
		ordered: BranchCallback,
		sorted: BranchCallback,
		limitFn: ScalarCallback,
		...offsetFn: ScalarCallback[]
	): AsyncIterable<Row> {
		const { limit, offset } = await resolveWindow(rctx, limitFn, offsetFn[0]);
		// The licence: `ordered` was planned with `limit: orderedUpTo, offset: 0`, which
		// allows the module to stop after `orderedUpTo` rows. Taking it only when
		// `limit + offset <= orderedUpTo` is what keeps a module that does stop there from
		// ever producing fewer rows than the LimitOffset above consumes.
		const takeOrdered = limit + offset <= plan.orderedUpTo;
		log('limit %d + offset %d against %d: %s', limit, offset, plan.orderedUpTo, takeOrdered ? 'ordered' : 'sorted');
		yield* (takeOrdered ? ordered : sorted)(rctx);
	}

	const params: Instruction[] = [
		emitCallFromPlan(plan.ordered, ctx),
		emitCallFromPlan(plan.sorted, ctx),
		emitCallFromPlan(plan.limit, ctx),
	];
	if (plan.offset) params.push(emitCallFromPlan(plan.offset, ctx));

	return {
		params,
		run: asRun(run),
		note: `limit_choice(ordered when limit + offset <= ${plan.orderedUpTo})`,
	};
}
