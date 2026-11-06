import { MisuseError } from '../common/errors.js';
import { createLogger } from '../common/logger.js';

const errorLog = createLogger('core:interruptible-iteration').extend('error');

function closedError(): MisuseError {
	return new MisuseError('Database is closed');
}

/**
 * A statement's row iterator as its consumer holds it, so `Database.close()` can stop the
 * statement whether or not anyone pulls it again.
 *
 * {@link interrupt} throws into the generator. An async generator queues that behind a pull
 * already in progress, so it lands at a row boundary, never inside a step, and the statement
 * unwinds from there: scan connections disconnect and an implicit transaction rolls back.
 * A finished generator answers `{ done: true }`, which would read as a complete result, so
 * once interrupted every later `next()` and `return()` rejects with `Database is closed`.
 *
 * The generator registers itself with the database while it holds running work, which is why
 * it is built from a callback that receives this wrapper.
 */
export class InterruptibleIteration<T> implements AsyncIterableIterator<T> {
	private readonly generator: AsyncGenerator<T>;
	private interrupted = false;

	constructor(start: (iteration: InterruptibleIteration<T>) => AsyncGenerator<T>) {
		this.generator = start(this);
	}

	next(...value: [] | [unknown]): Promise<IteratorResult<T>> {
		if (this.interrupted) return Promise.reject(closedError());
		return this.generator.next(...value);
	}

	async return(value?: T | PromiseLike<T>): Promise<IteratorResult<T>> {
		const result = await this.generator.return(value);
		// Stopping early normally commits; an interrupted statement rolled back instead.
		if (this.interrupted) throw closedError();
		return result;
	}

	throw(e?: unknown): Promise<IteratorResult<T>> {
		return this.generator.throw(e);
	}

	[Symbol.asyncIterator](): this {
		return this;
	}

	/** Stops the statement at its next row boundary; resolves once it has unwound. Never rejects. */
	async interrupt(): Promise<void> {
		this.interrupted = true;
		const stop = closedError();
		try {
			const result = await this.generator.throw(stop);
			// A step that caught the error and produced another row would keep the statement
			// running; return() cannot be caught.
			if (!result.done) await this.generator.return(undefined);
		} catch (e) {
			if (e !== stop) errorLog('A statement stopped by close() failed while unwinding: %O', e);
		}
	}
}
