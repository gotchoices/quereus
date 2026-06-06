import { expect } from 'chai';
import { AsyncSemaphore } from '../../src/runtime/async-semaphore.js';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

describe('AsyncSemaphore', () => {
	it('rejects non-positive / non-integer permits', () => {
		expect(() => new AsyncSemaphore(0)).to.throw(RangeError);
		expect(() => new AsyncSemaphore(-1)).to.throw(RangeError);
		expect(() => new AsyncSemaphore(1.5)).to.throw(RangeError);
	});

	it('acquires immediately while permits are available', async () => {
		const sem = new AsyncSemaphore(2);
		expect(sem.availablePermits).to.equal(2);
		const r1 = await sem.acquire();
		expect(sem.availablePermits).to.equal(1);
		const r2 = await sem.acquire();
		expect(sem.availablePermits).to.equal(0);
		r1();
		r2();
		expect(sem.availablePermits).to.equal(2);
	});

	it('blocks a third acquirer until a permit is released', async () => {
		const sem = new AsyncSemaphore(2);
		const r1 = await sem.acquire();
		await sem.acquire();
		let thirdResolved = false;
		const third = sem.acquire().then(rel => { thirdResolved = true; return rel; });
		await sleep(10);
		expect(thirdResolved, 'third acquirer must block while at capacity').to.equal(false);
		expect(sem.waiterCount).to.equal(1);
		r1();
		const r3 = await third;
		expect(thirdResolved).to.equal(true);
		expect(sem.waiterCount).to.equal(0);
		r3();
	});

	it('hands permits to waiters in FIFO order', async () => {
		const sem = new AsyncSemaphore(1);
		const r0 = await sem.acquire();
		const order: number[] = [];
		const w1 = sem.acquire().then(rel => { order.push(1); return rel; });
		const w2 = sem.acquire().then(rel => { order.push(2); return rel; });
		const w3 = sem.acquire().then(rel => { order.push(3); return rel; });
		expect(sem.waiterCount).to.equal(3);

		// Release once: head waiter (1) gets it.
		r0();
		const r1 = await w1;
		expect(order).to.deep.equal([1]);
		// Release again: next waiter (2).
		r1();
		const r2 = await w2;
		expect(order).to.deep.equal([1, 2]);
		r2();
		const r3 = await w3;
		expect(order).to.deep.equal([1, 2, 3]);
		r3();
		expect(sem.availablePermits).to.equal(1);
	});

	it('double-release is a no-op (does not inflate permit count)', async () => {
		const sem = new AsyncSemaphore(1);
		const rel = await sem.acquire();
		rel();
		rel(); // second call must be ignored
		expect(sem.availablePermits).to.equal(1);
	});

	it('caps concurrent holders under a flood of acquirers', async () => {
		const cap = 3;
		const sem = new AsyncSemaphore(cap);
		let inFlight = 0;
		let peak = 0;
		const task = async () => {
			const rel = await sem.acquire();
			inFlight++;
			peak = Math.max(peak, inFlight);
			await sleep(5);
			inFlight--;
			rel();
		};
		await Promise.all(Array.from({ length: 20 }, () => task()));
		expect(peak).to.be.at.most(cap, `semaphore did not cap concurrency: peak=${peak}`);
		expect(sem.availablePermits).to.equal(cap);
	});
});
