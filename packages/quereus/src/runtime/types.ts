import type { RuntimeValue, SqlValue, OutputValue, Row } from "../common/types.js";
import type { Database } from "../core/database.js";
import type { Statement } from "../core/statement.js";
import type { RowDescriptor, TableDescriptor, TableGetter } from "../planner/nodes/plan-node.js";
import type { Scheduler } from "./scheduler.js";
import type { EmissionContext } from "./emission-context.js";
import type { VirtualTableConnection } from "../vtab/connection.js";
import type { PlanNode } from '../planner/nodes/plan-node.js';
import type { RowContextMap } from './context-helpers.js';

// Re-export types from common/types.js for convenience
export type { OutputValue };

export type RuntimeContext = {
	db: Database;
	stmt: Statement | undefined; // Undefined for transient exec statements
	params: Record<number | string, SqlValue>; // Bound args — always a plain object at runtime
	/** Row contexts with O(1) attribute index */
	context: RowContextMap;
	/** Table contexts by table name, used for recursive CTEs or other temporary table situations */
	tableContexts: Map<TableDescriptor, TableGetter>;
	/** Debug tracer for instruction execution, if enabled */
	tracer?: InstructionTracer;
	/** Active connection for the current transaction context */
	activeConnection?: VirtualTableConnection;
	/** Whether to collect runtime execution metrics */
	enableMetrics: boolean;
	/**
	 * Cooperative cancellation signal for the current statement, if the caller
	 * supplied one via `exec`/`eval` options. Honored at row and statement
	 * boundaries (notably the table-scan leaf) so a long-running query can be
	 * interrupted — e.g. on a request timeout. Undefined when no signal was given.
	 */
	signal?: AbortSignal;
	/**
	 * The 1-based ordinal of the row currently being produced within the active
	 * INSERT / mutation-context evaluation, or undefined outside one. Exposed to
	 * the `mutation_ordinal()` builtin so a column `default` can author a per-row
	 * surrogate (the shared-key-via-default case — docs/view-updateability.md
	 * § Mutation Context). Set per row by the INSERT DML executor and by the
	 * shared-surrogate envelope (`runtime/emit/view-mutation.ts`), and saved/
	 * restored around each scope so it never leaks past the statement.
	 */
	mutationOrdinal?: number;
	/** Context tracking for debugging context leaks */
	contextTracker?: ContextTracker;
	/** Stack of currently executing plan nodes (only when tracing enabled) */
	planStack?: PlanNode[];
};

export type InstructionRun = (ctx: RuntimeContext, ...args: RuntimeValue[]) => OutputValue;

export type Instruction = {
	params: Instruction[];
	run: InstructionRun;
	/** Optional human-readable note about what this instruction does */
	note?: string;
	/** Optional sub-programs used to execute this instruction - this is here for tracing purposes */
	programs?: Scheduler[];
	/** Optional emission context for schema validation */
	emissionContext?: EmissionContext;
	/** Optional runtime statistics collected during execution */
	runtimeStats?: InstructionRuntimeStats;
};

/**
 * Adapts an emitter's precisely-typed `run` (e.g.
 * `(ctx, v1: SqlValue, v2: SqlValue) => SqlValue`) to the general
 * {@link InstructionRun} that the scheduler drives every instruction through.
 *
 * A specific `run` is *not* structurally assignable to `InstructionRun`. The
 * scheduler holds instructions generically and calls `run(ctx, ...args)` with
 * every arg widened to `RuntimeValue`, so a function that declares narrower
 * params (`SqlValue`, `AsyncIterable<Row>`, a fixed arity, an optional callback)
 * is rejected by parameter contravariance under `strictFunctionTypes` — exactly
 * as it would be if a caller passed more, fewer, or differently-typed args. Each
 * emitter therefore has to assert the conversion. This helper is the single
 * audited home for that assertion: emit sites write `run: asRun(run)` and the
 * only `as`-to-`InstructionRun` in the runtime lives here.
 *
 * The parameter is deliberately loose — first arg is the runtime context, the
 * rest and the return are unconstrained — because the ~80 `run` functions span
 * every arity and return shape (`SqlValue`, `AsyncIterable<Row>`,
 * `Promise<RuntimeValue>`, void-ish DDL). `never[]` accepts any argument list
 * without widening to `any`; the body performs the one unchecked cast.
 */
export function asRun(run: (ctx: RuntimeContext, ...args: never[]) => unknown): InstructionRun {
	return run as unknown as InstructionRun;
}

/**
 * Runtime statistics for instruction execution
 */
export interface InstructionRuntimeStats {
	/** Number of input values/rows processed */
	in: number;
	/** Number of output values/rows produced */
	out: number;
	/** Total execution time in nanoseconds */
	elapsedNs: bigint;
	/** Number of times this instruction was executed */
	executions: number;
}

/** * Trace event for instruction execution. */
export interface InstructionTraceEvent {
	instructionIndex: number;
	note?: string;
	type: 'input' | 'output' | 'row' | 'error';
	timestamp: number;
	args?: RuntimeValue[];
	result?: OutputValue;
	error?: string;
	/** Information about sub-programs if this instruction has any */
	subPrograms?: SubProgramInfo[];
	/** Row index within the async iterable (for 'row' type events) */
	rowIndex?: number;
	/** Row data (for 'row' type events) */
	row?: Row;
}

