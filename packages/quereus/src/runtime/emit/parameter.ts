import type { ParameterReferenceNode } from '../../planner/nodes/reference.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { SqlValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitScalarOp, type ScalarOpSpec } from './scalar-op.js';

export function buildParameterSpec(plan: ParameterReferenceNode): ScalarOpSpec {
	// The throw stays inside the body: the binding is not known at emit time.
	function run(ctx: RuntimeContext): SqlValue {
		const identifier = plan.nameOrIndex; // This comes from the ParameterReferenceNode instance
		const params = ctx.params;

		if (typeof identifier === 'number') {
			// For ? (anonymous) parameters, identifier is a 1-based index.
			// boundArgs stores numeric keys directly (e.g., { 1: value, 2: value }).
			if (!Object.hasOwn(params, identifier)) {
				throw new QuereusError(`Parameter index ${identifier} is out of bounds.`, StatusCode.RANGE);
			}
			return params[identifier];
		} else if (typeof identifier === 'string') {
			// For named parameters like :name. Both sides are already bare: the planner
			// strips the prefix when it builds `nameOrIndex`, and every bound key passes
			// through `normalizeBoundParams` on the way into `params`.
			//
			// `hasOwn`, not `in`: the name comes from user SQL, and a run site that builds
			// its RuntimeContext by hand still passes a plain `{}` (const-evaluator,
			// deferred-constraint-queue, ...), where `'toString' in params` is true and
			// would hand the query an inherited function instead of reporting it unbound.
			if (!Object.hasOwn(params, identifier)) {
				throw new QuereusError(`Parameter with name '${identifier}' not found.`, StatusCode.NOTFOUND);
			}
			return params[identifier];
		} else {
			// Should not happen given ParameterReferenceNode structure
			throw new QuereusError('Invalid parameter identifier type.', StatusCode.INTERNAL);
		}
	}

	return {
		operands: [],
		run,
		note: `param(${typeof plan.nameOrIndex === 'string' ? plan.nameOrIndex : '#' + plan.nameOrIndex})`
	};
}

export function emitParameterReference(plan: ParameterReferenceNode, ctx: EmissionContext): Instruction {
	return emitScalarOp(buildParameterSpec(plan), ctx);
}
