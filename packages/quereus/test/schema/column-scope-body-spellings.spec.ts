/**
 * The spelling × verb matrix for the column verbs' scope walk
 * (`schema/rename/column-rename.ts`): every way a stored body can read or
 * republish one table's column, driven through BOTH `ALTER TABLE … RENAME
 * COLUMN` and `ALTER TABLE … DROP COLUMN`.
 *
 * The property this pins, as a property rather than as paired hand-written
 * cases: **a FROM alias adds a qualifier, it does not take the source's columns
 * out of scope.** A bare `x` written against `from t a` binds `t.x` exactly as
 * it would against `from t`, so both verbs must see it — the rename must follow
 * it, and the drop must refuse over it. Rename/drop parity falls out of the
 * same table: every spelling is asked of both verbs, and neither is allowed to
 * be blind where the other sees.
 *
 * End-to-end against a real `Database` rather than over the walker's API,
 * because the assertion is **planability** — after a rename the dependent body
 * must still run, which comparing rewritten body text cannot tell you.
 * `table-rename-scope.spec.ts` and `row-image-context-matrix.spec.ts` drive
 * their matrices over the walker directly; this one cannot.
 *
 * A subquery source is a spelling like any other: its output columns are
 * inferred from its inner body, so an outer bare ref or a `*` over it binds the
 * column exactly as it would over `t` itself. There is no matching **function
 * source** cell: a function source never carries `t`'s columns at all, so it
 * can neither bind a bare `x` nor republish one — the walk leaves it unaskable,
 * and there is no reachable case to pin.
 *
 * Scope of the matrix: view bodies and assertion bodies. The same walk also
 * serves the expressions a *table* carries, but none of those can be authored
 * with an aliased FROM shape reaching another table, so there is nothing here
 * for them — a generated body's unqualified foreign reference is rejected at
 * declaration time (`Column 'x' referenced by generated column … not found`),
 * and a partial-index predicate rejects a subquery outright (`Unsupported
 * expression in partial-index predicate: subquery`, measured 2026-08-06), which
 * is the only way a predicate could carry a FROM clause at all. The remaining
 * site, a column DEFAULT, is pinned in
 * `test/logic/41.10.2-alter-drop-column-check-and-assertion.sqllogic`.
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';

/** One way a stored body can reach `main.t`.`x`. */
interface Spelling {
	title: string;
	/** Extra DDL/DML this spelling needs, beyond `t` and its one row. */
	setup?: readonly string[];
	/**
	 * A select over `t` publishing the target column under its CURRENT name.
	 * Used as a view body: the rename arm asks whether the view still plans and
	 * publishes the shifted name, and the drop arm reaches `t.x` through it.
	 */
	body: string;
	/**
	 * An assertion CHECK body reading the target column through the same FROM
	 * shape, with no view in between — the direct half of the drop arm.
	 */
	read: string;
}

const U_TABLE = ['create table u (id integer primary key, n integer)', 'insert into u values (1, 7)'];

const SPELLINGS: readonly Spelling[] = [
	{
		title: 'bare projection over an unaliased source',
		body: 'select id, x from t',
		read: 'not exists (select 1 from t where x < 0)',
	},
	{
		title: 'bare projection over an ALIASED source',
		body: 'select id, x from t a',
		read: 'not exists (select 1 from t a where x < 0)',
	},
	{
		title: 'alias-qualified projection',
		body: 'select id, a.x from t a',
		read: 'not exists (select 1 from t a where a.x < 0)',
	},
	{
		title: 'bare star over an unaliased source',
		body: 'select * from t',
		read: 'not exists (select * from t where x < 0)',
	},
	{
		title: 'name-qualified star',
		body: 'select t.* from t',
		read: 'not exists (select t.* from t where t.x < 0)',
	},
	{
		title: 'alias-qualified star',
		body: 'select a.* from t a',
		read: 'not exists (select a.* from t a where a.x < 0)',
	},
	{
		title: 'bare star over an ALIASED source',
		body: 'select * from t a',
		read: 'not exists (select * from t a where x < 0)',
	},
	{
		title: 'join arm, bare ref, unaliased source',
		setup: U_TABLE,
		body: 'select t.id as id, x from t join u on t.id = u.id',
		read: 'not exists (select 1 from t join u on t.id = u.id where x < 0)',
	},
	{
		title: 'join arm, bare ref, ALIASED source',
		setup: U_TABLE,
		body: 'select a.id as id, x from t a join u on a.id = u.id',
		read: 'not exists (select 1 from t a join u on a.id = u.id where x < 0)',
	},
	{
		title: 'exposing CTE, unaliased reference',
		body: 'with c as (select id, x from t) select id, x from c',
		read: 'not exists (with c as (select id, x from t) select 1 from c where x < 0)',
	},
	{
		title: 'exposing CTE, ALIASED reference',
		body: 'with c as (select id, x from t) select id, x from c a',
		read: 'not exists (with c as (select id, x from t) select 1 from c a where x < 0)',
	},
	{
		title: 'bare star over an exposing CTE, ALIASED reference',
		body: 'with c as (select * from t) select * from c a',
		read: 'not exists (with c as (select * from t) select 1 from c a where x < 0)',
	},
	{
		// The alias collides with a DIFFERENT real table's name. `u` is not in
		// this FROM, so the bare `x` still binds `t` — the alias renames the
		// qualifier, it does not import `u`.
		title: 'alias shadowing another real table\'s name',
		setup: U_TABLE,
		body: 'select id, x from t u',
		read: 'not exists (select 1 from t u where x < 0)',
	},
	{
		// The OUTER bare `x` binds through the subquery source, so RENAME must
		// follow it as well as the inner one.
		title: 'aliased subquery source whose inner body names the column',
		body: 'select id, x from (select id, x from t) s',
		read: 'not exists (select 1 from (select id, x from t) s where x < 0)',
	},
	{
		title: 'bare star over an aliased SUBQUERY source (nothing spells the column)',
		body: 'select * from (select * from t) s',
		read: 'not exists (select 1 from (select * from t) s where x < 0)',
	},
];

