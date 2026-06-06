import { expect } from 'chai';
import { Database } from '../../src/index.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import {
	acquireConnectionLock,
	getModuleConcurrencyMode,
} from '../../src/vtab/concurrency.js';
import type {
	AnyVirtualTableModule,
	VtabConcurrencyMode,
} from '../../src/vtab/module.js';
import type { VirtualTableConnection } from '../../src/vtab/connection.js';

/**
 * Build a stub module declaring (or omitting) a concurrencyMode. The other
 * VirtualTableModule methods are unused by these tests, so we cast through
 * `unknown` rather than stubbing 20-odd async methods.
 */
function makeStubModule(mode?: VtabConcurrencyMode): AnyVirtualTableModule {
	return ({ concurrencyMode: mode } as unknown) as AnyVirtualTableModule;
}

/** Minimal VirtualTableConnection stand-in; the lock only needs identity. */
function makeStubConnection(id: string): VirtualTableConnection {
	return {
		connectionId: id,
		tableName: 't',
		begin() {},
		commit() {},
		rollback() {},
		createSavepoint() {},
		releaseSavepoint() {},
		rollbackToSavepoint() {},
		disconnect() {},
	};
}

describe('vtab concurrency contract', () => {
	describe('getModuleConcurrencyMode', () => {
		it('defaults to serial when undeclared', () => {
			expect(getModuleConcurrencyMode(makeStubModule())).to.equal('serial');
		});

		it('round-trips each declared mode', () => {
			expect(getModuleConcurrencyMode(makeStubModule('serial'))).to.equal('serial');
			expect(getModuleConcurrencyMode(makeStubModule('reentrant-reads'))).to.equal('reentrant-reads');
			expect(getModuleConcurrencyMode(makeStubModule('fully-reentrant'))).to.equal('fully-reentrant');
		});

		it('reports MemoryTableModule as reentrant-reads', () => {
			// Reads-only concurrency on a single connection is the only audited
			// safety property — writes mutate `pendingTransactionLayer` in place,
			// so `'fully-reentrant'` is unsafe until writer concurrency is
			// independently justified.
			const memModule = new MemoryTableModule();
			expect(getModuleConcurrencyMode(memModule)).to.equal('reentrant-reads');
		});
	});

	describe('acquireConnectionLock', () => {
		it('serializes acquirers on the same connection', async () => {
			const conn = makeStubConnection('c1');
			const events: string[] = [];

			const releaseA = await acquireConnectionLock(conn);
			events.push('a-acquired');

			// Start b's acquire; it must NOT resolve until releaseA() fires.
			const bPromise = acquireConnectionLock(conn).then(release => {
				events.push('b-acquired');
				return release;
			});

			// Yield a microtask so b has a chance to resolve if the lock is broken.
			await Promise.resolve();
			await Promise.resolve();
			expect(events).to.deep.equal(['a-acquired']);

			events.push('a-released');
			releaseA();

			const releaseB = await bPromise;
			expect(events).to.deep.equal(['a-acquired', 'a-released', 'b-acquired']);
			releaseB();
		});

		it('does not block across distinct connections', async () => {
			const connA = makeStubConnection('a');
			const connB = makeStubConnection('b');

			const releaseA = await acquireConnectionLock(connA);
			// B should acquire immediately even though A's lock is held.
			const releaseB = await acquireConnectionLock(connB);

			releaseA();
			releaseB();
		});

		it('releases the lock even when the critical section throws', async () => {
			const conn = makeStubConnection('c-throw');

			try {
				const release = await acquireConnectionLock(conn);
				try {
					throw new Error('boom');
				} finally {
					release();
				}
			} catch (e) {
				expect((e as Error).message).to.equal('boom');
			}

			// Next acquirer must proceed without deadlock.
			const release2 = await acquireConnectionLock(conn);
			release2();
		});

		it('grants queued contenders in strict FIFO order, one at a time', async () => {
			// Case 1: queue N acquirers behind a held lock and assert they enter
			// the critical section in request order as each release fires.
			const conn = makeStubConnection('c-fifo');
			const events: string[] = [];
			const N = 5;

			// First acquirer holds the lock.
			const releaseHolder = await acquireConnectionLock(conn);

			// Queue N contenders, each recording its index on acquisition.
			const releases: Array<() => void> = [];
			const acquired = Array.from({ length: N }, (_, i) =>
				acquireConnectionLock(conn).then(release => {
					events.push(`enter-${i}`);
					releases.push(release);
					return release;
				}),
			);

			// Pump microtasks: none of the contenders may enter while the holder holds.
			await Promise.resolve();
			await Promise.resolve();
			expect(events).to.deep.equal([]);

			// Release the holder; exactly one contender (index 0) may enter.
			releaseHolder();
			await acquired[0];
			expect(events).to.deep.equal(['enter-0']);

			// Hand off down the chain; each release admits exactly the next in order.
			for (let i = 0; i < N; i++) {
				releases[i]();
				if (i + 1 < N) {
					await acquired[i + 1];
				}
			}

			expect(events).to.deep.equal(
				Array.from({ length: N }, (_, i) => `enter-${i}`),
			);
		});

		it('upholds mutual exclusion: peak concurrent holders is exactly 1', async () => {
			// Case 2: model the critical section with a counter and assert that
			// across many interleaved acquire->work->release cycles the peak
			// number of simultaneous holders never exceeds 1.
			const conn = makeStubConnection('c-mutex');
			let inCriticalSection = 0;
			let peak = 0;
			const M = 8;

			const worker = async (): Promise<void> => {
				const release = await acquireConnectionLock(conn);
				try {
					inCriticalSection++;
					peak = Math.max(peak, inCriticalSection);
					// Simulate async work spanning several microtask turns; the
					// invariant must hold across every yield point.
					await Promise.resolve();
					await Promise.resolve();
					expect(inCriticalSection).to.equal(1);
					inCriticalSection--;
				} finally {
					release();
				}
			};

			// Issue all workers before any completes, then await them all.
			const all = Array.from({ length: M }, () => worker());
			await Promise.all(all);

			expect(peak).to.equal(1);
			expect(inCriticalSection).to.equal(0);
		});

		it('does not stall queued waiters when a holder throws mid-critical-section', async () => {
			// Case 3: there is no waiter-cancellation API — a waiting acquirer
			// cannot be aborted. The relevant failure mode is a holder whose
			// critical section throws; provided release() runs in finally, the
			// queued waiters must proceed in order without deadlock.
			const conn = makeStubConnection('c-throw-chain');
			const events: string[] = [];

			// Holder that will throw; queued waiters are issued before it throws.
			const holderPromise = (async () => {
				const release = await acquireConnectionLock(conn);
				events.push('holder-enter');
				try {
					throw new Error('boom');
				} finally {
					release();
				}
			})();

			const w1 = acquireConnectionLock(conn).then(release => {
				events.push('w1-enter');
				return release;
			});
			const w2 = acquireConnectionLock(conn).then(release => {
				events.push('w2-enter');
				return release;
			});

			// The holder's throw must reject its own scope but not the waiters.
			let holderError: Error | undefined;
			try {
				await holderPromise;
			} catch (e) {
				holderError = e as Error;
			}
			expect(holderError?.message).to.equal('boom');

			const r1 = await w1;
			r1();
			const r2 = await w2;
			r2();

			expect(events).to.deep.equal(['holder-enter', 'w1-enter', 'w2-enter']);

			// Chain is intact: a fresh acquirer still proceeds.
			const r3 = await acquireConnectionLock(conn);
			r3();
		});

		it('keeps distinct connections lock-free under heavy neighbor contention', async () => {
			// Case 4: pile contenders onto connection A while it is held; a
			// distinct connection B must acquire immediately, unaffected.
			const connA = makeStubConnection('a-busy');
			const connB = makeStubConnection('b-free');
			const events: string[] = [];

			// Hold A and queue several contenders behind it.
			const releaseA = await acquireConnectionLock(connA);
			const aContenders = Array.from({ length: 4 }, (_, i) =>
				acquireConnectionLock(connA).then(release => {
					events.push(`a-${i}`);
					return release;
				}),
			);

			// B must acquire without waiting on A's queue.
			const releaseB = await acquireConnectionLock(connB);
			events.push('b-acquired');

			// Pump microtasks: A's contenders stay blocked, B is already through.
			await Promise.resolve();
			await Promise.resolve();
			expect(events).to.deep.equal(['b-acquired']);
			releaseB();

			// Drain A's queue in order.
			releaseA();
			const releases: Array<() => void> = [];
			for (let i = 0; i < aContenders.length; i++) {
				const r = await aContenders[i];
				releases.push(r);
				r();
			}

			expect(events).to.deep.equal(['b-acquired', 'a-0', 'a-1', 'a-2', 'a-3']);
		});

		it('serializes many batched outer rows sharing one connection (regression guard)', async () => {
			// Case 5: simulate the batched-outer fan-out shape — many "outer
			// rows" each acquire the same connection's lock for a short critical
			// section, all issued before any completes. Assert strict
			// serialization (peak holders === 1) and that every branch runs
			// exactly once, in issue order.
			const conn = makeStubConnection('c-batched-outer');
			const OUTER_ROWS = 12;
			let inCriticalSection = 0;
			let peak = 0;
			const runOrder: number[] = [];

			const outerRow = async (index: number): Promise<void> => {
				const release = await acquireConnectionLock(conn);
				try {
					inCriticalSection++;
					peak = Math.max(peak, inCriticalSection);
					runOrder.push(index);
					// Critical section spans a couple of microtask turns.
					await Promise.resolve();
					await Promise.resolve();
					expect(inCriticalSection).to.equal(1);
					inCriticalSection--;
				} finally {
					release();
				}
			};

			// Issue all branches up front (the batched-outer hazard), then await.
			const branches = Array.from({ length: OUTER_ROWS }, (_, i) => outerRow(i));
			await Promise.all(branches);

			expect(peak).to.equal(1);
			expect(inCriticalSection).to.equal(0);
			// Every branch ran exactly once, in strict issue order (FIFO).
			expect(runOrder).to.deep.equal(
				Array.from({ length: OUTER_ROWS }, (_, i) => i),
			);
		});
	});

	describe('memory vtab concurrent scan smoke', () => {
		// Load-bearing safety check for the 'reentrant-reads' declaration on
		// MemoryTableModule. If a future memory-vtab change breaks concurrent
		// reads, this test fails before any FanOutLookupJoin consumer needs it.
		//
		// db.eval() acquires the engine's exec mutex per call, so the four
		// iterators below do not actually overlap at the vtab layer in
		// today's runtime — but they share a manager/connection and exercise
		// the same scan path the parallel consumer will. The assertion holds
		// regardless: 4 × 50 rows, no corruption. A direct-`table.query()`
		// concurrent test that bypasses the exec mutex belongs alongside the
		// first FanOutLookupJoin consumer that actually parallel-drives the
		// vtab.
		it('produces correct cardinality across 4 concurrent select iterators', async () => {
			const db = new Database();
			try {
				await db.exec('create table t (id integer primary key, v integer)');
				for (let i = 0; i < 50; i++) {
					await db.exec(`insert into t values (${i}, ${i * 2})`);
				}

				const collectAll = async () => {
					const rows: Array<{ id: number; v: number }> = [];
					for await (const row of db.eval('select id, v from t')) {
						rows.push(row as unknown as { id: number; v: number });
					}
					return rows;
				};

				const results = await Promise.all([
					collectAll(), collectAll(), collectAll(), collectAll(),
				]);

				const total = results.reduce((n, r) => n + r.length, 0);
				expect(total).to.equal(4 * 50);

				for (const rows of results) {
					expect(rows).to.have.length(50);
					// Spot-check a couple of rows to catch row-shape corruption.
					expect(rows[0].id).to.equal(0);
					expect(rows[0].v).to.equal(0);
					expect(rows[49].id).to.equal(49);
					expect(rows[49].v).to.equal(98);
				}
			} finally {
				await db.close();
			}
		});
	});
});
