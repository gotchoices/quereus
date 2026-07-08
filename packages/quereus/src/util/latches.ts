import { createLogger } from '../common/logger.js';
import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';

const log = createLogger('util:latches');
const warnLog = log.extend('warn');

/**
 * Lightweight mutex lock queue for serializing concurrent access by string key.
 *
 * NOTE: the queue map is a process-global `static` keyed only by the string argument,
 * so it is shared across *all* `Database` instances — two independent databases that
 * pass the same key contend on the same latch. Every current caller namespaces its key
 * with `schema.table`, which keeps intra-process collisions to genuinely same-named
 * tables. Scoping the registry per-database (an owned `Latches` instance) is tracked
 * separately in the `latches-database-scoping` ticket.
 */
export class Latches {
	// Stores the promise representing the completion of the last queued operation for a key.
	private static lockQueues = new Map<string, Promise<void>>();

	/**
	 * Acquires a lock for the given key. Waits if another operation holds the lock.
	 * Returns a release function that must be called to release the lock.
	 *
	 * @param key A unique string identifier for the resource to lock.
	 *            Should use `ClassName.methodName:${id}` format to avoid conflicts.
	 * @param timeoutMs Optional deadlock guard. When set and the predecessor does not
	 *            release within this many milliseconds, the wait is abandoned: a warning
	 *            is logged naming the contended key, this waiter's queue slot is released
	 *            so the queue behind it does not wedge, and the returned promise rejects
	 *            with a `QuereusError` (StatusCode.BUSY). Omit (the default) for the
	 *            original never-reject behavior.
	 * @returns A function that must be called to release the lock
	 */
	static async acquire(key: string, timeoutMs?: number): Promise<() => void> {
		// Get the promise the current operation needs to wait for (if any)
		const currentTail = this.lockQueues.get(key) ?? Promise.resolve();

		let resolveNewTail!: () => void;
		// Create the promise that the *next* operation will wait for
		const newTail = new Promise<void>(resolve => {
			resolveNewTail = resolve;
		});

		// Immediately set the new promise as the tail for this key
		this.lockQueues.set(key, newTail);

		// Return the function to release *this* lock
		const release = () => {
			// Signal that this operation is complete
			resolveNewTail();

			// If this promise is still the current tail in the map,
			// it means no other operation queued up behind this one while it was running.
			// We can safely remove the entry from the map to prevent unbounded growth.
			if (this.lockQueues.get(key) === newTail) {
				this.lockQueues.delete(key);
			}
		};

		if (timeoutMs === undefined) {
			// Wait for the previous operation (if any) to complete
			await currentTail;
			return release;
		}

		// Opt-in deadlock guard: bound the wait for the predecessor.
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				warnLog('latch acquire timed out after %dms for key %s (possible deadlock); releasing waiter slot', timeoutMs, key);
				// Release our own slot so the queue behind us is not wedged by the abandoned wait.
				release();
				reject(new QuereusError(
					`Latch acquire timed out after ${timeoutMs}ms for '${key}' (possible deadlock)`,
					StatusCode.BUSY,
				));
			}, timeoutMs);
		});

		try {
			await Promise.race([currentTail, timeout]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
		return release;
	}
}
