import type { ViewMutationNode } from '../../planner/nodes/view-mutation-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import type { RuntimeValue, OutputValue, Row, SqlValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitCallFromPlan } from '../emitters.js';
import { isAsyncIterable } from '../utils.js';

type Callback = (ctx: RuntimeContext) => OutputValue;

/**
 * Emit a view-/MV-mediated mutation.
 *
 * Each base op is a fully-built base-table DML subtree (Sink-topped for the
 * non-RETURNING spine). They are emitted as **callbacks** (`emitCallFromPlan`
 * wraps each subtree in its own sub-program) rather than bare params, then this
 * instruction's `run` invokes them **sequentially**, awaiting each to completion
 * before starting the next.
 *
 * This sequencing is load-bearing for multi-source decomposition: the scheduler
 * kicks off sibling params concurrently (it does not await one before starting
 * the next — see `Scheduler.runAsync`), so a bare-param fan-out would interleave
 * the base writes and lose the FK-parent-before-child ordering the decomposition
 * decided. Driving the callbacks in list order here makes the emitted order the
 * executed order. For the single-source spine there is exactly one base op, so
 * this degenerates to driving that one to completion.
 *
 * **Shared-surrogate envelope (multi-source insert).** When `plan.envelope` is
 * present, before any base op runs this:
 *   1. materializes the augmented source once into an array (every supplied view
 *      column, in projection order);
 *   2. if `mint` is set, evaluates the surrogate `seed` once and appends
 *      `seed + ordinal` (1-based) as the last column of each row — the
 *      generate-once-per-row, thread-everywhere shared key; and
 *   3. stashes the rows in `rctx.tableContexts` under the envelope descriptor.
 * The base ops (run with this same `rctx`) each read those rows back through an
 * `EnvelopeScanNode`, so the shared key is identical across the fan-out. The
 * context entry is removed in a `finally` so it never leaks past the statement.
 *
 * RETURNING-through-view is rejected, so every base op is a side-effect statement
 * that yields nothing and this node yields nothing; the block emitter treats it
 * like a Sink for result selection.
 */
export function emitViewMutation(plan: ViewMutationNode, ctx: EmissionContext): Instruction {
	const baseOpInstructions = plan.baseOps.map(op => emitCallFromPlan(op, ctx));
	const baseOpCount = baseOpInstructions.length;

	const envelope = plan.envelope;
	const descriptor = envelope?.descriptor;
	const doMint = !!envelope?.mint;

	// Envelope source + optional surrogate seed are appended after the base-op
	// callbacks, so the scheduler resolves all of their sub-programs before `run`.
	const params: Instruction[] = [...baseOpInstructions];
	if (envelope) params.push(emitCallFromPlan(envelope.source, ctx));
	if (envelope?.mint) params.push(emitCallFromPlan(envelope.mint.seed, ctx));

	async function drainBaseOps(rctx: RuntimeContext, baseCbs: RuntimeValue[]): Promise<void> {
		for (const cb of baseCbs) {
			const result = (cb as Callback)(rctx);
			const resolved = result instanceof Promise ? await result : result;
			// A Sink-topped base op resolves to null; defensively drain a relational
			// result (a future RETURNING op) so its writes fire before the next op.
			if (isAsyncIterable(resolved)) {
				for await (const _row of resolved) { /* drain side effects */ }
			}
		}
	}

	async function materializeEnvelope(rctx: RuntimeContext, sourceCb: Callback, seedCb: Callback | undefined): Promise<Row[]> {
		// Evaluate the surrogate base BEFORE draining the source so it observes the
		// pre-mutation state (e.g. `max(anchor.key)`), captured once for every row.
		let seedValue = 0;
		if (seedCb) {
			const raw = await seedCb(rctx);
			seedValue = raw === null || raw === undefined ? 0 : Number(raw as SqlValue);
		}
		const rows: Row[] = [];
		const sourceResult = sourceCb(rctx);
		const resolved = sourceResult instanceof Promise ? await sourceResult : sourceResult;
		if (isAsyncIterable(resolved)) {
			let ordinal = 0;
			for await (const row of resolved as AsyncIterable<Row>) {
				ordinal += 1;
				rows.push(doMint ? ([...row, (seedValue + ordinal) as SqlValue] as Row) : (row as Row));
			}
		}
		return rows;
	}

	async function run(rctx: RuntimeContext, ...args: RuntimeValue[]): Promise<null> {
		const baseCbs = args.slice(0, baseOpCount);
		if (!descriptor) {
			await drainBaseOps(rctx, baseCbs);
			return null;
		}

		const sourceCb = args[baseOpCount] as Callback;
		const seedCb = doMint ? (args[baseOpCount + 1] as Callback) : undefined;
		const rows = await materializeEnvelope(rctx, sourceCb, seedCb);
		rctx.tableContexts.set(descriptor, () => arrayIterable(rows));
		try {
			await drainBaseOps(rctx, baseCbs);
		} finally {
			rctx.tableContexts.delete(descriptor);
		}
		return null;
	}

	return {
		params,
		run: run as InstructionRun,
		note: `viewMutation(${baseOpCount} base op${baseOpCount === 1 ? '' : 's'}${envelope ? ' +envelope' : ''})`,
	};
}

async function* arrayIterable(rows: Row[]): AsyncIterable<Row> {
	for (const row of rows) yield row;
}
