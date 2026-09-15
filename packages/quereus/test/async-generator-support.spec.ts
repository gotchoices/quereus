/**
 * Guards the host self-check that refuses environments whose async generators
 * drop `finally` cleanup after an `await` on an early `return()` (the
 * pre-7.29.2 Babel `wrapAsyncGenerator` helper, i.e. stale React Native
 * bundles). Node runs generators natively, so the real probe only passes here;
 * the refusal and its memoization are pinned through an injected probe.
 */
import { expect } from 'chai';
import {
	createAsyncGeneratorCleanupCheck,
	ensureAsyncGeneratorCleanupSupported,
	probeAsyncGeneratorCleanup,
} from '../src/util/async-generator-support.js';
import { Database } from '../src/index.js';
import { QuereusError } from '../src/common/errors.js';
import { StatusCode } from '../src/common/types.js';

function countingProbe(verdict: boolean): { probe: () => Promise<boolean>; runs: () => number } {
	let runs = 0;
	return {
		probe: async () => {
			runs++;
			return verdict;
		},
		runs: () => runs,
	};
}

describe('async generator cleanup self-check', () => {
	it('probe sees finally code after an await run on early return()', async () => {
		expect(await probeAsyncGeneratorCleanup()).to.equal(true);
	});

	it('resolves once, then answers synchronously', async () => {
		const first = ensureAsyncGeneratorCleanupSupported();
		if (first) await first;
		expect(ensureAsyncGeneratorCleanupSupported()).to.equal(undefined);
	});

	it('shares one probe run across concurrent first callers', async () => {
		const { probe, runs } = countingProbe(true);
		const check = createAsyncGeneratorCleanupCheck(probe);
		const first = check();
		expect(check()).to.equal(first);
		await first;
		expect(check()).to.equal(undefined);
		expect(runs()).to.equal(1);
	});

	it('refuses a failing host with UNSUPPORTED on every call without re-probing', async () => {
		const { probe, runs } = countingProbe(false);
		const check = createAsyncGeneratorCleanupCheck(probe);
		for (let i = 0; i < 2; i++) {
			const outcome = check();
			expect(outcome, 'a failed verdict never takes the sync fast path').to.be.instanceOf(Promise);
			const error = await outcome!.then(() => undefined, (e: unknown) => e);
			expect(error).to.be.instanceOf(QuereusError);
			expect((error as QuereusError).code).to.equal(StatusCode.UNSUPPORTED);
			expect((error as QuereusError).message).to.contain('7.29.2');
		}
		expect(runs()).to.equal(1);
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
