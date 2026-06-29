import type { RuntimeContext } from './types.js';
import { RowContextMap } from './context-helpers.js';
import {
	createStrictRowContextMap,
	wrapTableContextsStrict,
	markForkOf,
	bumpParentForkCounter,
	dropParentForkCounter,
	strictForkEnabled,
} from './strict-fork.js';

/**
 * Strict-fork bookkeeping helpers, re-exported for consumers that use
 * {@link ParallelDriver.fork} directly without going through {@link ParallelDriver.drive}.
 * Manual users are responsible for calling these around the fork's lifetime.
 */
export { bumpParentForkCounter, dropParentForkCounter };

/**
 * Options controlling {@link ParallelDriver.drive} execution.
 */
export interface ParallelDriveOptions {
	/** Maximum number of concurrently-active branches. Defaults to `factories.length`. */
	concurrency?: number;
	/** Cooperative cancellation. Firing aborts all branches. */
	signal?: AbortSignal;
}

/** Pair yielded by {@link ParallelDriver.drive}: a value plus the branch index that produced it. */
export interface ParallelDriveItem<T> {
	readonly branch: number;
	readonly value: T;
}

/**
 * Runtime helper that forks a {@link RuntimeContext} into N independent child views
 * and drives N branch factories concurrently with bounded concurrency and cooperative
 * cancellation.
 *
 * This is a foundation primitive — it has no SQL/plan-node consumers yet. Combinator
 * choice (gather, merge-by-key, zip, lookup-join, ...) is left to downstream nodes;
 * {@link drive} yields `{ branch, value }` pairs in arrival order so a consumer can
 * impose whatever combinator it needs on top.
 */
export class ParallelDriver {
	/**
	 * Fork `rctx` into `n` independent child views.
	 *
	 * Each child receives:
	 * - an **independent** {@link RowContextMap} seeded with a snapshot of the parent's
	 *   entries — writes (e.g. via `createRowSlot`) in one fork do not leak to siblings
	 *   or to the parent;
	 * - an **independent** `tableContexts` map seeded with a shallow snapshot of the
	 *   parent's entries — set/delete in one fork do not leak to siblings or parent;
	 * - **shared** references to read-mostly state: `db`, `stmt`, `params`,
	 *   `enableMetrics`, `mutationOrdinal`, `signal`, `tracer`, `activeConnection`,
	 *   `contextTracker`, `planStack`. (`signal` is shared so every branch honors the
	 *   same cooperative cancellation — the table-scan leaf reads `rctx.signal`.)
	 *   (`mutationOrdinal` is a per-row INSERT/envelope
	 *   scalar set+restored synchronously by the sequential insert path, never mutated
	 *   inside a parallel fork, so each child snapshots the parent value.)
	 *
	 * The parent is treated as immutable for the lifetime of the forks.
	 */
	fork(rctx: RuntimeContext, n: number): RuntimeContext[] {
		if (n < 0 || !Number.isInteger(n)) {
			throw new RangeError(`ParallelDriver.fork: n must be a non-negative integer, got ${n}`);
		}
		const strict = strictForkEnabled();
		const forks: RuntimeContext[] = new Array(n);
		for (let i = 0; i < n; i++) {
			// Fresh per-fork maps. Under strict mode the maps are wrapped so they
			// can themselves serve as parents for sub-forks; the seed loop runs
			// before any sub-fork is active, so the wrapper's guard passes naturally.
			const childContext = strict ? createStrictRowContextMap() : new RowContextMap();
			for (const [desc, getter] of rctx.context.entries()) {
				childContext.set(desc, getter);
			}
			const childTableContextsRaw = new Map(rctx.tableContexts);
			const childTableContexts = strict ? wrapTableContextsStrict(childTableContextsRaw) : childTableContextsRaw;
			forks[i] = {
				db: rctx.db,
				stmt: rctx.stmt,
				params: rctx.params,
				context: childContext,
				tableContexts: childTableContexts,
				tracer: rctx.tracer,
				activeConnection: rctx.activeConnection,
				enableMetrics: rctx.enableMetrics,
				mutationOrdinal: rctx.mutationOrdinal,
				signal: rctx.signal,
				contextTracker: rctx.contextTracker,
				planStack: rctx.planStack,
			};
			if (strict) {
				markForkOf(childTableContexts, rctx.tableContexts);
				markForkOf(childContext, rctx.context);
			}
		}
		return forks;
	}

	/**
	 * Drive `factories` concurrently, each invoked with its paired fork from `forks`,
	 * and yield every produced value as `{ branch, value }` in arrival order.
	 *
	 * Concurrency is capped at `opts.concurrency` (default: `factories.length`); a
	 * new branch is started only when an in-flight branch completes.
	 *
	 * If any branch's iterator throws, the original error is re-raised after every
	 * other in-flight iterator has been best-effort `return()`-closed.
	 *
	 * Cancellation is cooperative via `opts.signal`:
	 * - A pre-aborted signal causes `drive()` to throw before any factory is invoked.
	 * - An abort fired mid-stream interrupts the next race step, then closes branches.
	 *
	 * When the consumer breaks out of the `for-await` loop, the async generator's
	 * `return()` runs the same close-all path on every active branch.
	 */
	drive<T>(
		factories: ReadonlyArray<(ctx: RuntimeContext) => AsyncIterable<T>>,
		forks: ReadonlyArray<RuntimeContext>,
		opts?: ParallelDriveOptions,
	): AsyncIterable<ParallelDriveItem<T>> {
		if (factories.length !== forks.length) {
			throw new RangeError(
				`ParallelDriver.drive: factories.length (${factories.length}) !== forks.length (${forks.length})`,
			);
		}
		return driveImpl(factories, forks, opts);
	}
}

