/**
 * Guards the host self-check that refuses environments whose async generators
 * drop `finally` cleanup after an `await` on an early `return()` (the
 * pre-7.29.2 Babel `wrapAsyncGenerator` helper, i.e. stale React Native
 * bundles). Node runs generators natively, so only the passing path and the
 * memoized fast path are observable here; the failing path is exercised by
 * the probe's contract, not by simulating the broken helper.
 */
import { expect } from 'chai';
import {
	ensureAsyncGeneratorCleanupSupported,
	probeAsyncGeneratorCleanup,
} from '../src/util/async-generator-support.js';
import { Database } from '../src/index.js';

describe('async generator cleanup self-check', () => {
	it('probe sees finally code after an await run on early return()', async () => {
		expect(await probeAsyncGeneratorCleanup()).to.equal(true);
	});

	it('resolves once, then answers synchronously', async () => {
		const first = ensureAsyncGeneratorCleanupSupported();
		if (first) await first;
		expect(ensureAsyncGeneratorCleanupSupported()).to.equal(undefined);
	});

	it('does not disturb exec mutex ordering across concurrent statements', async () => {
		const db = new Database();
		await db.exec('create table t (x integer primary key)');
		const order: number[] = [];
		await Promise.all([1, 2, 3].map(async n => {
			await db.exec(`insert into t values (${n})`);
			order.push(n);
		}));
		expect(order).to.deep.equal([1, 2, 3]);
		await db.close();
	});
});
