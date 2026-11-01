/**
 * Cardinality feedback, execution half: a scan that reads its whole table reports the
 * exact count, and only a committed, complete enumeration reaches the overlay
 * (docs/progressive-optimizer.md §3.1, §3.5).
 *
 * `big` is 20,000 rows and never analyzed, so every observation clears the overlay's
 * record floor; an absent entry therefore means "not observed", never "too small".
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';

describe('Cardinality feedback scan observations', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('pragma auto_analyze = false');
		await db.exec('pragma cardinality_feedback = true');
		await db.exec('create table big (id integer primary key, v integer)');
		await db.exec('insert into big select value, value from generate_series(1, 20000)');
	});

	afterEach(async () => {
		await db.close();
	});

	async function drain(sql: string): Promise<void> {
		for await (const _row of db.eval(sql)) { /* drain */ }
	}

	function observedBig(): number | undefined {
		return db._cardinalityFeedback.snapshot().find(entry => entry.tableName === 'big')?.rows;
	}

	it('records the exact size of a table read in full', async () => {
		await drain('select * from big');
		expect(observedBig()).to.equal(20_000);
	});

	it('records nothing when a LIMIT stops the scan early', async () => {
		await drain('select * from big limit 10');
		expect(observedBig()).to.equal(undefined);
	});

	it('records nothing for a primary-key point seek', async () => {
		await drain('select * from big where id = 5');
		expect(observedBig()).to.equal(undefined);
	});

	it('discards a full scan made inside an open transaction', async () => {
		await db.exec('begin; select * from big; commit;');
		expect(observedBig()).to.equal(undefined);
	});

	it('records nothing with the option off', async () => {
		await db.exec('pragma cardinality_feedback = false');
		await drain('select * from big');
		expect(observedBig()).to.equal(undefined);
	});
});