/** Information about a sub-program for tracing purposes */
export interface SubProgramInfo {
	programIndex: number;
	instructionCount: number;
	rootNote?: string;
}

/** * Interface for tracing instruction execution. */
export interface InstructionTracer {
	/** Called before an instruction executes */
	traceInput(instructionIndex: number, instruction: Instruction, args: RuntimeValue[]): void;
	/** Called after an instruction executes */
	traceOutput(instructionIndex: number, instruction: Instruction, result: OutputValue): void;
	/** Called when an instruction throws an error */
	traceError(instructionIndex: number, instruction: Instruction, error: Error): void;
	/** Called for each row emitted by an async iterable instruction */
	traceRow(instructionIndex: number, instruction: Instruction, rowIndex: number, row: Row): void;
	/** Gets collected trace events (if supported by the tracer) */
	getTraceEvents?(): InstructionTraceEvent[];
	/** Gets information about all sub-programs encountered during tracing */
	getSubPrograms?(): Map<number, { scheduler: Scheduler; parentInstructionIndex: number }>;
}

/** * Tracer that collects execution events for later analysis. */
export class CollectingInstructionTracer implements InstructionTracer {
	private events: InstructionTraceEvent[] = [];
	private subPrograms = new Map<number, { scheduler: Scheduler; parentInstructionIndex: number }>();
	private nextSubProgramId = 0;

	traceInput(instructionIndex: number, instruction: Instruction, args: RuntimeValue[]): void {
		const subPrograms = this.collectSubProgramInfo(instructionIndex, instruction);

		this.events.push({
			instructionIndex,
			note: instruction.note,
			type: 'input',
			timestamp: Date.now(),
			args: this.cloneArgs(args),
			subPrograms
		});
	}

	traceOutput(instructionIndex: number, instruction: Instruction, result: OutputValue): void {
		this.events.push({
			instructionIndex,
			note: instruction.note,
			type: 'output',
			timestamp: Date.now(),
			result: this.cloneResult(result)
		});
	}

	traceError(instructionIndex: number, instruction: Instruction, error: Error): void {
		this.events.push({
			instructionIndex,
			note: instruction.note,
			type: 'error',
			timestamp: Date.now(),
			error: error.message
		});
	}

	traceRow(instructionIndex: number, instruction: Instruction, rowIndex: number, row: Row): void {
		this.events.push({
			instructionIndex,
			note: instruction.note,
			type: 'row',
			timestamp: Date.now(),
			rowIndex,
			row
		});
	}

	getTraceEvents(): InstructionTraceEvent[] {
		return [...this.events];
	}

	getSubPrograms(): Map<number, { scheduler: Scheduler; parentInstructionIndex: number }> {
		return new Map(this.subPrograms);
	}

	clear(): void {
		this.events = [];
		this.subPrograms.clear();
		this.nextSubProgramId = 0;
	}

	private collectSubProgramInfo(instructionIndex: number, instruction: Instruction): SubProgramInfo[] | undefined {
		if (!instruction.programs || instruction.programs.length === 0) {
			return undefined;
		}

		return instruction.programs.map(scheduler => {
			const programId = this.nextSubProgramId++;
			this.subPrograms.set(programId, { scheduler, parentInstructionIndex: instructionIndex });

			return {
				programIndex: programId,
				instructionCount: scheduler.instructions.length,
				rootNote: scheduler.instructions[scheduler.instructions.length - 1]?.note
			};
		});
	}

	private cloneArgs(args: RuntimeValue[]): RuntimeValue[] {
		return args.map(arg => this.cloneValue(arg));
	}

	private cloneResult(result: OutputValue): OutputValue {
		if (result instanceof Promise) {
			return result.then(resolved => this.cloneValue(resolved as RuntimeValue));
		}
		return this.cloneValue(result as RuntimeValue);
	}

	private cloneValue(value: RuntimeValue): RuntimeValue {
		if (value === null || value === undefined) return value;
		if (typeof value === 'function') return '[Function]';
		if (typeof value === 'object' && value && Symbol.asyncIterator in value) return '[AsyncIterable]';
		if (Array.isArray(value)) return value.map(v => this.cloneValue(v as RuntimeValue)) as RuntimeValue;
		if (typeof value === 'object') return '[Object]';
		return value as RuntimeValue;
	}
}

/**
 * Tracks context additions and removals for debugging context leaks
 */
export interface ContextTracker {
	/** Record that a context was added */
	addContext(descriptor: RowDescriptor, source: string): void;
	/** Record that a context was removed */
	removeContext(descriptor: RowDescriptor): void;
	/** Get all remaining contexts with their sources */
	getRemainingContexts(): Array<{ descriptor: RowDescriptor; source: string }>;
	/** Check if there are any remaining contexts */
	hasRemainingContexts(): boolean;
}

/**
 * Default implementation of ContextTracker
 */
export class DefaultContextTracker implements ContextTracker {
	private contexts = new Map<RowDescriptor, string>();

	addContext(descriptor: RowDescriptor, source: string): void {
		this.contexts.set(descriptor, source);
	}

	removeContext(descriptor: RowDescriptor): void {
		this.contexts.delete(descriptor);
	}

	getRemainingContexts(): Array<{ descriptor: RowDescriptor; source: string }> {
		return Array.from(this.contexts.entries()).map(([descriptor, source]) => ({
			descriptor,
			source
		}));
	}

	hasRemainingContexts(): boolean {
		return this.contexts.size > 0;
	}
}
