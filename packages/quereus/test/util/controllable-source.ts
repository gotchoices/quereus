import type { RuntimeContext } from '../../src/runtime/types.js';
import type { Row } from '../../src/common/types.js';

/**
 * Deterministic test primitives for the parallel-runtime specs.
 *
 * The system under test (ParallelDriver and the gather / prefetch / fan-out
 * combinators built on it) makes concurrency guarantees: branches run in
 * parallel up to a cap, siblings are return()-closed on error / early-break,
 * and arrival order is whatever the branches produce.
 *
 * Proving those guarantees with `setTimeout` delays and `Date.now()` deltas is
 * flaky and only probes one accidental interleaving. Instead, each branch here
 * blocks on an externally-controlled gate (a {@link Deferred}) and reports into
 * a shared {@link ConcurrencyTracker}. A test can therefore:
 *   - let every branch reach its gate, assert `tracker.peak === N` (true
 *     parallelism) or `tracker.peak <= cap` (cap respected), then release;
 *   - release gates in a chosen order to force an exact interleaving and assert
 *     the resulting arrival order;
 *   - hold a sibling at its gate while another branch errors / the consumer
 *     breaks, and assert the sibling was return()-closed — all without sleeping.
 */

/** A promise plus its externally-callable settle handles. */
export interface Deferred<T = void> {
	readonly promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
}

