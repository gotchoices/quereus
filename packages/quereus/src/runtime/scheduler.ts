import type { Instruction, RuntimeContext, InstructionRuntimeStats } from "./types.js";
import type { OutputValue, RuntimeValue, Row } from "../common/types.js";
import { isAsyncIterable } from "./utils.js";
import { hrtimeNs } from "../util/hrtime.js";
import { createLogger } from "../common/logger.js";
import { DefaultContextTracker } from './types.js';

const log = createLogger('runtime:metrics');
const contextLog = createLogger('runtime:context');

type ResultDestination = number | null;

/** Symbol to mark wrapped iterables to prevent double-wrapping */
const TRACED_ITERABLE_SYMBOL = Symbol('tracedIterable');

/**
 * Wraps an async iterable to emit row-level trace events
 */
function wrapIterableForTracing<T>(
	src: AsyncIterable<T>,
	ctx: RuntimeContext,
	instructionIndex: number,
	instruction: Instruction
): AsyncIterable<T> {
	// Prevent double-wrapping
	if ((src as unknown as Record<symbol, boolean>)[TRACED_ITERABLE_SYMBOL]) {
		return src;
	}

	const tracer = ctx.tracer!;
	const wrapped = (async function* () {
		let rowIndex = 0;
		for await (const row of src) {
			// Only emit row trace events for valid rows (non-empty arrays)
			if (Array.isArray(row) && row.length > 0) {
				tracer.traceRow(instructionIndex, instruction, rowIndex++, row as Row);
			}
			yield row;
		}
	})();

	// Mark as already wrapped
	(wrapped as unknown as Record<symbol, boolean>)[TRACED_ITERABLE_SYMBOL] = true;
	return wrapped;
}

export class Scheduler {
	readonly instructions: Instruction[] = [];
	/** Index of the instruction that consumes the output of each instruction. */
	readonly destinations: ResultDestination[];

	constructor(root: Instruction) {
		const argIndexes: number[][] = [];

		const buildPlan = (inst: Instruction): number => {
			const instArgIndexes = inst.params.map(p => buildPlan(p));
			const currentIndex = this.instructions.push(inst) - 1;
			argIndexes[currentIndex] = instArgIndexes;
			return currentIndex;
		};

		buildPlan(root);

		this.destinations = new Array<ResultDestination>(this.instructions.length).fill(null);

		for (let instIndex = 0; instIndex < this.instructions.length; ++instIndex) {
			const instArgIndexes = argIndexes[instIndex];
			if (instArgIndexes) {
				for (let argIndex = 0; argIndex < instArgIndexes.length; ++argIndex) {
					this.destinations[instArgIndexes[argIndex]] = instIndex;
				}
			}
		}
	}

	run(ctx: RuntimeContext): OutputValue {
		// Initialize context tracker if not already present
		if (!ctx.contextTracker) {
			ctx.contextTracker = new DefaultContextTracker();
		}

		let result: OutputValue;

		if (ctx.enableMetrics) {
			result = this.runWithMetrics(ctx);
		} else if (!ctx.tracer) {
			result = this.runOptimized(ctx);
		} else {
			result = this.runWithTracing(ctx);
		}

		// Check for remaining contexts and warn rather than error
		if (ctx.context.size > 0 || ctx.tableContexts.size > 0) {
			contextLog('Context leak detected - remaining row contexts: %d, table contexts: %d', ctx.context.size, ctx.tableContexts.size);
		}

		if (ctx.contextTracker && ctx.contextTracker.hasRemainingContexts()) {
			const remaining = ctx.contextTracker.getRemainingContexts();
			contextLog('Context tracker recorded remaining contexts: %O', remaining.map(c => c.source));
		}

		return result;
	}

