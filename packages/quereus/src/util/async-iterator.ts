/**
 * Async iterator utilities for resource management.
 */

/**
 * Cleanup handler called when an async iterator is terminated.
 * @param commit - true if iterator completed normally or early exit via break,
 *                 false if error was thrown into the iterator
 * @param error - the error that terminated the iterator (only set when commit=false)
 */
export type CleanupHandler = (commit: boolean, error?: unknown) => Promise<void> | void;

/**
 * Wraps an async iterable to ensure cleanup handlers are called on termination.
 *
 * This utility intercepts the iterator protocol methods to run a cleanup
 * callback before the generator's finally block executes. This is essential
 * for resources like transactions that must be finalized even if the consumer
 * breaks out of iteration early.
 *
 * Separation of concerns:
 * - The **cleanup handler** manages logical resources (transaction commit/rollback).
 * - The **generator's finally block** manages physical resources (mutex release,
 *   statement finalization).
 *
 * The cleanup handler is guaranteed to run at most once per iteration lifecycle.
 *
 * @param source - The async iterable to wrap
 * @param cleanup - Called on termination: commit=true for normal/early completion,
 *                  commit=false for errors
 */
export function wrapAsyncIterator<T>(
	source: AsyncIterable<T>,
	cleanup: CleanupHandler
): AsyncIterableIterator<T> {
	const iterator = source[Symbol.asyncIterator]();
	let cleanupCalled = false;

	const runCleanup = async (commit: boolean, error?: unknown): Promise<void> => {
		if (cleanupCalled) return;
		cleanupCalled = true;
		await cleanup(commit, error);
	};

	return {
		[Symbol.asyncIterator]() {
			return this;
		},

		async next(...args: [] | [undefined]) {
			try {
				const result = await iterator.next(...args);
				if (result.done) {
					await runCleanup(true);
				}
				return result;
			} catch (error) {
				// Run cleanup but prefer the original iterator error
				try {
					await runCleanup(false, error);
				} catch {
					// Discard cleanup error; the iterator error is more relevant
				}
				throw error;
			}
		},

		async return(value?: T) {
			// Early exit (break/return) - commit the logical resource
			let cleanupError: unknown;
			try {
				await runCleanup(true);
			} catch (err) {
				cleanupError = err;
			}

			// Always delegate to iterator.return() to release physical resources
			// (triggers the generator's finally block)
			try {
				if (iterator.return) {
					return iterator.return(value);
				}
				return { done: true as const, value: value as T };
			} finally {
				// If cleanup threw, propagate that error instead of swallowing it
				if (cleanupError !== undefined) {
					// eslint-disable-next-line no-unsafe-finally
					throw cleanupError;
				}
			}
		},

		async throw(error?: unknown) {
			// Error thrown into iterator - rollback the logical resource
			let cleanupError: unknown;
			try {
				await runCleanup(false, error);
			} catch (err) {
				cleanupError = err;
			}

			// Always delegate to iterator.throw() to release physical resources
			try {
				if (iterator.throw) {
					return iterator.throw(error);
				}
				throw error;
			} catch (iteratorError) {
				// If both cleanup and iterator threw, prefer the cleanup error
				// since the original error was already being handled
				if (cleanupError !== undefined) {
					throw cleanupError;
				}
				throw iteratorError;
			}
		}
	};
}
