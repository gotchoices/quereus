import type { ScalarFunctionCallNode } from '../../planner/nodes/function.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import { emitPlanNode, createValidatedInstruction } from '../emitters.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue, type OutputValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import type { ScalarFunctionSchema } from '../../schema/function.js';
import { isScalarFunctionSchema } from '../../schema/function.js';

/**
 * Default emission logic for scalar function calls.
 * This is exported so custom emitters can call it if needed.
 */
export function emitScalarFunctionCallDefault(plan: ScalarFunctionCallNode, ctx: EmissionContext): Instruction {
	const functionName = plan.expression.name.toLowerCase();
	const functionSchema = plan.functionSchema;

	// Validate that it's a scalar function
	if (!isScalarFunctionSchema(functionSchema)) {
		throw new QuereusError(`Function ${functionName} is not a scalar function`, StatusCode.ERROR);
	}

	function run(_rctx: RuntimeContext, ...args: Array<SqlValue>): OutputValue {
		// Use the pre-resolved function schema from the plan node
		const scalarFunction = functionSchema as ScalarFunctionSchema;

		// Validate argument count
		if (scalarFunction.numArgs >= 0 && args.length !== scalarFunction.numArgs) {
			throw new QuereusError(`Function ${functionName} called with ${args.length} arguments, expected ${scalarFunction.numArgs}`, StatusCode.ERROR);
		}

		try {
			return scalarFunction.implementation(...args);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			throw new QuereusError(`Function ${functionName} failed: ${message}`, StatusCode.ERROR, error instanceof Error ? error : undefined, plan.expression.loc?.start.line, plan.expression.loc?.start.column);
		}
	}

	const operandExprs = plan.operands.map(operand => emitPlanNode(operand, ctx));

	return createValidatedInstruction(
		operandExprs,
		run as InstructionRun,
		ctx,
		`${plan.expression.name}(${plan.operands.length})`
	);
}

/**
 * Main emitter for scalar function calls.
 * Checks if the function has a custom emitter and uses it, otherwise uses default logic.
 */
export function emitScalarFunctionCall(plan: ScalarFunctionCallNode, ctx: EmissionContext): Instruction {
	const functionSchema = plan.functionSchema;

	// Validate that it's a scalar function
	if (!isScalarFunctionSchema(functionSchema)) {
		const functionName = plan.expression.name.toLowerCase();
		throw new QuereusError(`Function ${functionName} is not a scalar function`, StatusCode.ERROR);
	}

	// Check if function has a custom emitter
	if (functionSchema.customEmitter) {
		return functionSchema.customEmitter(plan, ctx, emitScalarFunctionCallDefault);
	}

	// Use default emission logic
	return emitScalarFunctionCallDefault(plan, ctx);
}
