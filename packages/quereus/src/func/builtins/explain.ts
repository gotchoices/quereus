import type { Row } from "../../common/types.js";
import type { SqlValue } from "../../common/types.js";
import { createIntegratedTableValuedFunction } from "../registration.js";
import { INTEGER_TYPE, REAL_TYPE, TEXT_TYPE } from "../../types/builtin-types.js";
import { QuereusError } from "../../common/errors.js";
import { StatusCode } from "../../common/types.js";
import type { Database } from "../../core/database.js";
import { safeJsonStringify } from "../../util/serialization.js";
import { CollectingInstructionTracer, type Instruction, InstructionTraceEvent } from "../../runtime/types.js";
import { PlanNode, RelationalPlanNode } from "../../planner/nodes/plan-node.js";
import { EmissionContext } from "../../runtime/emission-context.js";
import { emitPlanNode } from "../../runtime/emitters.js";
import { Scheduler } from "../../runtime/scheduler.js";
import { analyzeRowSpecific } from "../../planner/analysis/constraint-extractor.js";
import { Parser } from "../../parser/parser.js";
import * as AST from "../../parser/ast.js";
import { GlobalScope } from "../../planner/scopes/global.js";
import { ParameterScope } from "../../planner/scopes/param.js";
import type { PlanningContext } from "../../planner/planning-context.js";
import { BuildTimeDependencyTracker } from "../../planner/planning-context.js";
import { buildBlock } from "../../planner/building/block.js";

interface NamedSchemaLike {
	name: string;
	schemaName?: string;
}

// Helper function to safely get function name from nodes that have it
function getFunctionName(node: PlanNode): string | null {
	const candidate = (node as { functionName?: unknown }).functionName;
	if (typeof candidate === 'string') {
		return candidate;
	}
	return null;
}

// Helper function to safely get alias from nodes that have it
function getAlias(node: PlanNode): string | null {
	const candidate = (node as { alias?: unknown }).alias;
	if (typeof candidate === 'string') {
		return candidate;
	}
	return null;
}

// Helper function to safely get table name or related identifier
function getObjectName(node: PlanNode): string | null {
	// Check for function name first (table functions, scalar functions, etc.)
	const functionName = getFunctionName(node);
	if (functionName) {
		return functionName;
	}

	// Check for table schema in table reference nodes
	const tableSchema = (node as { tableSchema?: NamedSchemaLike }).tableSchema;
	if (tableSchema && typeof tableSchema.name === 'string') {
		return tableSchema.schemaName ? `${tableSchema.schemaName}.${tableSchema.name}` : tableSchema.name;
	}

	// Check for CTE name
	const cteName = (node as { cteName?: unknown }).cteName;
	if (typeof cteName === 'string') {
		return cteName;
	}

	// Check for view schema in view reference nodes
	const viewSchema = (node as { viewSchema?: NamedSchemaLike }).viewSchema;
	if (viewSchema && typeof viewSchema.name === 'string') {
		return viewSchema.schemaName ? `${viewSchema.schemaName}.${viewSchema.name}` : viewSchema.name;
	}

	return null;
}

