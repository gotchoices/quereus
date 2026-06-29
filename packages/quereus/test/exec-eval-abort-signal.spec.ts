/**
 * Engine-level contract for cooperative cancellation of `Database.exec` and
 * `Database.eval` via an `AbortSignal` passed as the 3rd options argument.
 *
 * A downstream backend wires request-timeout cancellation through this API: it
 * hands the engine an `AbortSignal` and expects in-flight work to reject with an
 * `AbortError` (which is a `QuereusError` with `StatusCode.ABORT`, and also
 * carries the web-convention `name === 'AbortError'`). This spec pins:
 *   1. A pre-aborted signal rejects immediately, before any rows are produced.
 *   2. An abort fired mid-stream interrupts iteration at the next row boundary.
 *   3. `exec` is interrupted mid-scan (not only at statement boundaries).
 *   4. The signal's `reason` is preserved on the thrown error.
 *   5. The 2-arg form (no options) keeps working unchanged.
 */

import { expect } from 'chai';
import { Database } from '../src/index.js';
import { AbortError, QuereusError } from '../src/common/errors.js';
import { StatusCode, type SqlValue } from '../src/common/types.js';

describe('exec/eval AbortSignal cancellation', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, v integer);');
		await db.exec('insert into t values (1, 10), (2, 20), (3, 30), (4, 40), (5, 50);');
	});

	afterEach(async () => {
		await db.close();
	});

	it('eval rejects immediately on a pre-aborted signal', async () => {
		const controller = new AbortController();
		controller.abort();

		const rows: unknown[] = [];
		let caught: unknown;
		try {
			for await (const row of db.eval('select * from t', [], { signal: controller.signal })) {
				rows.push(row);
			}
		} catch (e) {
			caught = e;
		}

		expect(rows).to.have.length(0);
		expect(caught).to.be.instanceOf(AbortError);
		expect((caught as QuereusError).code).to.equal(StatusCode.ABORT);
		expect((caught as Error).name).to.equal('AbortError');
	});

	it('eval interrupts iteration at the next row boundary when aborted mid-stream', async () => {
		const controller = new AbortController();

		const seen: number[] = [];
		let caught: unknown;
		try {
			for await (const row of db.eval('select id from t order by id', [], { signal: controller.signal })) {
				seen.push(row.id as number);
				if (seen.length === 2) controller.abort();
			}
		} catch (e) {
			caught = e;
		}

		// Consumed the first two rows, then the abort halts the scan before the rest.
		expect(seen).to.deep.equal([1, 2]);
		expect(caught).to.be.instanceOf(AbortError);
	});

	it('exec rejects immediately on a pre-aborted signal (no side effects)', async () => {
		const controller = new AbortController();
		controller.abort();

		let caught: unknown;
		try {
			await db.exec('insert into t values (6, 60)', [], { signal: controller.signal });
		} catch (e) {
			caught = e;
		}

		expect(caught).to.be.instanceOf(AbortError);

		const remaining = [];
		for await (const row of db.eval('select id from t where id = 6')) remaining.push(row);
		expect(remaining).to.have.length(0);
	});

	it('exec is interrupted mid-scan when the signal fires during execution', async () => {
		const controller = new AbortController();

		// A non-deterministic scalar function that trips the abort once a row has
		// been scanned. The next row's scan checkpoint then rejects the statement.
		let calls = 0;
		db.createScalarFunction(
			'trip',
			{ numArgs: 1, deterministic: false },
			(v: SqlValue) => {
				if (++calls === 1) controller.abort();
				return v;
			}
		);

		await db.exec('create table dest (id integer primary key, v integer);');

		let caught: unknown;
		try {
			await db.exec('insert into dest select id, trip(v) from t order by id', [], { signal: controller.signal });
		} catch (e) {
			caught = e;
		}

		expect(caught).to.be.instanceOf(AbortError);

		// The implicit transaction rolled back: no rows landed in dest.
		const landed = [];
		for await (const row of db.eval('select * from dest')) landed.push(row);
		expect(landed).to.have.length(0);
	});

	it('preserves the abort reason on the thrown error', async () => {
		const controller = new AbortController();
		const reason = new Error('request timeout');
		controller.abort(reason);

		let caught: unknown;
		try {
			for await (const _ of db.eval('select * from t', [], { signal: controller.signal })) { /* drain */ }
		} catch (e) {
			caught = e;
		}

		expect(caught).to.be.instanceOf(AbortError);
		expect((caught as Error).message).to.equal('request timeout');
		expect((caught as QuereusError).cause).to.equal(reason);
	});

	it('still works with the 2-arg form (no options)', async () => {
		await db.exec('insert into t values (6, 60)');
		const ids: number[] = [];
		for await (const row of db.eval('select id from t order by id')) ids.push(row.id as number);
		expect(ids).to.deep.equal([1, 2, 3, 4, 5, 6]);
	});
});
