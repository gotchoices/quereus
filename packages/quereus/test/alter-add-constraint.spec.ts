/**
 * Tests for `ALTER TABLE ADD CONSTRAINT` routing + enforcement.
 *
 * CHECK constraints stay in Quereus's emitter (`runtime/emit/add-constraint.ts`)
 * and mutate the schema's `checkConstraints` array directly. Non-CHECK
 * constraints (UNIQUE / FOREIGN KEY) route through the vtab module's
 * `alterTable({ type: 'addConstraint', constraint })`. The built-in
 * `MemoryTableModule` implements both: it re-validates the existing rows and
 * fails atomically with `CONSTRAINT` (no schema mutation) when the current data
 * violates the new constraint, otherwise installs forward enforcement.
 */

import { expect } from 'chai';
import { Database } from '../src/index.js';
import { QuereusError } from '../src/common/errors.js';
import { StatusCode } from '../src/common/types.js';

async function expectThrows(fn: () => Promise<unknown>): Promise<QuereusError> {
	let caught: unknown;
	try {
		await fn();
	} catch (e) {
		caught = e;
	}
	expect(caught, 'expected an error to be thrown').to.be.instanceOf(QuereusError);
	return caught as QuereusError;
}

describe('ALTER TABLE ADD CONSTRAINT', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it('CHECK constraint succeeds (in-emitter metadata mutation)', async () => {
		await db.exec('create table t (id integer primary key, v integer)');
		await db.exec('alter table t add constraint pos_v check (v > 0)');
		// Forward enforcement still works.
		const err = await expectThrows(() => db.exec('insert into t (id, v) values (1, -1)'));
		expect(err.code).to.equal(StatusCode.CONSTRAINT);
	});

	describe('UNIQUE', () => {
		it('adds over conforming data and enforces going forward', async () => {
			await db.exec('create table t (id integer primary key, email text)');
			await db.exec("insert into t values (1, 'a@x'), (2, 'b@x')");
			await db.exec('alter table t add constraint u_email unique (email)');

			// Forward enforcement: a duplicate now fails.
			const err = await expectThrows(() => db.exec("insert into t values (3, 'a@x')"));
			expect(err.code).to.equal(StatusCode.CONSTRAINT);

			// The covering index surfaces in introspection.
			const rows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval("select count(*) as c from unique_constraint_info('t') where name = 'u_email'")) {
				rows.push(r);
			}
			expect(rows).to.deep.equal([{ c: 1 }]);
		});

		it('rejects an add over duplicated existing data and leaves the constraint absent', async () => {
			await db.exec('create table t (id integer primary key, email text)');
			await db.exec("insert into t values (1, 'a@x'), (2, 'a@x')"); // duplicate

			const err = await expectThrows(() => db.exec('alter table t add constraint u_email unique (email)'));
			expect(err.code).to.equal(StatusCode.CONSTRAINT);

			// Not installed: the constraint is absent from introspection...
			const rows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval("select count(*) as c from unique_constraint_info('t') where name = 'u_email'")) {
				rows.push(r);
			}
			expect(rows, 'constraint must be absent after the failed add').to.deep.equal([{ c: 0 }]);

			// ...and enforcement is not active: another duplicate inserts freely.
			await db.exec("insert into t values (3, 'a@x')");
			const cnt: Array<Record<string, unknown>> = [];
			for await (const r of db.eval('select count(*) as c from t')) cnt.push(r);
			expect(cnt).to.deep.equal([{ c: 3 }]);
		});

		it('succeeds on retry after the offending rows are removed', async () => {
			await db.exec('create table t (id integer primary key, email text)');
			await db.exec("insert into t values (1, 'a@x'), (2, 'a@x')"); // duplicate

			// First add fails atomically over the duplicate.
			const err = await expectThrows(() => db.exec('alter table t add constraint u_email unique (email)'));
			expect(err.code).to.equal(StatusCode.CONSTRAINT);

			// Remove the offending row, then re-run the SAME add — it now converges.
			// (This exercises the DELETE-after-schema-change → consolidation path that the
			// memory base layer must replace, not union, into its primary tree.)
			await db.exec('delete from t where id = 2');
			await db.exec('alter table t add constraint u_email unique (email)');

			// The constraint is now installed and enforces going forward.
			const rows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval("select count(*) as c from unique_constraint_info('t') where name = 'u_email'")) {
				rows.push(r);
			}
			expect(rows, 'constraint present after the successful retry').to.deep.equal([{ c: 1 }]);
			const dupErr = await expectThrows(() => db.exec("insert into t values (3, 'a@x')"));
			expect(dupErr.code).to.equal(StatusCode.CONSTRAINT);
		});

		it('allows multiple existing NULLs (NULLs distinct)', async () => {
			await db.exec('create table t (id integer primary key, email text null)');
			await db.exec('insert into t values (1, null), (2, null)');
			// Two NULLs do not collide — the add succeeds.
			await db.exec('alter table t add constraint u_email unique (email)');
			await db.exec('insert into t values (3, null)'); // still allowed post-add
		});

		it('accepts the unnamed ADD UNIQUE (...) form', async () => {
			await db.exec('create table t (id integer primary key, email text)');
			await db.exec("insert into t values (1, 'a@x')");
			await db.exec('alter table t add unique (email)');
			const err = await expectThrows(() => db.exec("insert into t values (2, 'a@x')"));
			expect(err.code).to.equal(StatusCode.CONSTRAINT);
		});

		it('reuses an existing unique index over the same columns (no rebuilt covering index)', async () => {
			await db.exec('create table t (id integer primary key, email text)');
			await db.exec("insert into t values (1, 'a@x'), (2, 'b@x')");
			await db.exec('create unique index ue on t (email)');

			// The explicit UNIQUE add reuses the user's unique index rather than building
			// a second covering structure.
			await db.exec('alter table t add constraint uq unique (email)');
			const t = db.schemaManager.getTable('main', 't')!;
			expect(t.indexes?.map(i => i.name), 'no extra covering index built').to.deep.equal(['ue']);

			// Dropping the constraint must NOT tear down the user's own index.
			await db.exec('alter table t drop constraint uq');
			const t2 = db.schemaManager.getTable('main', 't')!;
			expect(t2.indexes?.map(i => i.name), "user's unique index survives the drop").to.deep.equal(['ue']);
			const err = await expectThrows(() => db.exec("insert into t values (3, 'b@x')"));
			expect(err.code, 'user unique index still enforces').to.equal(StatusCode.CONSTRAINT);
		});
	});

	describe('FOREIGN KEY', () => {
		beforeEach(async () => {
			await db.exec('pragma foreign_keys = true');
			await db.exec('create table parent (pid integer primary key)');
			await db.exec('insert into parent values (1), (2)');
		});

		it('adds over satisfied data and enforces going forward', async () => {
			await db.exec('create table child (id integer primary key, pa integer)');
			await db.exec('insert into child values (1, 1), (2, 2)');
			await db.exec('alter table child add constraint fk_pa foreign key (pa) references parent(pid)');

			// Forward enforcement: an orphan insert now fails.
			const err = await expectThrows(() => db.exec('insert into child values (3, 99)'));
			expect(err.code).to.equal(StatusCode.CONSTRAINT);
		});

		it('allows a NULL FK child row (MATCH SIMPLE)', async () => {
			await db.exec('create table child (id integer primary key, pa integer null)');
			await db.exec('insert into child values (1, null), (2, 1)');
			// NULL FK rows are exempt; the add succeeds.
			await db.exec('alter table child add constraint fk_pa foreign key (pa) references parent(pid)');
			await db.exec('insert into child values (3, null)'); // still allowed post-add
		});

		it('rejects an add when an existing child row is an orphan', async () => {
			await db.exec('create table child (id integer primary key, pa integer)');
			await db.exec('insert into child values (1, 1), (2, 99)'); // 99 has no parent

			const err = await expectThrows(() => db.exec('alter table child add constraint fk_pa foreign key (pa) references parent(pid)'));
			expect(err.code).to.equal(StatusCode.CONSTRAINT);

			// Not installed: a further orphan inserts freely.
			await db.exec('insert into child values (3, 77)');
		});

		it('skips validation when pragma foreign_keys = false', async () => {
			await db.exec('pragma foreign_keys = false');
			await db.exec('create table child (id integer primary key, pa integer)');
			await db.exec('insert into child values (1, 99)'); // orphan, but unvalidated

			// The add succeeds despite the orphan (no validating scan).
			await db.exec('alter table child add constraint fk_pa foreign key (pa) references parent(pid)');
		});
	});
});
