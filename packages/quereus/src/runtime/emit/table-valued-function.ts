import type { Instruction, InstructionRun, RuntimeContext } from '../types.js';
import { emitPlanNode, createValidatedInstruction } from '../emitters.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue, type Row } from '../../common/types.js';
import type { FunctionSchema, IntegratedTableValuedFunc, TableValuedFunc } from '../../schema/function.js';
import { isTableValuedFunctionSchema } from '../../schema/function.js';
import type { EmissionContext } from '../emission-context.js';
import type { TableFunctionCallNode } from '../../planner/nodes/table-function-call.js';
import { buildRowDescriptor } from '../../util/row-descriptor.js';
import { createRowSlot } from '../context-helpers.js';

export function emitTableValuedFunctionCall(plan: TableFunctionCallNode, ctx: EmissionContext): Instruction {
	const functionName = plan.functionName.toLowerCase();
	const numArgs = plan.operands.length;

	// Create row descriptor for function output attributes
	const rowDescriptor = buildRowDescriptor(plan.getAttributes());

	// Look up the function during emission and record the dependency
	// First try exact argument count, then try variable argument function
	let functionSchema = ctx.findFunction(functionName, numArgs);
	if (!functionSchema) {
		functionSchema = ctx.findFunction(functionName, -1); // Try variable argument function
	}
	if (!functionSchema) {
		throw new QuereusError(`Function not found: ${functionName}/${numArgs}`, StatusCode.ERROR);
	}
	if (!isTableValuedFunctionSchema(functionSchema)) {
		throw new QuereusError(`Function ${functionName}/${numArgs} is not a table-valued function`, StatusCode.ERROR);
	}

	// Capture the function key for runtime retrieval (use the actual function's numArgs)
	const functionKey = `function:${functionName}/${functionSchema.numArgs}`;

	async function* runIntegrated(innerCtx: RuntimeContext, ...args: Array<SqlValue>): AsyncIterable<Row> {
		// Use the captured function schema instead of doing a fresh lookup
		const capturedFunction = ctx.getCapturedSchemaObject<FunctionSchema>(functionKey);
		if (!capturedFunction) {
			throw new QuereusError(`Function ${functionName}/${numArgs} was not captured during emission`, StatusCode.INTERNAL);
		}

		if (!isTableValuedFunctionSchema(capturedFunction)) {
			throw new QuereusError(`Function ${functionName}/${numArgs} is not a table-valued function at runtime`, StatusCode.INTERNAL);
		}

		try {
			// Check if this is a database-aware function
			const result = (capturedFunction.implementation as IntegratedTableValuedFunc)!(innerCtx.db, ...args);

			// Handle both direct AsyncIterable and Promise<AsyncIterable>
			const iterable = result instanceof Promise ? await result : result;

			const slot = createRowSlot(innerCtx, rowDescriptor);
			try {
				for await (const row of iterable) {
					slot.set(row);
					yield row;
				}
			} finally {
				slot.close();
			}
		} catch (error: any) {
			throw new QuereusError(`Table-valued function ${functionName} failed: ${error.message}`, StatusCode.ERROR, error);
		}
	}

	async function* run(innerCtx: RuntimeContext, ...args: Array<SqlValue>): AsyncIterable<Row> {
		// Use the captured function schema instead of doing a fresh lookup
		const capturedFunction = ctx.getCapturedSchemaObject<FunctionSchema>(functionKey);
		if (!capturedFunction) {
			throw new QuereusError(`Function ${functionName}/${functionSchema!.numArgs} was not captured during emission`, StatusCode.INTERNAL);
		}

		if (!isTableValuedFunctionSchema(capturedFunction)) {
			throw new QuereusError(`Function ${functionName}/${numArgs} is not a table-valued function at runtime`, StatusCode.INTERNAL);
		}

		// Validate argument count for variable argument functions
		if (capturedFunction.numArgs === -1) {
			// Special validation for known variable argument functions
			if (functionName === 'json_each' || functionName === 'json_tree') {
				if (args.length < 1 || args.length > 2) {
					throw new QuereusError(`Error: ${functionName} requires 1 or 2 arguments (jsonSource, [rootPath])`, StatusCode.ERROR);
				}
			}
		}

		try {
			// Check if this is a database-aware function
			const result = (capturedFunction.implementation as TableValuedFunc)!(...args);

			// Handle both direct AsyncIterable and Promise<AsyncIterable>
			const iterable = result instanceof Promise ? await result : result;

			const slot = createRowSlot(innerCtx, rowDescriptor);
			try {
				for await (const row of iterable) {
					slot.set(row);
					yield row;
				}
			} finally {
				slot.close();
			}
		} catch (error: any) {
			throw new QuereusError(`Table-valued function ${functionName} failed: ${error.message}`, StatusCode.ERROR, error);
		}
	}

	const operandExprs = plan.operands.map(operand => emitPlanNode(operand, ctx));
	const runFunction = functionSchema.isIntegrated ? runIntegrated : run;

	return createValidatedInstruction(
		[...operandExprs],
		runFunction as InstructionRun,
		ctx,
		`TVF:${plan.functionName}(${plan.operands.length})`
	);
}
