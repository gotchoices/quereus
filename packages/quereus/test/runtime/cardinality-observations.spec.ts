/**
 * Cardinality feedback, execution half: a scan that reads its whole table reports the
 * exact count, and only a committed, complete enumeration reaches the overlay — one made
 * inside a transaction waits for its commit (docs/progressive-optimizer.md §3.1, §3.5).
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

	it('holds a full scan made inside a transaction until it commits', async () => {
		await db.exec('begin; select * from big;');
		expect(observedBig()).to.equal(undefined);
		await db.exec('commit');
		expect(observedBig()).to.equal(20_000);
	});

	// The empty transaction afterwards is a commit that would apply anything still held.
	it('forgets a full scan made inside a transaction that rolls back', async () => {
		await db.exec('begin; select * from big; rollback; begin; commit;');
		expect(observedBig()).to.equal(undefined);
	});

	// Observed after the delete, so 19,990 happens to be right — but the change log
	// cannot order the scan against the transaction's writes, so a written table is dropped.
	it('drops the scan of a table the committing transaction wrote', async () => {
		await db.exec('begin; delete from big where id <= 10; select * from big; commit;');
		expect(observedBig()).to.equal(undefined);
	});

	// The delete's scan completes with 20,000 rows before the implicit transaction
	// commits an empty table; recording it would remember a size that no longer exists.
	it('drops a writing statement\'s scan of its own target', async () => {
		await db.exec('delete from big');
		expect(observedBig()).to.equal(undefined);
	});

	it('records a writing statement\'s scan of another table at its commit', async () => {
		await db.exec('create table t2 (id integer primary key, v integer)');
		await db.exec('insert into t2 select * from big');
		expect(observedBig()).to.equal(20_000);
	});

	it('records nothing with the option off', async () => {
		await db.exec('pragma cardinality_feedback = false');
		await drain('select * from big');
		expect(observedBig()).to.equal(undefined);
	});
});