	private runOptimized(ctx: RuntimeContext): OutputValue {
		// Argument lists for each instruction.
		const instrArgs = new Array(this.instructions.length).fill(null).map(() => [] as OutputValue[] | undefined);
		// Running output
		let output: OutputValue | undefined;

		// Run synchronously until we hit a promise
		for (let i = 0; i < this.instructions.length; ++i) {
			const args = instrArgs[i]!;	// Guaranteed not to contain promises
			instrArgs[i] = undefined; // Clear args as we go to minimize memory usage.

			output = this.instructions[i].run(ctx, ...(args as RuntimeValue[]));

			// If the instruction returned a promise, switch to async mode for rest of instructions
			if (output instanceof Promise) {
				return this.runAsync(ctx, instrArgs, i, output);
			}

			// Store synchronous output
			const destination = this.destinations[i];
			if (destination !== null) {
				instrArgs[destination]!.push(output);
			}
		}

		return output as OutputValue;
	}

	private async runAsync(
		ctx: RuntimeContext,
		instrArgs: (OutputValue[] | undefined)[],
		startIndex: number,
		pendingOutput: OutputValue
	): Promise<RuntimeValue> {
		// Instruction indexes that have promise arguments
		const hasPromise: boolean[] = [];

		let output: OutputValue | undefined = pendingOutput;

		// Store the output from the transition instruction
		const transitionDestination = this.destinations[startIndex];
		if (transitionDestination !== null) {
			instrArgs[transitionDestination]!.push(output);
			hasPromise[transitionDestination] = true;
		}

		// Continue with remaining instructions asynchronously
		for (let i = startIndex + 1; i < this.instructions.length; ++i) {
			let args = instrArgs[i]!;
			instrArgs[i] = undefined;

			// Resolve any promise arguments
			if (hasPromise[i]) {
				args = await Promise.all(args);
			}

			// Run the instruction
			output = this.instructions[i].run(ctx, ...(args as RuntimeValue[]));

			// Store the output
			const destination = this.destinations[i];
			if (destination !== null) {
				instrArgs[destination]!.push(output);
				if (output instanceof Promise) {
					hasPromise[destination] = true;
				}
			}
		}

		return output as OutputValue;
	}

	private runWithTracing(ctx: RuntimeContext): OutputValue {
		// Argument lists for each instruction.
		const instrArgs = new Array(this.instructions.length).fill(null).map(() => [] as OutputValue[] | undefined);
		// Running output
		let output: OutputValue | undefined;

		// Run synchronously until we hit a promise
		for (let i = 0; i < this.instructions.length; ++i) {
			const instruction = this.instructions[i];
			const args = instrArgs[i]!;	// Guaranteed not to contain promises
			instrArgs[i] = undefined; // Clear args as we go to minimize memory usage.

			// Trace input
			ctx.tracer!.traceInput(i, instruction, args as RuntimeValue[]);

			try {
				output = instruction.run(ctx, ...(args as RuntimeValue[]));

				// If the instruction returned a promise, switch to async mode for rest of instructions
				if (output instanceof Promise) {
					return this.runAsyncWithTracing(ctx, instrArgs, i, output);
				}

				// Wrap async iterables for row-level tracing
				if (isAsyncIterable(output)) {
					output = wrapIterableForTracing(output, ctx, i, instruction);
				}

				// Trace output - handle promises properly
				ctx.tracer!.traceOutput(i, instruction, output);

				// Keep the original output (promise or value) for flow control
			} catch (error) {
				// Trace error
				ctx.tracer!.traceError(i, instruction, error as Error);
				throw error; // Re-throw the error
			}

			// Store synchronous output
			const destination = this.destinations[i];
			if (destination !== null) {
				instrArgs[destination]!.push(output);
			}
		}

		return output as OutputValue;
	}