// Query plan explanation function (table-valued function)
export const queryPlanFunc = createIntegratedTableValuedFunction(
	{
		name: 'query_plan',
		numArgs: 1,
		deterministic: true,
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'id', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'parent_id', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'subquery_level', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'node_type', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'op', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'detail', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'object_name', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'alias', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'properties', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'physical', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'est_cost', type: { typeClass: 'scalar', logicalType: REAL_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'est_rows', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: true, isReadOnly: true }, generated: true }
			],
			keys: [],
			rowConstraints: []
		}
	},
	async function* (db: Database, sql: SqlValue): AsyncIterable<Row> {
		if (typeof sql !== 'string') {
			throw new QuereusError('query_plan() requires a SQL string argument', StatusCode.ERROR);
		}

		try {
			// Parse and plan the SQL to get the actual plan tree
			const plan = db.getPlan(sql);

			// Traverse the plan tree and yield information about each node
			let nodeId = 1;
			const nodeStack: Array<{ node: PlanNode; parentId: number | null; level: number }> = [
				{ node: plan, parentId: null, level: 0 }
			];

			while (nodeStack.length > 0) {
				const { node, parentId, level } = nodeStack.pop()!;
				const currentId = nodeId++;

				// Get node type
				const nodeType = node.nodeType || 'UNKNOWN';

				// Determine operation type and details
				let op = 'UNKNOWN';
				let detail = 'Unknown operation';
				let objectName: string | null = null;
				let alias: string | null = null;
				const estCost = node.estimatedCost || 1.0;
				const estRows = (node as RelationalPlanNode).estimatedRows || 10;

				// Use node's toString() method for detail if available
				if (typeof node.toString === 'function') {
					detail = node.toString();
				}

				if (node.nodeType) {
					op = node.nodeType.replace(/Node$/, '').toUpperCase();

					// Extract object name and alias using helper functions
					objectName = getObjectName(node);
					alias = getAlias(node);
				}

				// Get logical properties using the correct method name
				let properties: string | null = null;
				const logicalAttributes = node.getLogicalAttributes();
				if (logicalAttributes && Object.keys(logicalAttributes).length > 0) {
					// Attach minimal QuickPick diagnostics from optimizer if available
					const diag = db.optimizer.getLastDiagnostics?.();
					if (diag?.quickpick) {
						(logicalAttributes as Record<string, unknown>).quickpick = diag.quickpick;
					}
					properties = safeJsonStringify(logicalAttributes);
				}

				// Get physical properties (if available)
				let physical: string | null = null;
				if (node.physical) {
					physical = safeJsonStringify(node.physical);
				}

				yield [
					currentId,           // id
					parentId,           // parent_id
					level,              // subquery_level
					nodeType,           // node_type
					op,                 // op
					detail,             // detail
					objectName,         // object_name
					alias,              // alias
					properties,         // properties
					physical,           // physical
					estCost,            // est_cost
					estRows             // est_rows
				];

				// Add children to stack (in reverse order so they're processed in correct order)
				// getChildren() is guaranteed to exist on all PlanNode instances
				const children = node.getChildren();
				for (let i = children.length - 1; i >= 0; i--) {
					nodeStack.push({ node: children[i], parentId: currentId, level });
				}
			}
		} catch (error: unknown) {
			// If planning fails, yield an error row
			const message = error instanceof Error ? error.message : String(error);
			yield [1, null, 0, 'ERROR', 'ERROR', `Failed to plan SQL: ${message}`, null, null, null, null, null, null];
		}
	}
);

// Scheduler program explanation function (table-valued function)
export const schedulerProgramFunc = createIntegratedTableValuedFunction(
	{
		name: 'scheduler_program',
		numArgs: 1,
		deterministic: true,
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'addr', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'dependencies', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true }, // JSON array of dependency IDs
				{ name: 'description', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'estimated_cost', type: { typeClass: 'scalar', logicalType: REAL_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'is_subprogram', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true }, // 0/1 boolean
				{ name: 'parent_addr', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: true, isReadOnly: true }, generated: true }
			],
			keys: [],
			rowConstraints: []
		}
	},
	async function* (db: Database, sql: SqlValue): AsyncIterable<Row> {
		if (typeof sql !== 'string') {
			throw new QuereusError('scheduler_program() requires a SQL string argument', StatusCode.ERROR);
		}

		try {
			// Parse and plan the SQL to get the actual plan tree
			const plan = db.getPlan(sql);

			// Emit the plan to get the instruction tree
			const emissionContext = new EmissionContext(db);
			const rootInstruction = emitPlanNode(plan, emissionContext);

			// Create a scheduler to get the instruction sequence
			const scheduler = new Scheduler(rootInstruction);
			const indexByInstruction = new Map<Instruction, number>();
			for (let i = 0; i < scheduler.instructions.length; i++) {
				indexByInstruction.set(scheduler.instructions[i], i);
			}

			// Yield information about each instruction
			for (let i = 0; i < scheduler.instructions.length; i++) {
				const instruction = scheduler.instructions[i];
				const dependencies = instruction.params
					.map(inst => indexByInstruction.get(inst))
					.filter((idx): idx is number => idx !== undefined);

				yield [
					i, // addr
					JSON.stringify(dependencies), // dependencies
					instruction.note || `INSTRUCTION_${i}`, // instruction_id
					null, // estimated_cost (not available in current implementation)
					0, // is_subprogram (main program)
					null // parent_addr (main program)
				];

				// If this instruction has sub-programs, yield those too
				if (instruction.programs) {
					for (let progIdx = 0; progIdx < instruction.programs.length; progIdx++) {
						const subProgram = instruction.programs[progIdx];
						const subIndexByInstruction = new Map<Instruction, number>();
						for (let subI = 0; subI < subProgram.instructions.length; subI++) {
							subIndexByInstruction.set(subProgram.instructions[subI], subI);
						}
						for (let subI = 0; subI < subProgram.instructions.length; subI++) {
							const subInstruction = subProgram.instructions[subI];
							const subDependencies = subInstruction.params
								.map(inst => subIndexByInstruction.get(inst))
								.filter((idx): idx is number => idx !== undefined);

							yield [
								scheduler.instructions.length + progIdx * 1000 + subI, // addr (offset for sub-programs)
								JSON.stringify(subDependencies), // dependencies
								subInstruction.note || `SUB_INSTRUCTION_${progIdx}_${subI}`, // instruction_id
								null, // estimated_cost
								1, // is_subprogram
								i // parent_addr
							];
						}
					}
				}
			}
		} catch (error: unknown) {
			// If compilation fails, yield an error instruction
			const message = error instanceof Error ? error.message : String(error);
			yield [0, '[]', `Failed to compile SQL: ${message}`, null, 0, null];
		}
	}
);

