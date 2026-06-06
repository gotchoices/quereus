/**
 * Lightweight implementation of a mutex lock queue for managing concurrent access.
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
	 * @returns A function that must be called to release the lock
	 */
	static async acquire(key: string): Promise<() => void> {
		// Get the promise the current operation needs to wait for (if any)
		const currentTail = this.lockQueues.get(key) ?? Promise.resolve();

		let resolveNewTail!: () => void;
		// Create the promise that the *next* operation will wait for
		const newTail = new Promise<void>(resolve => {
			resolveNewTail = resolve;
		});

		// Immediately set the new promise as the tail for this key
		this.lockQueues.set(key, newTail);

		// Wait for the previous operation (if any) to complete
		await currentTail;

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

		return release;
	}
}
