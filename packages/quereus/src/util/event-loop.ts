/** Gives up the thread if it has been held for too long. Awaiting one never rejects. */
export type EventLoopPacer = () => Promise<void>;

/** One 60 Hz frame. */
const BUDGET_MS = 16;

/**
 * One event-loop turn. `setTimeout` is the one primitive on node, browsers and React Native.
 *
 * NOTE: hidden browser tabs throttle timers to about once a second, so long paced work in a hidden
 * tab gets much slower. If that ever matters, prefer `MessageChannel` where it exists, closing the
 * port so node can exit.
 */
export function yieldToEventLoop(): Promise<void> {
	return new Promise<void>(resolve => setTimeout(resolve, 0));
}

/**
 * Returns a pacer that yields only once the thread has been held for {@link BUDGET_MS} since the last
 * yield, or since this call for the first one. A yield on every call is not viable: one
 * `setTimeout(0)` was measured at about 15 ms on Windows, which took a 400-table `apply schema`
 * from 9 ms to 5946 ms.
 *
 * A backward clock jump reads as a negative hold, which yields at once and restarts the count, so
 * it costs one early yield rather than suppressing yields until the clock catches up.
 */
export function createEventLoopPacer(): EventLoopPacer {
	let heldSince = Date.now();
	return async () => {
		const held = Date.now() - heldSince;
		if (held >= 0 && held < BUDGET_MS) return;
		await yieldToEventLoop();
		heldSince = Date.now();
	};
}