// Stack trace function for debugging execution
export const stackTraceFunc = createIntegratedTableValuedFunction(
	{
		name: 'stack_trace',
		numArgs: 1,
		deterministic: true,
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'frame_id', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'depth', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'location', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'plan_node_type', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'operation', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'table_or_function', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'is_virtual', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true } // 0/1 boolean
			],
			keys: [],
			rowConstraints: []
		}
	},
	async function* (db: Database, sql: SqlValue): AsyncIterable<Row> {
		if (typeof sql !== 'string') {
			throw new QuereusError('stack_trace() requires a SQL string argument', StatusCode.ERROR);
		}

		try {
			// Parse and plan the SQL to capture the call stack
			const plan = db.getPlan(sql);

			// Simulate a call stack based on the plan structure
			let frameId = 0;
			const stack: Array<{ name: string; location: string; vars: Record<string, unknown> }> = [];

			// Add main execution frame
			stack.push({
				name: 'main',
				location: 'database.ts:exec',
				vars: { sql, autocommit: db.getAutocommit() }
			});

			// Add planning frames
			stack.push({
				name: 'buildPlan',
				location: 'database.ts:_buildPlan',
				vars: { planType: plan.nodeType }
			});

			// Add frames based on plan node types
			const addPlanFrames = (node: PlanNode, depth: number = 0) => {
				if (!node || depth > 10) return; // Prevent infinite recursion

				switch (node.nodeType) {
					case 'Block': {
						const statements = (node as { statements?: ReadonlyArray<unknown> }).statements;
						stack.push({
							name: 'buildBlock',
							location: 'building/block.ts:buildBlock',
							vars: { statementCount: statements?.length ?? 0 }
						});
						break;
					}
					case 'Filter': {
						const condition = (node as { condition?: { toString(): string } }).condition;
						stack.push({
							name: 'buildFilter',
							location: 'building/select.ts:buildSelectStmt',
							vars: { condition: condition?.toString() ?? 'unknown' }
						});
						break;
					}
					case 'Project': {
						const projections = (node as { projections?: ReadonlyArray<unknown> }).projections;
						stack.push({
							name: 'buildProject',
							location: 'building/select.ts:buildSelectStmt',
							vars: { projectionCount: projections?.length ?? 0 }
						});
						break;
					}
				}

				// Recursively add frames for children
				// getChildren() is guaranteed to exist on all PlanNode instances
				const children = node.getChildren();
				children.forEach((child: PlanNode) => addPlanFrames(child, depth + 1));
			};

			addPlanFrames(plan);

			// Yield stack frames (reverse order - deepest first)
			for (let i = stack.length - 1; i >= 0; i--) {
				const frame = stack[i];
				yield [
					frameId++,                    // frame_id
					i,                           // depth
					frame.location,              // location
					frame.name,                   // plan_node_type
					frame.name,                   // operation
					null,                        // table_or_function
					0                            // is_virtual
				];
			}
		} catch (error: unknown) {
			// If analysis fails, yield an error frame
			const message = error instanceof Error ? error.message : String(error);
			yield [0, 0, 'error', 'stack_trace', `Failed to analyze: ${message}`, null, 0];
		}
	}
);

