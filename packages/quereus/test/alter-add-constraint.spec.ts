/**
 * Tests for `ALTER TABLE ADD CONSTRAINT` routing + enforcement.
 *
 * All three constraint classes (CHECK / UNIQUE / FOREIGN KEY) route through the
 * vtab module's `alterTable({ type: 'addConstraint', constraint })` when the module
 * supports it, so the module-cached schema stays in lock-step with the catalog
 * (a later DROP/RENAME CONSTRAINT resolves the class against it). CHECK keeps an
 * engine-side fallback (`runtime/emit/add-constraint.ts`) only for modules that
 * omit `alterTable`. All three classes re-validate the existing rows and fail
 * atomically with `CONSTRAINT` (no schema mutation) when the current data violates the
 * new constraint: the built-in `MemoryTableModule` scans for UNIQUE / FOREIGN KEY, and
 * the engine scans for CHECK pre-dispatch on every module (the second describe below).
 */

import { expect } from 'chai';
import { Database, MemoryTableModule } from '../src/index.js';
import type { ModuleCapabilities } from '../src/index.js';
import type { SqlValue } from '../src/common/types.js';
import { QuereusError } from '../src/common/errors.js';
import { StatusCode } from '../src/common/types.js';
import { validateChecksOverExistingRows } from '../src/schema/constraint-builder.js';
import { makeNoAlterModule } from './no-alter-module.js';

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

	it('CHECK constraint on an empty table succeeds and is enforced forward', async () => {
		await db.exec('create table t (id integer primary key, v integer)');
		await db.exec('alter table t add constraint pos_v check (v > 0)');
		// Forward enforcement still works.
		const err = await expectThrows(() => db.exec('insert into t (id, v) values (1, -1)'));
		expect(err.code).to.equal(StatusCode.CONSTRAINT);
	});

	// Regression: an ALTER-added CHECK must land in the *module-cached* schema, not
	// just the catalog — otherwise DROP/RENAME CONSTRAINT (which resolve the class
	// through the module) reported it missing, and a later module-routed ALTER
	// silently dropped it from the catalog.
	it('an ALTER-added CHECK can be dropped by name', async () => {
		await db.exec('create table t (id integer primary key, v integer)');
		await db.exec('alter table t add constraint chk check (v > 10)');
		await db.exec('alter table t drop constraint chk');
		expect(db.schemaManager.getTable('main', 't')!.checkConstraints.map(c => c.name)).to.deep.equal([]);
		// Enforcement is gone: a previously-violating row now inserts.
		await db.exec('insert into t (id, v) values (1, 5)');
	});

	it('an ALTER-added CHECK can be renamed by name and keeps enforcing', async () => {
		await db.exec('create table t (id integer primary key, v integer)');
		await db.exec('alter table t add constraint chk check (v > 10)');
		await db.exec('alter table t rename constraint chk to chk2');
		expect(db.schemaManager.getTable('main', 't')!.checkConstraints.map(c => c.name)).to.deep.equal(['chk2']);
		const err = await expectThrows(() => db.exec('insert into t (id, v) values (1, 5)'));
		expect(err.code).to.equal(StatusCode.CONSTRAINT);
	});

	it('an ALTER-added CHECK survives a later module-routed ALTER (ADD UNIQUE)', async () => {
		await db.exec('create table t (id integer primary key, v integer, email text null)');
		await db.exec('alter table t add constraint chk check (v > 10)');
		await db.exec('alter table t add constraint uq unique (email)');
		// The CHECK is still present in the catalog and still enforces alongside UNIQUE.
		expect(db.schemaManager.getTable('main', 't')!.checkConstraints.map(c => c.name)).to.deep.equal(['chk']);
		const err = await expectThrows(() => db.exec('insert into t values (1, 5, null)'));
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

	// Constraint names are unique within a table. RENAME CONSTRAINT already enforced
	// that; ADD CONSTRAINT did not, so a duplicate arriving by addition was accepted and
	// left a name that DROP/RENAME then removed twice (same class) or could never address
	// again (across classes — the ambiguity error). The behavioral/cross-backend coverage
	// lives in test/logic/41.6-alter-drop-rename-constraint.sqllogic § 7b; these pin the
	// message text and status code.
	describe('duplicate constraint name', () => {
		const expectDuplicate = async (sql: string, name: string, table: string): Promise<void> => {
			const err = await expectThrows(() => db.exec(sql));
			expect(err.code).to.equal(StatusCode.CONSTRAINT);
			expect(err.message).to.contain(
				`Cannot add constraint '${name}' to table '${table}': a constraint with that name already exists`,
			);
		};

		it('refuses a CHECK whose name another CHECK already uses', async () => {
			await db.exec('create table t (id integer primary key, a integer, b integer, constraint ck check (a > 0))');
			await expectDuplicate('alter table t add constraint ck check (b > 0)', 'ck', 't');
			expect(db.schemaManager.getTable('main', 't')!.checkConstraints.map(c => c.name)).to.deep.equal(['ck']);
		});

		it('refuses a UNIQUE whose name a CHECK already uses (cross-class)', async () => {
			await db.exec('create table t (id integer primary key, a integer, b integer, constraint dup check (a > 0))');
			await expectDuplicate('alter table t add constraint dup unique (b)', 'dup', 't');
			expect(db.schemaManager.getTable('main', 't')!.uniqueConstraints ?? []).to.deep.equal([]);
			// The name still resolves to exactly one constraint, so DROP keeps working —
			// which is exactly what a landed duplicate would have made impossible.
			await db.exec('alter table t drop constraint dup');
			expect(db.schemaManager.getTable('main', 't')!.checkConstraints.map(c => c.name)).to.deep.equal([]);
		});

		it('matches the existing name case-insensitively', async () => {
			await db.exec('create table t (id integer primary key, a integer, b integer, constraint ck check (a > 0))');
			await expectDuplicate('alter table t add constraint CK check (b > 0)', 'CK', 't');
		});

		it('does not fire for an unnamed constraint', async () => {
			await db.exec('create table t (id integer primary key, a integer, b integer, constraint uq unique (a))');
			await db.exec('alter table t add unique (b)');
			expect((db.schemaManager.getTable('main', 't')!.uniqueConstraints ?? []).length).to.equal(2);
		});

		it('refuses an inline named constraint on ADD COLUMN, leaving the table unchanged', async () => {
			await db.exec('create table t (id integer primary key, a integer, constraint ck check (a > 0))');
			await db.exec('insert into t values (1, 5)');
			await expectDuplicate('alter table t add column b integer null constraint ck check (b > 0)', 'ck', 't');

			const t = db.schemaManager.getTable('main', 't')!;
			expect(t.columns.map(c => c.name), 'no column added').to.deep.equal(['id', 'a']);
			expect(t.checkConstraints.map(c => c.name), 'no constraint installed').to.deep.equal(['ck']);
			// Data is intact and still readable through the unchanged column set.
			const rows: Record<string, unknown>[] = [];
			for await (const r of db.eval('select id, a from t')) rows.push(r as Record<string, unknown>);
			expect(rows).to.deep.equal([{ id: 1, a: 5 }]);
		});

		it('refuses two inline constraints on one ADD COLUMN that collide with each other', async () => {
			// Neither name is on the table yet, so only the within-statement accumulation
			// catches this one.
			await db.exec('create table t (id integer primary key, a integer)');
			await expectDuplicate(
				'alter table t add column b integer null constraint x check (b > 0) constraint x unique',
				'x',
				't',
			);
			const t = db.schemaManager.getTable('main', 't')!;
			expect(t.columns.map(c => c.name)).to.deep.equal(['id', 'a']);
			expect(t.checkConstraints.map(c => c.name)).to.deep.equal([]);
			expect(t.uniqueConstraints ?? []).to.deep.equal([]);
		});

		it('refuses two inline constraints on one ADD COLUMN whose names differ only in case', async () => {
			await db.exec('create table t (id integer primary key, a integer)');
			await expectDuplicate(
				'alter table t add column b integer null constraint x check (b > 0) constraint X unique',
				'X',
				't',
			);
			expect(db.schemaManager.getTable('main', 't')!.columns.map(c => c.name)).to.deep.equal(['id', 'a']);
		});

		it('refuses an inline named FOREIGN KEY on ADD COLUMN, matching case-insensitively', async () => {
			// The third class that occupies a named-constraint array; the inline arm reads the
			// raw declaration, so each class needs its own coverage that the name is seen there.
			await db.exec('create table parent (pid integer primary key)');
			await db.exec('create table child (id integer primary key, a integer, constraint fk_p check (a > 0))');
			await expectDuplicate(
				'alter table child add column pa integer null constraint FK_P references parent(pid)',
				'FK_P',
				'child',
			);
			const t = db.schemaManager.getTable('main', 'child')!;
			expect(t.columns.map(c => c.name)).to.deep.equal(['id', 'a']);
			expect(t.foreignKeys ?? []).to.deep.equal([]);
		});

		it('accepts two unnamed inline CHECKs on one new column, minting disambiguated names', async () => {
			// The guard reads user-written names off the raw declaration precisely so a
			// synthesized name never refuses a legal statement. The colliding mints are
			// disambiguated instead (`_check_b` / `_check_b_2` — the same names the
			// CREATE TABLE spelling of this declaration produces), so DROP CONSTRAINT
			// can address each individually.
			await db.exec('create table t (id integer primary key, a integer)');
			await db.exec('alter table t add column b integer null check (b > 0) check (b < 10)');
			const t = db.schemaManager.getTable('main', 't')!;
			expect(t.columns.map(c => c.name)).to.deep.equal(['id', 'a', 'b']);
			expect(t.checkConstraints.map(c => c.name)).to.deep.equal(['_check_b', '_check_b_2']);
		});

		it('ignores a name on an inline constraint class that stores none', async () => {
			// `constraint ck not null` records no name anywhere, so it cannot collide with
			// the CHECK named `ck` — refusing it would reject a legal statement.
			await db.exec('create table t (id integer primary key, a integer, constraint ck check (a > 0))');
			await db.exec('alter table t add column b integer constraint ck not null default 1');
			const t = db.schemaManager.getTable('main', 't')!;
			expect(t.columns.map(c => c.name)).to.deep.equal(['id', 'a', 'b']);
			expect(t.checkConstraints.map(c => c.name)).to.deep.equal(['ck']);
		});

		it('still allows a non-colliding inline named constraint on ADD COLUMN', async () => {
			await db.exec('create table t (id integer primary key, a integer, constraint ck check (a > 0))');
			await db.exec('alter table t add column b integer null constraint ck_b check (b > 0)');
			const t = db.schemaManager.getTable('main', 't')!;
			expect(t.columns.map(c => c.name)).to.deep.equal(['id', 'a', 'b']);
			expect(t.checkConstraints.map(c => c.name)).to.have.members(['ck', 'ck_b']);
		});
	});
});

