/**
 * A counting semaphore with a FIFO waiter queue, used to bound the number of
 * concurrent in-flight branch lookups across *all* in-flight outer rows in a
 * batched fan-out lookup join.
 *
 * Mirrors the waiter discipline in {@link BoundedPrefetchBuffer}
 * (`runtime/emit/eager-prefetch.ts`) but as a counting semaphore rather than a
 * 1-slot buffer:
 *
 * - {@link acquire} resolves immediately when a permit is free, otherwise
 *   enqueues a waiter that resolves once a permit is handed to it.
 * - The release callback returned by {@link acquire} is **single-shot**: a
 *   second call is a no-op. On release the permit is handed directly to the
 *   head of the waiter queue (preserving FIFO) or returned to the pool when no
 *   waiter is queued.
 *
 * Exported for unit testing — production callers go through the batched
 * fan-out lookup join driver.
 */
export class AsyncSemaphore {
	private available: number;
	private readonly waiters: Array<() => void> = [];

	constructor(permits: number) {
		if (!Number.isInteger(permits) || permits < 1) {
			throw new RangeError(`AsyncSemaphore: permits must be a positive integer, got ${permits}`);
		}
		this.available = permits;
	}

	/** Number of currently-available permits (for tests/diagnostics). */
	get availablePermits(): number {
		return this.available;
	}

	/** Number of acquirers currently blocked waiting for a permit. */
	get waiterCount(): number {
		return this.waiters.length;
	}

	/**
	 * Acquire one permit, resolving with a single-shot release function. When no
	 * permit is free the returned promise resolves once a permit is handed to
	 * this acquirer in FIFO order.
	 */
	acquire(): Promise<() => void> {
		if (this.available > 0) {
			this.available--;
			return Promise.resolve(this.makeRelease());
		}
		return new Promise<() => void>(resolve => {
			// The waiter is handed a fresh single-shot release when a permit
			// becomes available; the permit count stays "consumed" across the
			// handoff (it is never returned to the pool then re-taken).
			this.waiters.push(() => resolve(this.makeRelease()));
		});
	}

	private makeRelease(): () => void {
		let released = false;
		return () => {
			if (released) return; // double-release is a no-op
			released = true;
			const next = this.waiters.shift();
			if (next) {
				// Hand the permit directly to the head waiter — do NOT return it to
				// the pool, or a racing acquire() could steal it ahead of the queue.
				next();
			} else {
				this.available++;
			}
		};
	}
}