// Execution trace function for performance analysis
export const executionTraceFunc = createIntegratedTableValuedFunction(
	{
		name: 'execution_trace',
		numArgs: 1,
		deterministic: false, // Execution traces are not deterministic
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'instruction_index', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'operation', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'dependencies', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true }, // JSON array of instruction indices this depends on
				{ name: 'input_values', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true }, // JSON
				{ name: 'output_value', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true }, // JSON
				{ name: 'duration_ms', type: { typeClass: 'scalar', logicalType: REAL_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'sub_programs', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true }, // JSON
				{ name: 'error_message', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'timestamp_ms', type: { typeClass: 'scalar', logicalType: REAL_TYPE, nullable: false, isReadOnly: true }, generated: true }
			],
			keys: [],
			rowConstraints: []
		}
	},
	async function* (db: Database, sql: SqlValue): AsyncIterable<Row> {
		if (typeof sql !== 'string') {
			throw new QuereusError('execution_trace() requires a SQL string argument', StatusCode.ERROR);
		}

		try {
			// First, get the scheduler program to understand instruction dependencies
			const instructionDependencies = new Map<number, number[]>();
			const instructionOperations = new Map<number, string>();

			try {
				// Get scheduler program information
				for await (const row of db.eval('SELECT * FROM scheduler_program(?)', [sql])) {
					const addr = row.addr as number;
					const dependencies = JSON.parse((row.dependencies as string) || '[]') as number[];
					const description = row.description as string;

					instructionDependencies.set(addr, dependencies);
					instructionOperations.set(addr, description);
				}
			} catch (schedulerError: unknown) {
				const message = schedulerError instanceof Error ? schedulerError.message : String(schedulerError);
				console.warn('Could not get scheduler program info:', message);
			}

			// Import the CollectingInstructionTracer
			const tracer = new CollectingInstructionTracer();

			// Parse the query and execute with tracing
			let stmt: ReturnType<Database['prepare']> | undefined;
			try {
				stmt = db.prepare(sql);

				// Execute the query with tracing to collect actual instruction events
				const results: Row[] = [];
				for await (const row of stmt.iterateRowsWithTrace(undefined, tracer)) {
					results.push(row); // We don't yield the results, just the trace events
				}

				await stmt.finalize();
			} catch (executionError: unknown) {
				// If execution fails, we might still have some trace events
				console.warn('Query execution failed during tracing:', executionError instanceof Error ? executionError.message : String(executionError));
			}

			// Get the collected trace events
			const traceEvents = tracer.getTraceEvents();

			// Group events by instruction index and consolidate into single rows
			const eventsByInstruction = new Map<number, InstructionTraceEvent[]>();
			for (const event of traceEvents) {
				const instructionIndex = event.instructionIndex;
				if (!eventsByInstruction.has(instructionIndex)) {
					eventsByInstruction.set(instructionIndex, []);
				}
				eventsByInstruction.get(instructionIndex)!.push(event);
			}

			// Get sub-program information for enhanced context
			const subPrograms = tracer.getSubPrograms ? tracer.getSubPrograms() : new Map();

			// Create one row per instruction execution
			for (const [instructionIndex, events] of eventsByInstruction.entries()) {
				const inputEvent = events.find(e => e.type === 'input');
				const outputEvent = events.find(e => e.type === 'output');
				const errorEvent = events.find(e => e.type === 'error');

				// Use operation name from scheduler program, fallback to event note
				const operationName = instructionOperations.get(instructionIndex) || inputEvent?.note || 'Unknown';
				const dependencies = instructionDependencies.get(instructionIndex) || [];

				// Calculate duration between input and output
				let duration: number | null = null;
				if (inputEvent && outputEvent) {
					duration = outputEvent.timestamp - inputEvent.timestamp;
				}

				// Build enhanced sub-program information
				let subProgramsInfo: unknown = null;
				if (inputEvent?.subPrograms && inputEvent.subPrograms.length > 0) {
					// Enhance sub-program info with details from the tracer
					subProgramsInfo = inputEvent.subPrograms.map(sp => {
						const subProgramDetail = subPrograms.get(sp.programIndex);
						const baseInfo = {
							programIndex: sp.programIndex,
							instructionCount: sp.instructionCount,
							rootNote: sp.rootNote
						};

						if (subProgramDetail) {
							// Add instruction details from the sub-program
							const instructions = subProgramDetail.scheduler.instructions.map((instr: Instruction, idx: number) => ({
								index: idx,
								operation: instr.note || `instruction_${idx}`,
								dependencies: instr.params.map((_, paramIdx) => paramIdx).filter((paramIdx) => paramIdx < idx)
							}));
							return { ...baseInfo, instructions };
						}

						return baseInfo;
					});
				}

				const timestamp = inputEvent?.timestamp || outputEvent?.timestamp || Date.now();

				yield [
					instructionIndex,                                                          // instruction_index
					operationName,                                                            // operation
					safeJsonStringify(dependencies),                                          // dependencies
					inputEvent?.args ? safeJsonStringify(inputEvent.args) : null,            // input_values
					outputEvent?.result !== undefined ? safeJsonStringify(outputEvent.result) : null, // output_value
					duration,                                                                  // duration_ms
					subProgramsInfo ? safeJsonStringify(subProgramsInfo) : null,             // sub_programs
					errorEvent?.error || null,                                                // error_message
					timestamp                                                                  // timestamp_ms
				];
			}

			// If no trace events were captured, yield a summary row
			if (eventsByInstruction.size === 0) {
				yield [
					0,                    // instruction_index
					'NO_TRACE_DATA',      // operation
					safeJsonStringify([]), // dependencies
					null,                 // input_values
					safeJsonStringify('No instruction-level trace events captured'), // output_value
					null,                 // duration_ms
					null,                 // sub_programs
					null,                 // error_message
					Date.now()            // timestamp_ms
				];
			}

		} catch (error: unknown) {
			// If tracing setup fails, yield an error event
			const message = error instanceof Error ? error.message : String(error);
			yield [
				0,                                                        // instruction_index
				'TRACE_SETUP',                                           // operation
				safeJsonStringify([]),                                    // dependencies
				null,                                                     // input_values
				null,                                                     // output_value
				null,                                                     // duration_ms
				null,                                                     // sub_programs
				`Failed to setup execution trace: ${message}`,           // error_message
				Date.now()                                                // timestamp_ms
			];
		}
	}
);

