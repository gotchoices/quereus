import type { FilterNode } from '../../planner/nodes/filter.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { OutputValue, StatusCode, type Row, type SqlValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { buildRowDescriptor } from '../../util/row-descriptor.js';
import { createRowSlot } from '../context-helpers.js';
import { QuereusError } from '../../common/errors.js';
import { isTruthy } from '../../util/comparison.js';
import { resolveMaybe } from '../async-util.js';

function asPredicateScalar(value: unknown): SqlValue {
	if (value === null) return null;
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return value;
	if (value instanceof Uint8Array) return value;
	throw new QuereusError(`Filter predicate returned non-scalar value: ${String(value)}`, StatusCode.INTERNAL);
}

export function emitFilter(plan: FilterNode, ctx: EmissionContext): Instruction {
	const sourceInstruction = emitPlanNode(plan.source, ctx);
	const predicateFunc = emitCallFromPlan(plan.predicate, ctx);

	// Create row descriptor for source attributes
	const sourceRowDescriptor = buildRowDescriptor(plan.source.getAttributes());

	async function* run(rctx: RuntimeContext, source: AsyncIterable<Row>, predicate: (ctx: RuntimeContext) => OutputValue): AsyncIterable<Row> {
		const sourceSlot = createRowSlot(rctx, sourceRowDescriptor);
		try {
			for await (const sourceRow of source) {
				sourceSlot.set(sourceRow);
				// Resolve the predicate without a per-row microtask hop: the sub-program
				// almost always completes synchronously, so `await` only when it is
				// genuinely a promise. See resolveMaybe in runtime/async-util.ts.
				const decision = resolveMaybe(predicate(rctx), (result) => isTruthy(asPredicateScalar(result)));
				if (decision instanceof Promise ? await decision : decision) {
					yield sourceRow;
				}
			}
		} finally {
			sourceSlot.close();
		}
	}

	return {
		params: [sourceInstruction, predicateFunc],
		run: asRun(run),
		note: `filter(${plan.predicate.toString()})`
	};
}