	private async runAsyncWithTracing(
		ctx: RuntimeContext,
		instrArgs: (OutputValue[] | undefined)[],
		startIndex: number,
		pendingOutput: OutputValue
	): Promise<RuntimeValue> {
		// Handle the initial pending output
		let resolvedPendingOutput = await pendingOutput;
		if (isAsyncIterable(resolvedPendingOutput)) {
			resolvedPendingOutput = wrapIterableForTracing(resolvedPendingOutput, ctx, startIndex, this.instructions[startIndex]);
		}
		ctx.tracer!.traceOutput(startIndex, this.instructions[startIndex], resolvedPendingOutput);

		// Instruction indexes that have promise arguments
		const hasPromise: boolean[] = [];

		let output: OutputValue | undefined = resolvedPendingOutput;

		// Store the output from the transition instruction
		const transitionDestination = this.destinations[startIndex];
		if (transitionDestination !== null) {
			instrArgs[transitionDestination]!.push(output);
			hasPromise[transitionDestination] = true;
		}

		// Continue with remaining instructions asynchronously
		for (let i = startIndex + 1; i < this.instructions.length; ++i) {
			const instruction = this.instructions[i];
			let args = instrArgs[i]!;
			instrArgs[i] = undefined;

			// Resolve any promise arguments
			if (hasPromise[i]) {
				args = await Promise.all(args);
			}

			// Trace input
			ctx.tracer!.traceInput(i, instruction, args as RuntimeValue[]);

			try {
				output = instruction.run(ctx, ...(args as RuntimeValue[]));

				// Resolve and wrap async output for tracing
				let resolvedOutput = output instanceof Promise ? await output : output;
				if (isAsyncIterable(resolvedOutput)) {
					resolvedOutput = wrapIterableForTracing(resolvedOutput, ctx, i, instruction);
					output = resolvedOutput; // Update output to the wrapped version
				}

				// Trace output
				ctx.tracer!.traceOutput(i, instruction, resolvedOutput);

				// Keep the original output (promise or value) for flow control
			} catch (error) {
				// Trace error
				ctx.tracer!.traceError(i, instruction, error as Error);
				throw error; // Re-throw the error
			}

			// Store the output
			const destination = this.destinations[i];
			if (destination !== null) {
				instrArgs[destination]!.push(output);
				if (output instanceof Promise) {
					hasPromise[destination] = true;
				}
			}
		}

		return output as OutputValue;
	}

	private runWithMetrics(ctx: RuntimeContext): OutputValue {
		// Initialize metrics for all instructions
		for (const instruction of this.instructions) {
			if (!instruction.runtimeStats) {
				instruction.runtimeStats = {
					in: 0,
					out: 0,
					elapsedNs: 0n,
					executions: 0
				};
			}
		}

		// Argument lists for each instruction.
		const instrArgs = new Array(this.instructions.length).fill(null).map(() => [] as OutputValue[] | undefined);
		// Running output
		let output: OutputValue | undefined;

		// Run synchronously until we hit a promise
		for (let i = 0; i < this.instructions.length; ++i) {
			const instruction = this.instructions[i];
			const args = instrArgs[i]!;
			instrArgs[i] = undefined; // Clear args as we go to minimize memory usage.

			// Run with metrics collection
			output = this.runInstructionWithMetrics(instruction, ctx, args as RuntimeValue[]);

			// If the instruction returned a promise, switch to async mode for rest of instructions
			if (output instanceof Promise) {
				return this.runAsyncWithMetrics(ctx, instrArgs, i, output);
			}

			// Store synchronous output
			const destination = this.destinations[i];
			if (destination !== null) {
				instrArgs[destination]!.push(output);
			}
		}

		// Log aggregate metrics if debugging is enabled
		this.logAggregateMetrics();

		return output as OutputValue;
	}

