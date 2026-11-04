import type { CastNode } from '../../planner/nodes/scalar.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { type SqlValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { castConverter } from '../../types/cast-semantics.js';
import { emitScalarOp, type ScalarOpSpec } from './scalar-op.js';

export function buildCastSpec(plan: CastNode): ScalarOpSpec {
	// The node's own resolved target type — never re-resolve the name here, or the
	// plan can advertise a type the emitter does not produce.
	const logicalType = plan.getType().logicalType;

	const convert = castConverter(logicalType, plan.synthetic);

	function run(
		_runtimeCtx: RuntimeContext,
		operandValue: SqlValue
	): SqlValue {
		return convert(operandValue);
	}

	return {
		operands: [plan.operand],
		run,
		note: `cast(${plan.expression.targetType})`
	};
}

export function emitCast(plan: CastNode, ctx: EmissionContext): Instruction {
	return emitScalarOp(buildCastSpec(plan), ctx);
}