/** Create a {@link Deferred}. */
export function makeDeferred<T = void>(): Deferred<T> {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/**
 * Tracks how many branches are concurrently parked at a gate.
 *
 * `enter()` is called when a branch begins awaiting its gate; `exit()` when it
 * proceeds past. `peak` records the maximum simultaneous in-flight count seen,
 * which is the deterministic proof of parallelism (peak === N) or of a respected
 * cap (peak <= cap).
 */
export class ConcurrencyTracker {
	private _inFlight = 0;
	private _peak = 0;
	/** Resolves whenever `inFlight` reaches a target awaited via {@link waitForInFlight}. */
	private waiters: Array<{ target: number; deferred: Deferred }> = [];

	get inFlight(): number {
		return this._inFlight;
	}

	get peak(): number {
		return this._peak;
	}

	enter(): void {
		this._inFlight++;
		if (this._inFlight > this._peak) this._peak = this._inFlight;
		this.notify();
	}

	exit(): void {
		this._inFlight--;
		this.notify();
	}

	/**
	 * Resolve once `inFlight` is at least `target`. Lets a test deterministically
	 * await "all N branches have reached their gate" without polling or sleeping.
	 */
	waitForInFlight(target: number): Promise<void> {
		if (this._inFlight >= target) return Promise.resolve();
		const deferred = makeDeferred();
		this.waiters.push({ target, deferred });
		return deferred.promise;
	}

	private notify(): void {
		if (this.waiters.length === 0) return;
		const current = this._inFlight;
		const remaining: Array<{ target: number; deferred: Deferred }> = [];
		for (const w of this.waiters) {
			if (current >= w.target) {
				w.deferred.resolve();
			} else {
				remaining.push(w);
			}
		}
		this.waiters = remaining;
	}
}

/** Lifecycle events recorded by a {@link controllableSource} into its trace. */
export type SourceEvent =
	| { kind: 'started'; branch: number }
	| { kind: 'awaiting-gate'; branch: number; index: number }
	| { kind: 'yielded'; branch: number; index: number }
	| { kind: 'returned'; branch: number }
	| { kind: 'errored'; branch: number; error: unknown }
	| { kind: 'completed'; branch: number };

/** Per-yield lifecycle hooks (mirrors the legacy mockSource shape). */
export interface ControllableHooks {
	onStart?: () => void;
	onReturn?: () => void;
	onError?: (err: unknown) => void;
	onComplete?: () => void;
}

export interface ControllableSourceOptions {
	/** Branch index, used to label trace events. */
	branch?: number;
	/** Rows to emit. Each is gated unless the branch index appears in `ungated`. */
	rows: Row[];
	/**
	 * Per-yield gates. `gates[i]` is awaited before emitting `rows[i]`; the test
	 * resolves it to release that yield. When omitted, a fresh gate is created for
	 * every row and exposed via {@link ControllableSourceHandle.gates}.
	 */
	gates?: ReadonlyArray<Deferred>;
	/** Shared tracker; the branch reports enter()/exit() around each gate wait. */
	tracker?: ConcurrencyTracker;
	/** Append-only trace of lifecycle events shared across branches. */
	trace?: SourceEvent[];
	/** Row index at which to throw instead of yielding (after its gate resolves). */
	throwAtRow?: number;
	/** Error to throw when `throwAtRow` fires; defaults to a fresh Error. */
	throwError?: Error;
	/** Legacy-style lifecycle hooks. */
	hooks?: ControllableHooks;
}

/** Returned by {@link controllableSource}: the factory plus its gate handles. */
export interface ControllableSourceHandle {
	/** Factory matching the `(innerCtx) => AsyncIterable<Row>` combinator shape. */
	factory: (innerCtx: RuntimeContext) => AsyncIterable<Row>;
	/** The per-yield gates (auto-created when not supplied). */
	readonly gates: ReadonlyArray<Deferred>;
	/** Release every gate, in order — convenience for "drain all". */
	releaseAll(): void;
}

/**
 * Build a gate-controlled async source.
 *
 * Each row's emission blocks on its gate. While blocked the branch is counted as
 * in-flight in the shared {@link ConcurrencyTracker}, so a test can prove how many
 * branches are simultaneously parked. The branch records every lifecycle step
 * into the shared `trace`, enabling exact arrival-order / event-ordering
 * assertions once gates are released in a chosen sequence.
 */
export function controllableSource(opts: ControllableSourceOptions): ControllableSourceHandle {
	const branch = opts.branch ?? 0;
	const gates: Deferred[] = opts.gates
		? [...opts.gates]
		: opts.rows.map(() => makeDeferred());
	const tracker = opts.tracker;
	const trace = opts.trace;

	// Sentinel resolved by the iterator's return()/throw(). A gate-await races
	// against it so that an external close can interrupt a branch parked at an
	// unreleased gate — async generators otherwise block return() behind the
	// in-flight await, which would deadlock a deterministic (never-released) gate.
	const CLOSE: unique symbol = Symbol('controllable-source.close');

	const factory = (_innerCtx: RuntimeContext): AsyncIterable<Row> => {
		const closed = makeDeferred<typeof CLOSE>();
		let started = false;
		let finished = false;
		let nextIndex = 0;

		const finish = (closing: boolean): void => {
			if (finished) return;
			finished = true;
			if (closing) {
				trace?.push({ kind: 'returned', branch });
				opts.hooks?.onReturn?.();
			}
		};

		const iterator: AsyncIterator<Row> = {
			async next(): Promise<IteratorResult<Row>> {
				if (!started) {
					started = true;
					opts.hooks?.onStart?.();
					trace?.push({ kind: 'started', branch });
				}
				if (finished) return { done: true, value: undefined as never };

				while (nextIndex < opts.rows.length) {
					const i = nextIndex;
					trace?.push({ kind: 'awaiting-gate', branch, index: i });
					tracker?.enter();
					let interrupted = false;
					try {
						const won = await Promise.race([gates[i].promise, closed.promise]);
						if (won === CLOSE) interrupted = true;
					} finally {
						tracker?.exit();
					}
					if (interrupted) {
						finish(true);
						return { done: true, value: undefined as never };
					}
					nextIndex++;

					if (opts.throwAtRow !== undefined && i === opts.throwAtRow) {
						const err = opts.throwError ?? new Error(`controllable source threw at row ${i}`);
						trace?.push({ kind: 'errored', branch, error: err });
						finish(true);
						opts.hooks?.onError?.(err);
						throw err;
					}

					trace?.push({ kind: 'yielded', branch, index: i });
					return { done: false, value: opts.rows[i] };
				}

				// Natural completion: not a close, so onReturn must NOT fire.
				finished = true;
				trace?.push({ kind: 'completed', branch });
				opts.hooks?.onComplete?.();
				return { done: true, value: undefined as never };
			},
			async return(value?: unknown): Promise<IteratorResult<Row>> {
				const wasFinished = finished;
				closed.resolve(CLOSE);
				if (!wasFinished) finish(true);
				return { done: true, value: value as never };
			},
			async throw(err?: unknown): Promise<IteratorResult<Row>> {
				const wasFinished = finished;
				closed.resolve(CLOSE);
				if (!wasFinished) finish(true);
				throw err;
			},
		};

		return { [Symbol.asyncIterator]: () => iterator };
	};

	return {
		factory,
		gates,
		releaseAll(): void {
			for (const g of gates) g.resolve();
		},
	};
}
