import type { ViewMutationNode } from '../../planner/nodes/view-mutation-node.js';
import { isRelationalNode } from '../../planner/nodes/plan-node.js';
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
 * **RETURNING-through-view.** When the mutation has a `returning` clause the node
 * is relational and this emitter yields the view-projected rows (materialized
 * eagerly, so the base writes fire inside `run` regardless of the node's position
 * in a block — matching the void path's eager drain). Two shapes:
 *   - *single-source*: the RETURNING clause was rewritten onto the (sole) base op,
 *     which plans to a relational `ReturningNode`. `run` drains every base op and
 *     surfaces that one's rows (NEW for insert/update, OLD for delete).
 *   - *multi-source* update/delete: `plan.returning` is a separate re-query of the
 *     view. A delete captures it **before** the base ops fire (`returningTiming ===
 *     'pre'` — the rows are about to disappear); an update captures it **after**
 *     (the post-mutation image).
 *
 * Without a `returning` clause every base op is a side-effect statement that
 * yields nothing and this node yields nothing; the block emitter treats it like a
 * Sink for result selection.
 */
export function emitViewMutation(plan: ViewMutationNode, ctx: EmissionContext): Instruction {
	const baseOpInstructions = plan.baseOps.map(op => emitCallFromPlan(op, ctx));
	const baseOpCount = baseOpInstructions.length;

	const envelope = plan.envelope;
	const descriptor = envelope?.descriptor;
	const doMint = !!envelope?.mint;

	// The relational base op carrying a single-source RETURNING (the rewritten,
	// view-projected clause), or -1. Mutually exclusive with `plan.returning`.
	const relationalBaseIdx = plan.baseOps.findIndex(op => isRelationalNode(op));
	const returningTiming = plan.returningTiming;

	// Params follow the same order `ViewMutationNode.getChildren` threads them in:
	// base-op callbacks, then the optional RETURNING re-query, then the envelope
	// source + optional surrogate seed — so the scheduler resolves every
	// sub-program before `run`.
	const params: Instruction[] = [...baseOpInstructions];
	let cursor = baseOpCount;
	let returningIdx = -1;
	if (plan.returning) { returningIdx = cursor++; params.push(emitCallFromPlan(plan.returning, ctx)); }
	let envSourceIdx = -1;
	if (envelope) { envSourceIdx = cursor++; params.push(emitCallFromPlan(envelope.source, ctx)); }
	let seedIdx = -1;
	if (envelope?.mint) { seedIdx = cursor++; params.push(emitCallFromPlan(envelope.mint.seed, ctx)); }

	async function drainBaseOps(rctx: RuntimeContext, baseCbs: RuntimeValue[]): Promise<void> {
		for (const cb of baseCbs) {
			const result = (cb as Callback)(rctx);
			const resolved = result instanceof Promise ? await result : result;
			// A Sink-topped base op resolves to null; defensively drain a relational
			// result so its writes fire before the next op.
			if (isAsyncIterable(resolved)) {
				for await (const _row of resolved) { /* drain side effects */ }
			}
		}
	}

	/** Drain a base-op / re-query callback result fully into a materialized row array. */
	async function collectRows(value: OutputValue): Promise<Row[]> {
		const resolved = value instanceof Promise ? await value : value;
		const rows: Row[] = [];
		if (isAsyncIterable(resolved)) {
			for await (const row of resolved as AsyncIterable<Row>) rows.push(row);
		}
		return rows;
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

	async function run(rctx: RuntimeContext, ...args: RuntimeValue[]): Promise<OutputValue> {
		const baseCbs = args.slice(0, baseOpCount);

		// (1) Multi-source RETURNING via a separate re-query of the view.
		if (returningIdx >= 0) {
			const returningCb = args[returningIdx] as Callback;
			if (returningTiming === 'pre') {
				// delete: capture the to-be-deleted view rows before the base ops fire.
				const rows = await collectRows(returningCb(rctx));
				await drainBaseOps(rctx, baseCbs);
				return arrayIterable(rows);
			}
			// update: mutate first, then re-query reads the post-mutation image.
			await drainBaseOps(rctx, baseCbs);
			return arrayIterable(await collectRows(returningCb(rctx)));
		}

		// (2) Single-source RETURNING rewritten onto the (sole) relational base op.
		// Drain every base op in list order (firing writes); surface the relational
		// one's view-projected rows.
		if (relationalBaseIdx >= 0) {
			let resultRows: Row[] = [];
			for (let i = 0; i < baseCbs.length; i++) {
				const rows = await collectRows((baseCbs[i] as Callback)(rctx));
				if (i === relationalBaseIdx) resultRows = rows;
			}
			return arrayIterable(resultRows);
		}

		// (3) Void mutation (no RETURNING): drive the base ops, yield nothing.
		if (!descriptor) {
			await drainBaseOps(rctx, baseCbs);
			return null;
		}

		const sourceCb = args[envSourceIdx] as Callback;
		const seedCb = doMint ? (args[seedIdx] as Callback) : undefined;
		const rows = await materializeEnvelope(rctx, sourceCb, seedCb);
		rctx.tableContexts.set(descriptor, () => arrayIterable(rows));
		try {
			await drainBaseOps(rctx, baseCbs);
		} finally {
			rctx.tableContexts.delete(descriptor);
		}
		return null;
	}

	const retNote = plan.returning ? ` +returning(${returningTiming})` : relationalBaseIdx >= 0 ? ' +returning' : '';
	return {
		params,
		run: run as InstructionRun,
		note: `viewMutation(${baseOpCount} base op${baseOpCount === 1 ? '' : 's'}${envelope ? ' +envelope' : ''}${retNote})`,
	};
}

async function* arrayIterable(rows: Row[]): AsyncIterable<Row> {
	for (const row of rows) yield row;
}
