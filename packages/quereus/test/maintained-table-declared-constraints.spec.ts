import { expect } from 'chai';
import { Database } from '../src/index.js';

/**
 * Declared-constraint pins for maintained-table derivation writes that
 * sqllogic cannot express (ticket
 * maintained-table-derivation-check-fk-validation; the SQL-level behaviors
 * live in test/logic/51.8-maintained-table-declared-constraints.sqllogic):
 *
 *  - zero-overhead gate: a steady-state source write covering a
 *    CONSTRAINT-LESS maintained table (and an MV-sugar table) performs no
 *    validation work — no statement prepare, no deferred-constraint enqueue;
 *  - deferral parity inside an explicit transaction: an orphan-producing
 *    source write is admitted mid-transaction and validates at COMMIT against
 *    final state (a parent arriving before commit satisfies it; an unresolved
 *    orphan fails the commit with the maintained-table attribution and rolls
 *    the whole transaction back);
 *  - cascade attribution: a two-level chain (base → mt1 → mt2) attributes a
 *    violation to the CONSUMER that declares the constraint, not the producer.
 */
describe('Maintained-table declared-constraint validation', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	async function readAll(sql: string): Promise<Record<string, unknown>[]> {
		const rows: Record<string, unknown>[] = [];
		for await (const row of db.eval(sql)) rows.push({ ...row });
		return rows;
	}

	async function expectError(sql: string, messagePart: string): Promise<void> {
		try {
			await db.exec(sql);
		} catch (e) {
			expect((e as Error).message).to.contain(messagePart);
			return;
		}
		expect.fail(`expected '${sql}' to fail with: ${messagePart}`);
	}

	describe('zero-overhead gate', () => {
		it('a source write to a constraint-less maintained table prepares nothing and defers nothing', async () => {
			await db.exec(`
				create table src (id integer primary key, v text not null);
				create table mt (id integer primary key, v text not null) maintained as select id, v from src;
			`);
			let prepares = 0;
			let deferred = 0;
			const origPrepare = db.prepare.bind(db);
			const origQueue = db._queueDeferredConstraintRow.bind(db);
			db.prepare = ((sql: string) => { prepares++; return origPrepare(sql); }) as typeof db.prepare;
			db._queueDeferredConstraintRow = ((...args: Parameters<typeof origQueue>) => {
				deferred++;
				return origQueue(...args);
			}) as typeof db._queueDeferredConstraintRow;
			try {
				await db.exec(`insert into src values (1, 'a')`);
			} finally {
				db.prepare = origPrepare;
				db._queueDeferredConstraintRow = origQueue;
			}
			expect(prepares, 'no validation prepare on the write path').to.equal(0);
			expect(deferred, 'no deferred-constraint enqueue').to.equal(0);
			expect(await readAll('select count(*) as n from mt')).to.deep.equal([{ n: 1 }]);
		});

		it('an MV-sugar table (empty constraint set by construction) likewise validates nothing', async () => {
			await db.exec(`
				create table src (id integer primary key, v text not null);
				create materialized view mv1 as select id, v from src;
			`);
			let deferred = 0;
			const origQueue = db._queueDeferredConstraintRow.bind(db);
			db._queueDeferredConstraintRow = ((...args: Parameters<typeof origQueue>) => {
				deferred++;
				return origQueue(...args);
			}) as typeof db._queueDeferredConstraintRow;
			try {
				await db.exec(`insert into src values (1, 'a')`);
			} finally {
				db._queueDeferredConstraintRow = origQueue;
			}
			expect(deferred).to.equal(0);
			expect(await readAll('select count(*) as n from mv1')).to.deep.equal([{ n: 1 }]);
		});

		it('a declared child-side FK DOES enqueue a deferred check per written image', async () => {
			await db.exec(`
				create table parent (pid integer primary key);
				create table src (id integer primary key, ref integer null);
				create table mt (id integer primary key, ref integer null references parent(pid))
					maintained as select id, ref from src;
				insert into parent values (1);
			`);
			let deferred = 0;
			const origQueue = db._queueDeferredConstraintRow.bind(db);
			db._queueDeferredConstraintRow = ((...args: Parameters<typeof origQueue>) => {
				deferred++;
				return origQueue(...args);
			}) as typeof db._queueDeferredConstraintRow;
			try {
				await db.exec(`insert into src values (1, 1)`);
			} finally {
				db._queueDeferredConstraintRow = origQueue;
			}
			expect(deferred, 'one FK existence check queued for the one derived image').to.equal(1);
		});
	});

	describe('deferred validation at commit (explicit transaction)', () => {
		beforeEach(async () => {
			await db.exec(`
				create table parent (pid integer primary key);
				create table src (id integer primary key, ref integer null);
				create table mt (id integer primary key, ref integer null references parent(pid))
					maintained as select id, ref from src;
			`);
		});

		it('an orphan admitted mid-transaction is satisfied by a parent arriving before commit', async () => {
			await db.exec('begin');
			await db.exec(`insert into src values (1, 42)`); // parent 42 does not exist yet
			await db.exec(`insert into parent values (42)`);
			await db.exec('commit');
			expect(await readAll('select * from mt')).to.deep.equal([{ id: 1, ref: 42 }]);
		});

		it('an unresolved orphan fails the COMMIT with maintained-table attribution and rolls back whole', async () => {
			await db.exec('begin');
			await db.exec(`insert into src values (2, 99)`);
			await expectError('commit', `row derived into maintained table 'main.mt' references a missing 'main.parent'`);
			expect(await readAll('select count(*) as n from src')).to.deep.equal([{ n: 0 }]);
			expect(await readAll('select count(*) as n from mt')).to.deep.equal([{ n: 0 }]);
		});

		it('a subquery-bearing CHECK defers to commit and carries the attribution', async () => {
			await db.exec(`
				create table quota (k integer primary key, lim integer not null);
				insert into quota values (1, 1);
				create table qsrc (id integer primary key, n integer not null);
				create table mq (id integer primary key, n integer not null
					check (n <= (select lim from quota where k = 1)))
					maintained as select id, n from qsrc;
			`);
			await db.exec('begin');
			await db.exec(`insert into qsrc values (1, 5)`); // violates against current quota
			await db.exec(`update quota set lim = 10 where k = 1`); // …but final state satisfies
			await db.exec('commit');
			expect(await readAll('select count(*) as n from mq')).to.deep.equal([{ n: 1 }]);

			await db.exec('begin');
			await db.exec(`insert into qsrc values (2, 50)`);
			await expectError('commit', `row derived into maintained table 'main.mq'`);
			expect(await readAll('select count(*) as n from qsrc')).to.deep.equal([{ n: 1 }]);
		});
	});

	describe('cascade attribution', () => {
		it('a two-level chain attributes the violation to the consumer that declares the constraint', async () => {
			await db.exec(`
				create table base (id integer primary key, v text not null);
				create table mt1 (id integer primary key, v text not null) maintained as select id, v from base;
				create table mt2 (id integer primary key, v text not null check (v <> 'poison'))
					maintained as select id, v from mt1;
			`);
			await expectError(
				`insert into base values (1, 'poison')`,
				`row derived into maintained table 'main.mt2'`,
			);
			// the producer level was rolled back with the statement
			expect(await readAll('select count(*) as n from mt1')).to.deep.equal([{ n: 0 }]);
		});
	});
});