// Row-level execution trace function for detailed data flow analysis
export const rowTraceFunc = createIntegratedTableValuedFunction(
	{
		name: 'row_trace',
		numArgs: 1,
		deterministic: false, // Row traces are not deterministic
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'instruction_index', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'operation', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'row_index', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'row_data', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true }, // JSON array of row values
				{ name: 'timestamp_ms', type: { typeClass: 'scalar', logicalType: REAL_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'row_count', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: true, isReadOnly: true }, generated: true } // Total rows for this instruction (filled in last row)
			],
			keys: [],
			rowConstraints: []
		}
	},
	async function* (db: Database, sql: SqlValue): AsyncIterable<Row> {
		if (typeof sql !== 'string') {
			throw new QuereusError('row_trace() requires a SQL string argument', StatusCode.ERROR);
		}

		try {
			// Import the CollectingInstructionTracer
			const tracer = new CollectingInstructionTracer();

			// Parse the query and execute with tracing
			let stmt: ReturnType<Database['prepare']> | undefined;
			try {
				stmt = db.prepare(sql);

				// Execute the query with tracing to collect row-level events
				const results: Row[] = [];
				for await (const row of stmt.iterateRowsWithTrace(undefined, tracer)) {
					results.push(row); // We don't yield the results, just the trace events
				}

				await stmt.finalize();
			} catch (executionError: unknown) {
				// If execution fails, we might still have some trace events
				const message = executionError instanceof Error ? executionError.message : String(executionError);
				console.warn('Query execution failed during row tracing:', message);
			}

			// Get the collected trace events and filter for row events
			const traceEvents = tracer.getTraceEvents();
			const rowEvents = traceEvents.filter(event => event.type === 'row');

			// Group row events by instruction index to calculate row counts
			const rowsByInstruction = new Map<number, typeof rowEvents>();
			for (const event of rowEvents) {
				const instructionIndex = event.instructionIndex;
				if (!rowsByInstruction.has(instructionIndex)) {
					rowsByInstruction.set(instructionIndex, []);
				}
				rowsByInstruction.get(instructionIndex)!.push(event);
			}

			// Yield detailed information for each row
			for (const [instructionIndex, instructionRowEvents] of rowsByInstruction.entries()) {
				const totalRows = instructionRowEvents.length;

				for (let i = 0; i < instructionRowEvents.length; i++) {
					const event = instructionRowEvents[i];
					const isLastRow = i === instructionRowEvents.length - 1;

					yield [
						instructionIndex,                                                    // instruction_index
						event.note || 'Unknown',                                           // operation
						event.rowIndex ?? i,                                               // row_index
						safeJsonStringify(event.row),                                      // row_data
						event.timestamp,                                                    // timestamp_ms
						isLastRow ? totalRows : null                                       // row_count (only on last row)
					];
				}
			}

			// If no row events were captured, yield a summary row
			if (rowEvents.length === 0) {
				yield [
					0,                                            // instruction_index
					'NO_ROW_DATA',                               // operation
					0,                                           // row_index
					safeJsonStringify('No row-level trace events captured'), // row_data
					Date.now(),                                  // timestamp_ms
					0                                            // row_count
				];
			}

		} catch (error: unknown) {
			// If tracing setup fails, yield an error event
			yield [
				0,                                                        // instruction_index
				'ROW_TRACE_SETUP',                                       // operation
				0,                                                       // row_index
				safeJsonStringify(`Failed to setup row trace: ${error instanceof Error ? error.message : String(error)}`), // row_data
				Date.now(),                                              // timestamp_ms
				null                                                     // row_count
			];
		}
	}
);

