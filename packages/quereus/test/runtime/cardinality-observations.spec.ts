/**
 * Cardinality feedback, execution half: a scan that reads its whole table reports the
 * exact count, a scan that reads part of it reports a floor, and only observations of
 * committed state reach the overlay — one made inside a transaction waits for its commit
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

	function lowerBoundBig(): number | undefined {
		return db._cardinalityFeedback.snapshot().find(entry => entry.tableName === 'big')?.atLeast;
	}

	it('records the exact size of a table read in full', async () => {
		await drain('select * from big');
		expect(observedBig()).to.equal(20_000);
	});

	it('records nothing when a LIMIT stops the scan early', async () => {
		await drain('select * from big limit 10');
		expect(observedBig()).to.equal(undefined);
	});

	it('records the rows a LIMIT let through as a floor, not a count', async () => {
		await drain('select * from big limit 5000');
		expect(lowerBoundBig()).to.be.at.least(5000);
		expect(observedBig()).to.equal(undefined);
	});

	it('records the rows a secondary-index range seek yielded as a floor', async () => {
		await db.exec('create index big_v on big (v)');
		await drain('select * from big where v between 1 and 6000');
		expect(lowerBoundBig()).to.equal(6000);
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

	// The scan counts 20,001; the delete then cancels the insert in the change log, which
	// must still name `big` as written or the inflated count would be recorded.
	it('drops the scan of a table the committing transaction wrote, even net-unchanged', async () => {
		await db.exec('begin; insert into big values (20001, 0); select * from big; delete from big where id = 20001; commit;');
		expect(observedBig()).to.equal(undefined);
	});

	// The statement's correlated scan of `big` completes after four of its inserts; the
	// fifth row's conflict rolls them back through the statement savepoint, before the
	// statement's observations are published, and the transaction still commits.
	it('discards a failed statement\'s scans that saw its rolled-back writes', async () => {
		await db.exec('create table small (id integer primary key)');
		await db.exec('insert into small values (1), (2), (3), (4), (5)');
		await db.exec('begin');
		await db.exec(`insert into big select case when s.id = 5 then 1 else s.id + 100000 end,
			(select count(*) from big b where b.v + s.id > s.id) from small s`).then(
			() => expect.fail('expected a primary-key conflict'),
			(e: Error) => expect(e.message).to.match(/UNIQUE/));
		await db.exec('commit');
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