describe('column verbs: body spellings that reach one table\'s column', () => {
	let db: Database;
	beforeEach(async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, x integer)');
		await db.exec('insert into t values (1, 5)');
	});
	afterEach(async () => { await db.close(); });

	const applySetup = async (c: Spelling): Promise<void> => {
		for (const stmt of c.setup ?? []) await db.exec(stmt);
	};

	describe('RENAME COLUMN leaves every dependent body planable', () => {
		for (const c of SPELLINGS) {
			it(c.title, async () => {
				await applySetup(c);
				await db.exec(`create view v as ${c.body}`);
				await db.exec('alter table t rename column x to z');
				// Planability, not body text: the body must still RUN.
				const row = await db.get('select * from v');
				expect(row, 'view must still return its row').to.exist;
				// Every spelling here publishes the column bare (or through a
				// star), so the cascade shifts the published name with it.
				expect(Object.keys(row!), 'published name must follow the rename')
					.to.include('z').and.not.include('x');
			});
		}

		it('a reader of the republished name follows the rename too', async () => {
			await db.exec('create view v as select * from t a');
			await db.exec('create view w as select x from v');
			await db.exec('alter table t rename column x to z');
			const row = await db.get('select * from w');
			expect(Object.keys(row!)).to.deep.equal(['z']);
		});
	});

	describe('DROP COLUMN refuses whenever a live rule reads the column', () => {
		for (const c of SPELLINGS) {
			it(`${c.title} — read directly by an assertion`, async () => {
				await applySetup(c);
				await db.exec(`create assertion a1 check (${c.read})`);
				const err = await refused(() => db.exec('alter table t drop column x'));
				expect(err.message).to.contain('a1');
			});

			it(`${c.title} — republished to an assertion through a view`, async () => {
				await applySetup(c);
				await db.exec(`create view v as ${c.body}`);
				await db.exec('create assertion a1 check (not exists (select 1 from v where x < 0))');
				const err = await refused(() => db.exec('alter table t drop column x'));
				expect(err.message).to.contain('a1');
			});
		}
	});

	describe('DROP COLUMN accepts when no rule reads the column', () => {
		for (const c of SPELLINGS) {
			it(c.title, async () => {
				await applySetup(c);
				// A view republishing the column, and a live assertion — but the
				// assertion reads a DIFFERENT column, and a view with no rule over
				// it is not itself a dependent. So the refusals above are about the
				// column a rule reads, not about "a republisher exists" or "some
				// assertion exists".
				await db.exec(`create view v as ${c.body}`);
				await db.exec('create assertion a1 check (not exists (select 1 from t where id < 0))');
				await db.exec('alter table t drop column x');
				const row = await db.get('select * from t');
				expect(Object.keys(row!)).to.not.include('x');
			});
		}
	});
});

/** Run `fn`, requiring it to reject; returns the error it rejected with. */
async function refused(fn: () => Promise<unknown>): Promise<Error> {
	let err: unknown;
	try {
		await fn();
	} catch (e) {
		err = e;
	}
	expect(err, 'statement must be refused, but it succeeded').to.be.an('error');
	return err as Error;
}
