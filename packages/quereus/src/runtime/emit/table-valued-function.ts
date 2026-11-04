import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import { emitPlanNode, createValidatedInstruction } from '../emitters.js';
import { AbortError, QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue, type Row } from '../../common/types.js';
import type { FunctionSchema, IntegratedTableValuedFunc, TableValuedFunc } from '../../schema/function.js';
import { isTableValuedFunctionSchema } from '../../schema/function.js';
import type { EmissionContext } from '../emission-context.js';
import type { TableFunctionCallNode } from '../../planner/nodes/table-function-call.js';
import { buildRowDescriptor } from '../../util/row-descriptor.js';
import { createRowSlot } from '../context-helpers.js';
import { REPR_STRICT } from '../strict-flags.js';
import { assertRowConforms, RepresentationError } from '../strict-representation.js';

export function emitTableValuedFunctionCall(plan: TableFunctionCallNode, ctx: EmissionContext): Instruction {
	const functionName = plan.functionName.toLowerCase();
	const numArgs = plan.operands.length;

	// Create row descriptor for function output attributes
	const rowDescriptor = buildRowDescriptor(plan.getAttributes());
	const declaredColumnCount = plan.getAttributes().length;

	// Normalize yielded rows to the declared column count: pad short rows with null,
	// truncate over-wide rows. Keeps attribute resolution (`resolveAttribute` checks
	// `columnIndex < row.length`) consistent with the declared schema regardless of
	// what the TVF implementation actually yields.
	// A TVF that declares no columns (e.g. `split_string`, registered without a
	// `returnType`) opts out entirely — it has no positional slots to align, so
	// truncating to zero width would silently drop the row payload.
	const normalizeRow = (row: Row): Row => {
		if (declaredColumnCount === 0 || row.length === declaredColumnCount) return row;
		return row.length < declaredColumnCount
			? [...row, ...new Array(declaredColumnCount - row.length).fill(null)]
			: row.slice(0, declaredColumnCount);
	};

	// QUEREUS_REPR_STRICT seam: rows a table-valued function yields, checked against its
	// declared column types, so a drifting implementation (in-tree or plugin) is reported
	// here rather than in whichever operator or module first trips over the value. A
	// function declaring no columns has empty arrays here: its cells take R1 only, which
	// binds every value whatever its declared type. Built only when the flag is on.
	const reprColumnTypes = REPR_STRICT ? plan.getType().columns.map(col => col.type.logicalType) : undefined;
	const reprColumnNames = REPR_STRICT ? plan.getType().columns.map(col => col.name) : undefined;
	const reprWhere = REPR_STRICT ? `the row yielded by table-valued function ${functionName}(${numArgs})` : '';

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

	async function* run(innerCtx: RuntimeContext, ...args: Array<SqlValue>): AsyncIterable<Row> {
		// Use the captured function schema instead of doing a fresh lookup
		const capturedFunction = ctx.getCapturedSchemaObject<FunctionSchema>(functionKey);
		if (!capturedFunction) {
			throw new QuereusError(`Function ${functionName}/${numArgs} was not captured during emission`, StatusCode.INTERNAL);
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
			// An integrated function takes the database as its first parameter.
			const result = capturedFunction.isIntegrated
				? (capturedFunction.implementation as IntegratedTableValuedFunc)(innerCtx.db, ...args)
				: (capturedFunction.implementation as TableValuedFunc)(...args);

			// Handle both direct AsyncIterable and Promise<AsyncIterable>
			const iterable = result instanceof Promise ? await result : result;

			const slot = createRowSlot(innerCtx, rowDescriptor);
			try {
				for await (const row of iterable) {
					const normalized = normalizeRow(row);
					// After normalization: a cell truncated away never reaches a consumer, so it is not judged.
					if (REPR_STRICT) assertRowConforms(normalized, reprColumnTypes!, reprWhere, reprColumnNames);
					slot.set(normalized);
					yield normalized;
				}
			} finally {
				slot.close();
			}
		} catch (error: unknown) {
			// Preserve cancellation identity — don't re-wrap an abort as a generic TVF error.
			// A representation violation is likewise rethrown verbatim: re-wrapping it would
			// report it as the function failing and bury the column/type detail in its message.
			if (error instanceof AbortError || error instanceof RepresentationError) throw error;
			const message = error instanceof Error ? error.message : String(error);
			throw new QuereusError(`Table-valued function ${functionName} failed: ${message}`, StatusCode.ERROR, error instanceof Error ? error : undefined);
		}
	}

	const operandExprs = plan.operands.map(operand => emitPlanNode(operand, ctx));

	return createValidatedInstruction(
		[...operandExprs],
		asRun(run),
		ctx,
		`TVF:${plan.functionName}(${plan.operands.length})`
	);
}