// Schema size function (table-valued function)
export const schemaSizeFunc = createIntegratedTableValuedFunction(
	{
		name: 'schema_size',
		numArgs: 0,
		deterministic: false, // Schema can change
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'object_type', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'object_name', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'estimated_rows', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'estimated_size_kb', type: { typeClass: 'scalar', logicalType: REAL_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'column_count', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'index_count', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true }
			],
			keys: [],
			rowConstraints: []
		}
	},
	async function* (_db: Database, _sql: SqlValue): AsyncIterable<Row> {
		// TODO: Implementation of schemaSizeFunc
	}
);

// Explain assertion analysis and prepared parameterization (pre-physical)
export const explainAssertionFunc = createIntegratedTableValuedFunction(
	{
		name: 'explain_assertion',
		numArgs: 1,
		deterministic: true,
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'assertion', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'relation_key', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'base', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'classification', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'prepared_pk_params', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true }, // JSON array of param names or NULL
				{ name: 'violation_sql', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true }
			],
			keys: [],
			rowConstraints: []
		}
	},
	async function* (db: Database, assertionName: SqlValue): AsyncIterable<Row> {
		if (typeof assertionName !== 'string') {
			throw new QuereusError('explain_assertion(name) requires an assertion name', StatusCode.ERROR);
		}

		// Find assertion across all schemas
		const all = db.schemaManager.getAllAssertions();
		const assertion = all.find(a => a.name.toLowerCase() === assertionName.toLowerCase());
		if (!assertion) {
			throw new QuereusError(`Assertion not found: ${assertionName}`, StatusCode.NOTFOUND);
		}

		const sql = assertion.violationSql;

		// Build pre-physical plan for analysis
		let ast: AST.Statement;
		try {
			const parser = new Parser();
			ast = parser.parse(sql) as AST.Statement;
		} catch (e) {
			throw new QuereusError(`Failed to parse assertion SQL: ${(e as Error).message}`, StatusCode.ERROR, e as Error);
		}

		const globalScope = new GlobalScope(db.schemaManager);
		const parameterScope = new ParameterScope(globalScope);
		const ctx: PlanningContext = {
			db,
			schemaManager: db.schemaManager,
			parameters: {},
			scope: parameterScope,
			cteNodes: new Map(),
			schemaDependencies: new BuildTimeDependencyTracker(),
			schemaCache: new Map(),
			cteReferenceCache: new Map(),
			outputScopes: new Map()
		};

		const plan = buildBlock(ctx, [ast]);
		const analyzed = db.optimizer.optimizeForAnalysis(plan, db) as unknown as RelationalPlanNode;

		// Classify row/global per relationKey
		const classifications = analyzeRowSpecific(analyzed);

		for (const [relationKey, cls] of classifications) {
			const base = `${relationKey.split('#')[0]}`;
			let prepared: string | null = null;
			if (cls === 'row' && base) {
				// Prepared parameters are PK-based: ["pk0", "pk1", ...]
				const [schemaName, tableName] = base.split('.');
				const table = db._findTable(tableName, schemaName);
				if (table) {
					const pkCount = table.primaryKeyDefinition.length;
					const names = Array.from({ length: pkCount }, (_, i) => `pk${i}`);
					prepared = JSON.stringify(names);
				}
			}

			yield [
				assertion.name,
				relationKey,
				base,
				cls,
				prepared,
				sql
			];
		}
	}
);
