/**
 * Regression: a frozen layer — an eager savepoint snapshot (`MemoryTableConnection.createSavepoint`)
 * or a newly committed head — used to leave its B-trees linked to their inheritree base, and the
 * next pending layer's trees were built over them. So the base chain grew one link per statement
 * inside a transaction (each DML statement opens a statement savepoint), one link per row under
 * `insert or fail` (a savepoint per row, autocommit included), and one link per autocommit
 * statement. inheritree walks that chain recursively on every tree access, so cost grew
 * quadratically and past roughly 15,600 links the walk overflowed the stack ("Maximum call stack
 * size exceeded"). An in-transaction ALTER or CREATE INDEX, which rebuilds open layers' trees over
 * their parents', relinked the chain the same way.
 *
 * Sizes here sit above that threshold; each case runs in about two seconds or less once the chain
 * stays shallow.
 */
import { expect } from 'chai';
import { Database } from '../../src/core/database.js';

describe('frozen memory-table layers keep the B-tree chain shallow', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it('runs 30,000 single-row inserts in one transaction, rolls back to a mid-way savepoint, then alters and indexes the table', async () => {
		await db.exec('create table big (id integer primary key, v text)');
		await db.exec('create index big_v on big(v)');
		const insert = db.prepare('insert into big values (?, ?)');

		await db.exec('begin');
		for (let i = 1; i <= 20_000; i++) await insert.run([i, `v${i}`]);
		await db.exec('savepoint sp');
		for (let i = 20_001; i <= 30_000; i++) await insert.run([i, `v${i}`]);
		await insert.finalize();
		expect((await db.get('select count(*) as n from big'))?.n).to.equal(30_000);

		await db.exec('rollback to sp');
		expect((await db.get('select count(*) as n from big'))?.n).to.equal(20_000);

		// Both rebuild every open layer's trees over its parent's: the column add all of them,
		// the index build the new index's.
		await db.exec('alter table big add column w integer default 7');
		await db.exec('create index big_vw on big(v, w)');
		await db.exec('commit');

		expect(await db.get('select count(*) as n, sum(id) as s, sum(w) as sw from big'))
			.to.deep.equal({ n: 20_000, s: 200_010_000, sw: 140_000 });
		expect((await db.get("select id from big where v = 'v54' and w = 7"))?.id).to.equal(54);
		expect((await db.get("select id from big where v = 'v12345'"))?.id).to.equal(12_345);
		expect(await db.get("select id from big where v = 'v25000'")).to.equal(undefined);
	});

	it('runs 20,000 autocommit single-row inserts', async () => {
		// Each autocommit statement commits a new head that the next statement's layer builds
		// over — the same per-statement growth, on the commit path.
		await db.exec('create table big (id integer primary key, v text)');
		const insert = db.prepare('insert into big values (?, ?)');
		for (let i = 1; i <= 20_000; i++) await insert.run([i, `v${i}`]);
		await insert.finalize();
		expect((await db.get('select count(*) as n from big'))?.n).to.equal(20_000);
	});

	it('runs a 30,000-row insert or fail ... select in autocommit', async () => {
		await db.exec('create table big (id integer primary key, v text)');
		await db.exec("insert or fail into big select value, 'x' from generate_series(1, 30000)");
		expect(await db.get('select count(*) as n, sum(id) as s from big'))
			.to.deep.equal({ n: 30_000, s: 450_015_000 });
	});
});