// ── Existing-row validation for ADD CONSTRAINT … CHECK ──────────────────────────
//
// The engine validates a newly added CHECK against the rows already in the table,
// pre-dispatch and for every module (`rejectCheckViolatedByExistingRows` in
// runtime/emit/add-constraint.ts). This is a WRONG-RESULT guard, not tidiness: the
// optimizer treats a declared CHECK as a proven fact about every stored row and folds
// contradicting predicates away, so a grandfathered violator would vanish from
// `select … where n <= 0` while still being stored. Whatever the optimizer lifts must
// therefore have been validated — the `new.` / `old.` / operation-mask cases below are
// exactly the optimizer's own screens (planner/analysis/check-extraction.ts), mirrored.

/** Memory module that grandfathers CHECK violators — the documented opt-out. */
class GrandfatheringMemoryModule extends MemoryTableModule {
	override getCapabilities(): ModuleCapabilities {
		return { ...super.getCapabilities(), permitsGrandfatheredCheckViolators: true };
	}
}

describe('ALTER TABLE ADD CONSTRAINT … CHECK validates existing rows', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	async function rows(sql: string): Promise<Record<string, SqlValue>[]> {
		const out: Record<string, SqlValue>[] = [];
		for await (const r of db.eval(sql)) out.push(r);
		return out;
	}

	async function expectRejected(sql: string, namePattern: RegExp): Promise<QuereusError> {
		const err = await expectThrows(() => db.exec(sql));
		expect(err.code, err.message).to.equal(StatusCode.CONSTRAINT);
		expect(err.message).to.match(/CHECK constraint failed/);
		expect(err.message).to.match(namePattern);
		return err;
	}

	/** The table carries no CHECK — in the catalog, in the module's cached schema, and behaviorally. */
	async function expectNoCheckInstalled(violatingInsert: string): Promise<void> {
		expect(await rows(`select name from check_constraint_info('t')`), 'catalog carries no CHECK').to.deep.equal([]);
		expect(db.schemaManager.getTable('main', 't')!.checkConstraints, 'live schema carries no CHECK').to.deep.equal([]);
		await db.exec(violatingInsert); // nothing enforces forward
	}

	it('rejects with CONSTRAINT when an existing row violates the CHECK, leaving the table untouched', async () => {
		await db.exec('create table t (id integer primary key, n integer null)');
		await db.exec('insert into t values (1, -5), (2, 7)');
		await expectRejected('alter table t add constraint c check (n > 0)', /\bc\b/);
		await expectNoCheckInstalled('insert into t values (3, -1)');
		expect(await rows('select id from t where n <= 0 order by id')).to.deep.equal([{ id: 1 }, { id: 3 }]);
	});

	it('accepts when every existing row conforms, then enforces forward', async () => {
		await db.exec('create table t (id integer primary key, n integer null)');
		await db.exec('insert into t values (1, 5), (2, 7)');
		await db.exec('alter table t add constraint c check (n > 0)');
		expect(await rows(`select name from check_constraint_info('t')`)).to.deep.equal([{ name: 'c' }]);
		await expectRejected('insert into t values (3, -1)', /\bc\b/);
	});

	it('a NULL in the checked column is not a violation (NULL passes a CHECK)', async () => {
		await db.exec('create table t (id integer primary key, n integer null)');
		await db.exec('insert into t values (1, null), (2, 7)');
		await db.exec('alter table t add constraint c check (n > 0)');
		await expectRejected('insert into t values (3, 0)', /\bc\b/);
	});

	it('an unnamed CHECK reports its minted name', async () => {
		await db.exec('create table t (id integer primary key, n integer null)');
		await db.exec('insert into t values (1, -5)');
		await expectRejected('alter table t add check (n > 0)', /check_0/);
		await expectNoCheckInstalled('insert into t values (2, -1)');
	});

	it('rows the issuing transaction has inserted but not yet committed count as present', async () => {
		await db.exec('create table t (id integer primary key, n integer null)');
		await db.exec('begin');
		await db.exec('insert into t values (1, -5)');
		await expectRejected('alter table t add constraint c check (n > 0)', /\bc\b/);
		expect((await rows('select count(*) as k from t'))[0].k, 'the staged row survives the rejected ALTER').to.equal(1);
		await db.exec('rollback');
	});

	it('the wrong-result probe: a query contradicting a freshly added CHECK still agrees with select *', async () => {
		await db.exec('create table t (id integer primary key, n integer null)');
		await db.exec('insert into t values (1, -5), (2, 7)');
		expect(await rows('select id from t where n <= 0')).to.deep.equal([{ id: 1 }]);
		await expectRejected('alter table t add constraint c check (n > 0)', /\bc\b/);
		// The violator did not vanish: the contradicting query still finds it.
		expect(await rows('select id from t where n <= 0')).to.deep.equal([{ id: 1 }]);

		// Once the table conforms the CHECK installs, and the folded query must agree with
		// the unfolded one — that agreement is the property the optimizer's lift depends on.
		await db.exec('delete from t where id = 1');
		await db.exec('alter table t add constraint c check (n > 0)');
		const all = await rows('select id, n from t');
		const folded = await rows('select id, n from t where n <= 0');
		expect(folded).to.deep.equal(all.filter(r => (r.n as number) <= 0));
	});

	it('self-fold pin: the validation must run before the CHECK is declared anywhere the planner can see it', async () => {
		// `n > 0` is a shape the optimizer lifts into a range domain, so a declared
		// `check (n > 0)` folds `where not (n > 0)` — the validation scan's own predicate —
		// to EmptyRelation. If the pre-dispatch call in add-constraint.ts ever moves after
		// `module.alterTable` / `schema.addTable`, the scan trusts the very thing it is
		// testing, passes vacuously, and the rejection below stops happening.
		await db.exec('create table t (id integer primary key, n integer null)');
		await db.exec('insert into t values (1, -5)');
		await expectRejected('alter table t add constraint c check (n > 0)', /\bc\b/);

		// And the trap is real, not hypothetical: the SAME scan over the SAME violating row
		// passes vacuously once the CHECK is declared in the live catalog. (Direct call so
		// the emitter's ordering is not what makes it pass.) If this half ever starts
		// throwing, the fold no longer applies and the pin above is moot — say so.
		await db.exec('create table tpl (id integer primary key, n integer null, constraint c check (n > 0))');
		const parsedCheck = db.schemaManager.getTable('main', 'tpl')!.checkConstraints[0];
		const live = db.schemaManager.getTable('main', 't')!;
		const declared = { ...live, checkConstraints: Object.freeze([parsedCheck]) };
		db.schemaManager.getSchemaOrFail('main').addTable(declared);
		try {
			await validateChecksOverExistingRows(db, declared, declared.checkConstraints);
		} finally {
			db.schemaManager.getSchemaOrFail('main').addTable(live);
		}
		// Reached without throwing: the fold swallowed the scan. Prove the row is still there.
		expect((await rows('select count(*) as k from t where n <= 0'))[0].k).to.equal(1);
	});

	// ── new. / old. row-image qualifiers (docs/sql-ddl.md § 2.6) ────────────────

	it('check (new.<col> …) is validated like the unqualified spelling', async () => {
		await db.exec('create table t (id integer primary key, n integer null)');
		await db.exec('insert into t values (1, -5)');
		await expectRejected('alter table t add constraint c check (new.n > 0)', /\bc\b/);
		await expectNoCheckInstalled('insert into t values (2, -1)');

		await db.exec('delete from t');
		await db.exec('insert into t values (1, 5)');
		await db.exec('alter table t add constraint c check (new.n > 0)');
		await expectRejected('insert into t values (2, -1)', /\bc\b/);
	});

	it('a conjunct referencing old.<col> is a transition constraint: not validated, and never blocks the statement', async () => {
		await db.exec('create table t (id integer primary key, n integer null)');
		await db.exec('insert into t values (1, -5)');
		// Nothing about a row sitting still can be judged here; the ALTER succeeds …
		await db.exec('alter table t add constraint c check (old.n is null or n >= old.n)');
		expect(await rows(`select name from check_constraint_info('t')`)).to.deep.equal([{ name: 'c' }]);
		// … and the transition rule is enforced on the next write.
		await expectRejected('update t set n = -6 where id = 1', /\bc\b/);
		await db.exec('update t set n = 0 where id = 1');
	});

	it("a mixed CHECK validates its old.-free conjuncts and skips only the transition one", async () => {
		// The optimizer screens `old.` PER TOP-LEVEL AND-CONJUNCT and still lifts the
		// `status` domain, so skipping the whole CHECK here would leave the hole open.
		await db.exec('create table t (id integer primary key, status text null)');
		await db.exec("insert into t values (1, 'z')");
		await expectRejected("alter table t add constraint c check ((old.id is null or id = old.id) and status in ('a', 'i'))", /\bc\b/);
		await expectNoCheckInstalled("insert into t values (2, 'q')");

		await db.exec('delete from t');
		await db.exec("insert into t values (1, 'a')");
		await db.exec("alter table t add constraint c check ((old.id is null or id = old.id) and status in ('a', 'i'))");
		await expectRejected("insert into t values (2, 'q')", /\bc\b/);
	});

	it('an old.<col> ref inside a non-AND conjunct kills that whole conjunct, like the lift', async () => {
		await db.exec('create table t (id integer primary key, n integer null)');
		await db.exec('insert into t values (1, -5)');
		// The OR is one conjunct; `old.n` anywhere inside it disqualifies it entirely.
		await db.exec('alter table t add constraint c check (n > 0 or old.n is not null)');
		expect(await rows(`select name from check_constraint_info('t')`)).to.deep.equal([{ name: 'c' }]);
	});

	it('a DELETE-only CHECK constrains no stored row and is not validated', async () => {
		await db.exec('create table t (id integer primary key, n integer null)');
		await db.exec('insert into t values (1, -5)');
		await db.exec('alter table t add constraint c check on delete (n > 0)');
		expect(await rows(`select name from check_constraint_info('t')`)).to.deep.equal([{ name: 'c' }]);
	});

	it('a self-qualified reference (t.n) is validated', async () => {
		await db.exec('create table t (id integer primary key, n integer null)');
		await db.exec('insert into t values (1, -5)');
		await expectRejected('alter table t add constraint c check (t.n > 0)', /\bc\b/);
	});

	it('a new.<col> correlated from inside a subquery is validated against the stored row', async () => {
		await db.exec('create table lim (k integer primary key, cap integer)');
		await db.exec('insert into lim values (1, 10)');
		await db.exec('create table t (id integer primary key, n integer null)');
		await db.exec('insert into t values (1, 50)');
		await expectRejected('alter table t add constraint c check (exists (select 1 from lim where lim.cap >= new.n))', /\bc\b/);
		await db.exec('update t set n = 5 where id = 1');
		await db.exec('alter table t add constraint c check (exists (select 1 from lim where lim.cap >= new.n))');
		await expectRejected('insert into t values (2, 50)', /\bc\b/);
	});

	it('a new.<col> inside a subquery over the owning table itself still means the stored row', async () => {
		// The inner unaliased `from t` rebinds `t`, so `t.n` / `t.id` bind inside; `new.n` /
		// `new.id` requalify to the scan alias and correlate to the OUTER stored row —
		// the same reading enforcement gives them.
		await db.exec('create table t (id integer primary key, n integer null)');
		await db.exec('insert into t values (1, 5), (2, 5)');
		const noTwin = 'check (not exists (select 1 from t where t.n = new.n and t.id <> new.id))';
		await expectRejected(`alter table t add constraint c ${noTwin}`, /\bc\b/);
		await db.exec('update t set n = 6 where id = 2');
		await db.exec(`alter table t add constraint c ${noTwin}`);
		await expectRejected('insert into t values (3, 6)', /\bc\b/);
	});

	it('a subquery over a real table named "new" is left alone (new is not a reserved word)', async () => {
		await db.exec('create table "new" (id integer primary key, v integer)');
		await db.exec('insert into "new" values (1, 10)');
		await db.exec('create table t (id integer primary key, n integer null)');
		await db.exec('insert into t values (1, 50)');
		await expectRejected('alter table t add constraint c check (n < (select max("new".v) from "new"))', /\bc\b/);
		await db.exec('update t set n = 5 where id = 1');
		await db.exec('alter table t add constraint c check (n < (select max("new".v) from "new"))');
		await expectRejected('insert into t values (2, 50)', /\bc\b/);
	});

	// ── The two arms and the opt-out ──────────────────────────────────────────────

	it('the engine-side fallback (module without alterTable) validates too', async () => {
		db.registerModule('noalter', makeNoAlterModule());
		await db.exec('create table t (id integer primary key, n integer null) using noalter');
		await db.exec('insert into t values (1, -5)');
		await expectRejected('alter table t add constraint c check (n > 0)', /\bc\b/);
		await expectNoCheckInstalled('insert into t values (2, -1)');
	});

	it('a module declaring permitsGrandfatheredCheckViolators keeps the accepting behavior', async () => {
		db.registerModule('gfmem', new GrandfatheringMemoryModule());
		await db.exec('create table t (id integer primary key, n integer null) using gfmem');
		await db.exec('insert into t values (1, -5)');
		await db.exec('alter table t add constraint c check (n > 0)');
		expect(await rows(`select name from check_constraint_info('t')`)).to.deep.equal([{ name: 'c' }]);
		// The other half of that contract: the optimizer does not lift the CHECK for this
		// module, so the grandfathered violator is still found.
		expect(await rows('select id from t where n <= 0')).to.deep.equal([{ id: 1 }]);
		await expectRejected('insert into t values (2, -1)', /\bc\b/);
	});

	// ── The ADD COLUMN sibling (same scan) ────────────────────────────────────────

	it('ADD COLUMN … check (new.<col> …) is validated as a constraint, not rejected as an unknown column', async () => {
		await db.exec('create table t (id integer primary key)');
		await db.exec('insert into t values (1)');
		const err = await expectThrows(() => db.exec('alter table t add column v integer default -1 check (new.v > 0)'));
		expect(err.code, err.message).to.equal(StatusCode.CONSTRAINT);
		expect(err.message).to.match(/_check_v.*backfilled rows/);
		expect((await rows(`select name from table_info('t')`)).map(r => r.name), 'column not added').to.deep.equal(['id']);

		await db.exec('alter table t add column v integer default 1 check (new.v > 0)');
		await expectRejected('insert into t values (2, 0)', /_check_v/);
	});
});