const ABORT_SENTINEL: unique symbol = Symbol('quereus.parallel-driver.abort');
type AbortSentinel = typeof ABORT_SENTINEL;

interface BranchPullResult<T> {
	branch: number;
	result: IteratorResult<T>;
	/** True iff the iterator threw; `error` then carries the thrown value (which may itself be `undefined`). */
	hadError: boolean;
	error: unknown;
}

async function* driveImpl<T>(
	factories: ReadonlyArray<(ctx: RuntimeContext) => AsyncIterable<T>>,
	forks: ReadonlyArray<RuntimeContext>,
	opts: ParallelDriveOptions | undefined,
): AsyncIterable<ParallelDriveItem<T>> {
	const signal = opts?.signal;

	// Pre-aborted: throw before invoking any factory.
	if (signal?.aborted) {
		throw signalReason(signal);
	}

	if (factories.length === 0) return;

	// Strict-fork bookkeeping (no-op outside strict mode). All forks share the
	// same parent, so reading the first fork's back-reference is sufficient.
	const parentTableState = forks.length > 0 ? bumpParentForkCounter(forks[0].tableContexts) : null;
	const parentRowState = forks.length > 0 ? bumpParentForkCounter(forks[0].context) : null;

	const concurrency = Math.max(1, opts?.concurrency ?? factories.length);
	const branchCount = factories.length;

	type BranchState = 'not-started' | 'pulling' | 'done';
	const iterators: Array<AsyncIterator<T> | null> = new Array(branchCount).fill(null);
	const branchStates: BranchState[] = new Array(branchCount).fill('not-started');
	const pendingPulls = new Map<number, Promise<BranchPullResult<T>>>();

	let nextToStart = 0;
	let activePulling = 0;
	let aborted = false;
	let abortReason: unknown = undefined;

	// Build a never-rejecting promise that resolves to ABORT_SENTINEL on signal abort.
	let onAbort: (() => void) | null = null;
	const abortPromise = new Promise<AbortSentinel>((resolve) => {
		if (!signal) return; // never resolves — fine inside Promise.race
		onAbort = () => {
			if (!aborted) {
				aborted = true;
				abortReason = signalReason(signal);
			}
			resolve(ABORT_SENTINEL);
		};
		signal.addEventListener('abort', onAbort);
	});

	const schedulePull = (i: number): void => {
		if (branchStates[i] === 'done') return;
		const it = iterators[i]!;
		const promise: Promise<BranchPullResult<T>> = (async () => {
			try {
				const result = await it.next();
				return { branch: i, result, hadError: false, error: undefined };
			} catch (error) {
				return {
					branch: i,
					result: { value: undefined as unknown as T, done: true } as IteratorResult<T>,
					hadError: true,
					error,
				};
			}
		})();
		pendingPulls.set(i, promise);
	};

	const startNextBranch = (): void => {
		const i = nextToStart++;
		const factory = factories[i];
		const fork = forks[i];
		const iter = factory(fork)[Symbol.asyncIterator]();
		iterators[i] = iter;
		branchStates[i] = 'pulling';
		activePulling++;
		schedulePull(i);
	};

	const markDone = (i: number): void => {
		if (branchStates[i] !== 'done') {
			branchStates[i] = 'done';
			activePulling--;
		}
	};

	const closeAll = async (): Promise<void> => {
		const closingPromises: Promise<unknown>[] = [];
		for (let i = 0; i < branchCount; i++) {
			const it = iterators[i];
			if (it && branchStates[i] !== 'done') {
				markDone(i);
				if (typeof it.return === 'function') {
					try {
						const p = it.return();
						closingPromises.push(Promise.resolve(p).catch(() => undefined));
					} catch {
						// Synchronous throw from return() — swallow; we are already in cleanup.
					}
				}
			}
			iterators[i] = null;
		}
		pendingPulls.clear();
		if (closingPromises.length > 0) {
			await Promise.allSettled(closingPromises);
		}
	};

	try {
		// Start the initial wave up to the concurrency cap.
		while (activePulling < concurrency && nextToStart < branchCount) {
			startNextBranch();
		}

		while (pendingPulls.size > 0) {
			const winner = await Promise.race<BranchPullResult<T> | AbortSentinel>([
				abortPromise,
				...pendingPulls.values(),
			]);
			if (winner === ABORT_SENTINEL) throw abortReason;

			const { branch, result, hadError, error } = winner;
			pendingPulls.delete(branch);

			if (hadError) {
				throw error;
			}

			if (result.done) {
				markDone(branch);
				iterators[branch] = null;
				while (activePulling < concurrency && nextToStart < branchCount) {
					startNextBranch();
				}
			} else {
				yield { branch, value: result.value };
				if (branchStates[branch] === 'pulling') {
					schedulePull(branch);
				}
			}
		}
	} finally {
		if (signal && onAbort) {
			signal.removeEventListener('abort', onAbort);
		}
		dropParentForkCounter(parentTableState);
		dropParentForkCounter(parentRowState);
		await closeAll();
	}
}

function signalReason(signal: AbortSignal): unknown {
	const reason = (signal as { reason?: unknown }).reason;
	return reason !== undefined ? reason : new Error('aborted');
}
