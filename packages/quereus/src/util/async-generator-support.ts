/**
 * One-time self-check that the host runs an async generator's `finally` to
 * completion when the consumer calls `return()` while the generator is
 * suspended at a `yield` (what `break` / `return` inside `for await` does).
 *
 * Native engines do. The `wrapAsyncGenerator` helper shipped in
 * `@babel/helpers` and `@babel/runtime` before 7.29.2 does not: after the
 * first `await` inside such a `finally` it resumes the generator with a second
 * `return()` instead of `next()`, silently dropping the rest of the cleanup
 * and still resolving `{ done: true }`. React Native bundles built by Metro
 * lower every async generator through that helper, so a stale lockfile turns
 * an early exit from `db.eval()` into a permanently held exec mutex. The
 * engine's cleanup paths (mutex release, statement finalize, cursor close)
 * are written against the spec, so the only safe response is to fail loudly
 * before the first statement runs.
 */
import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';

/** True when `finally` code after an `await` ran on an early `return()`. */
export async function probeAsyncGeneratorCleanup(): Promise<boolean> {
	let completed = false;
	async function* probe(): AsyncGenerator<void> {
		try {
			yield;
		} finally {
			await Promise.resolve();
			completed = true;
		}
	}
	const it = probe();
	await it.next();
	await it.return(undefined);
	return completed;
}

const UNSUPPORTED_MESSAGE =
	'This JavaScript environment drops async-generator cleanup after an await in a finally block ' +
	'when iteration stops early, which would leave Quereus\'s execution lock held forever. ' +
	'This is a known defect in the Babel wrapAsyncGenerator helper before 7.29.2: ' +
	'upgrade @babel/helpers and @babel/runtime to >= 7.29.2 (e.g. `yarn up @babel/runtime @babel/helpers`) ' +
	'and rebuild the bundle.';

let verified = false;
let pending: Promise<void> | undefined;

/**
 * Returns `undefined` once the environment has been verified (sync fast path),
 * otherwise a promise that resolves on success or rejects with an
 * `UNSUPPORTED` {@link QuereusError} naming the fix. The verdict is memoized
 * for the life of the process.
 */
export function ensureAsyncGeneratorCleanupSupported(): Promise<void> | undefined {
	if (verified) return undefined;
	if (!pending) {
		pending = probeAsyncGeneratorCleanup().then(ok => {
			if (!ok) throw new QuereusError(UNSUPPORTED_MESSAGE, StatusCode.UNSUPPORTED);
			verified = true;
		});
	}
	return pending;
}
