import type { ParameterReferenceNode } from '../../planner/nodes/reference.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { SqlValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';

export function emitParameterReference(plan: ParameterReferenceNode, _ctx: EmissionContext): Instruction {
	function run(ctx: RuntimeContext): SqlValue {
		const identifier = plan.nameOrIndex; // This comes from the ParameterReferenceNode instance
		const params = ctx.params;

		if (typeof identifier === 'number') {
			// For ? (anonymous) parameters, identifier is a 1-based index.
			// boundArgs stores numeric keys directly (e.g., { 1: value, 2: value }).
			const key = identifier;
			if (!(key in params)) {
				throw new QuereusError(`Parameter index ${identifier} is out of bounds.`, StatusCode.RANGE);
			}
			return params[key];
		} else if (typeof identifier === 'string') {
			// For named parameters like :name.
			const key = identifier.startsWith(':') ? identifier.substring(1) : identifier;
			if (!(key in params)) {
				throw new QuereusError(`Parameter with name '${key}' not found.`, StatusCode.NOTFOUND);
			}
			return params[key];
		} else {
			// Should not happen given ParameterReferenceNode structure
			throw new QuereusError('Invalid parameter identifier type.', StatusCode.INTERNAL);
		}
	}

	return {
		params: [],
		run,
		note: `param(${typeof plan.nameOrIndex === 'string' ? plan.nameOrIndex : '#' + plan.nameOrIndex})`
	};
}