	private async runAsyncWithMetrics(
		ctx: RuntimeContext,
		instrArgs: (OutputValue[] | undefined)[],
		startIndex: number,
		pendingOutput: OutputValue
	): Promise<RuntimeValue> {
		// Instruction indexes that have promise arguments
		const hasPromise: boolean[] = [];

		let output: OutputValue | undefined = pendingOutput;

		// Store the output from the transition instruction
		const transitionDestination = this.destinations[startIndex];
		if (transitionDestination !== null) {
			instrArgs[transitionDestination]!.push(output);
			hasPromise[transitionDestination] = true;
		}

		// Continue with remaining instructions asynchronously
		for (let i = startIndex + 1; i < this.instructions.length; ++i) {
			const instruction = this.instructions[i];
			let args = instrArgs[i]!;
			instrArgs[i] = undefined;

			// Resolve any promise arguments
			if (hasPromise[i]) {
				args = await Promise.all(args);
			}

			// Run with metrics collection
			output = await this.runInstructionWithMetricsAsync(instruction, ctx, args as RuntimeValue[]);

			// Store the output
			const destination = this.destinations[i];
			if (destination !== null) {
				instrArgs[destination]!.push(output);
				if (output instanceof Promise) {
					hasPromise[destination] = true;
				}
			}
		}

		// Log aggregate metrics if debugging is enabled
		this.logAggregateMetrics();

		return output as OutputValue;
	}

	private runInstructionWithMetrics(instruction: Instruction, ctx: RuntimeContext, args: RuntimeValue[]): OutputValue {
		const stats = instruction.runtimeStats!;
		const start = hrtimeNs();

		stats.executions++;
		stats.in += this.countInputs(args);

		try {
			const result = instruction.run(ctx, ...args);

			if (result instanceof Promise) {
				// Handle async results separately
				return result.then(resolved => {
					stats.out += this.countOutputs(resolved);
					stats.elapsedNs += hrtimeNs() - start;
					return resolved;
				}).catch(error => {
					stats.elapsedNs += hrtimeNs() - start;
					throw error;
				});
			}

			stats.out += this.countOutputs(result);
			stats.elapsedNs += hrtimeNs() - start;

			return result;
		} catch (error) {
			stats.elapsedNs += hrtimeNs() - start;
			throw error;
		}
	}

	private async runInstructionWithMetricsAsync(instruction: Instruction, ctx: RuntimeContext, args: RuntimeValue[]): Promise<OutputValue> {
		const stats = instruction.runtimeStats!;
		const start = hrtimeNs();

		stats.executions++;
		stats.in += this.countInputs(args);

		try {
			const result = await instruction.run(ctx, ...args);
			stats.out += this.countOutputs(result);
			stats.elapsedNs += hrtimeNs() - start;
			return result;
		} catch (error) {
			stats.elapsedNs += hrtimeNs() - start;
			throw error;
		}
	}

	private countInputs(args: RuntimeValue[]): number {
		return args.reduce((sum: number, arg) => {
			if (isAsyncIterable(arg)) {
				return sum + 1; // Count as 1 for async iterables (we don't know size)
			} else if (Array.isArray(arg)) {
				return sum + arg.length;
			} else {
				return sum + 1;
			}
		}, 0);
	}

	private countOutputs(result: OutputValue): number {
		if (isAsyncIterable(result)) {
			return 1; // Count as 1 for async iterables (we don't know size)
		} else if (Array.isArray(result)) {
			return result.length;
		} else {
			return 1;
		}
	}

	private logAggregateMetrics(): void {
		if (log.enabled) {
			let totalExecutions = 0;
			let totalElapsed = 0n;
			let totalIn = 0;
			let totalOut = 0;

			for (const instruction of this.instructions) {
				if (instruction.runtimeStats) {
					totalExecutions += instruction.runtimeStats.executions;
					totalElapsed += instruction.runtimeStats.elapsedNs;
					totalIn += instruction.runtimeStats.in;
					totalOut += instruction.runtimeStats.out;
				}
			}

			log(`Aggregate metrics: ${totalExecutions} executions, ${totalElapsed / 1000n}μs elapsed, ${totalIn} inputs, ${totalOut} outputs`);
		}
	}

	/**
	 * Get runtime statistics for all instructions
	 */
	getMetrics(): InstructionRuntimeStats[] {
		return this.instructions.map(instruction => instruction.runtimeStats || {
			in: 0,
			out: 0,
			elapsedNs: 0n,
			executions: 0
		});
	}
}
