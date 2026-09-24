import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { QuereusError } from '../src/common/errors.js';
import { StatusCode } from '../src/common/types.js';
import type { SqlValue } from '../src/common/types.js';

type ResultRow = Record<string, SqlValue>;
type Params = SqlValue[] | Record<string, SqlValue>;

/**
 * Array-valued scalar parameter guard (ticket
 * `quereus-reject-array-valued-scalar-param`).
 *
 * Binding a single `?`/`:name` placeholder to a whole JS array (or plain object)
 * and comparing it against a scalar column used to match no rows silently — the
 * OBJECT storage class sorts above every scalar, so the predicate was always
 * false. These specs assert it now raises a clear `StatusCode.MISMATCH` error at
 * the predicate site, while the legitimate non-scalar uses (function argument,
 * projection, JSON-column storage, JSON-vs-JSON comparison) keep working.
 */
describe('Array-valued scalar parameter guard', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('PRAGMA default_vtab_module=memory');
		await db.exec('create table t (id integer primary key, name text) using memory');
		await db.exec(`insert into t (id, name) values (1, 'a'), (2, 'b'), (3, 'c')`);
	});

	afterEach(async () => {
		await db.close();
	});

	async function collect(sql: string, params?: Params): Promise<ResultRow[]> {
		const rows: ResultRow[] = [];
		for await (const row of db.eval(sql, params)) {
			rows.push(row);
		}
		return rows;
	}

	async function collectPrepared(sql: string, params?: Params): Promise<ResultRow[]> {
		// `prepare` binds the values (and infers their types) itself, so `all()` takes none.
		const stmt = db.prepare(sql, params);
		try {
			const rows: ResultRow[] = [];
			for await (const row of stmt.all()) {
				rows.push(row);
			}
			return rows;
		} finally {
			await stmt.finalize();
		}
	}

	/**
	 * The two ways a query reaches the planner, differing in whether the plan knows
	 * the parameter's type. `db.eval` plans before binding, so its parameters stay
	 * ANY; every `prepare`-based path (`db.get`, `db.prepare(...).all()`, an eval
	 * carrying execution options) infers the type from the bound value, and a
	 * JSON-typed parameter makes the planner wrap the *scalar* side of the
	 * comparison in a coercion cast — `id = ?` builds as `cast(id as json) = ?`.
	 * The guard used to read that cast's type, conclude the counterpart was not
	 * scalar, and go silent on exactly the typed paths (ticket
	 * `array-param-guard-defeated-by-coercion-cast`), so every case below runs on
	 * both.
	 */
	const paths: readonly { readonly name: string; readonly run: (sql: string, params?: Params) => Promise<ResultRow[]> }[] = [
		{ name: 'db.eval (untyped parameters)', run: (sql, params) => collect(sql, params) },
		{ name: 'db.prepare (typed parameters)', run: (sql, params) => collectPrepared(sql, params) },
	];

	for (const path of paths) {
		describe(path.name, () => {
			async function expectMismatch(sql: string, params: Params): Promise<QuereusError> {
				let error: Error | undefined;
				try {
					await path.run(sql, params);
				} catch (e) {
					error = e as Error;
				}
				expect(error, `expected "${sql}" to throw`).to.exist;
				expect(error).to.be.instanceof(QuereusError);
				expect((error as QuereusError).code).to.equal(StatusCode.MISMATCH);
				expect(error!.message.toLowerCase()).to.include('scalar comparison');
				return error as QuereusError;
			}

			describe('throws on an array-valued scalar parameter', () => {
				it('id = ? (indexed PK seek path)', async () => {
					await expectMismatch('select * from t where id = ?', [[1, 2]]);
				});

				it('id in (?) (single-element IN over PK)', async () => {
					await expectMismatch('select * from t where id in (?)', [[1, 2]]);
				});

				it('name = ? (non-indexed comparison path)', async () => {
					await expectMismatch('select * from t where name = ?', [[1, 2]]);
				});

				it('name between ? and ? (range bound)', async () => {
					await expectMismatch(`select * from t where name between ? and ?`, [[1, 2], 'z']);
				});

				it('name in (?) (non-indexed membership, dynamic value)', async () => {
					await expectMismatch('select * from t where name in (?)', [[1, 2]]);
				});

				it('names the offending parameter in the message', async () => {
					const err = await expectMismatch('select * from t where name = :needle', { needle: [1, 2] });
					expect(err.message).to.include(':needle');
				});

				it('id > ? (non-equality range comparator)', async () => {
					await expectMismatch('select * from t where id > ?', [[1, 2]]);
				});

				it('id = cast(? as integer) (parameter wrapped in CAST)', async () => {
					await expectMismatch('select * from t where id = cast(? as integer)', [[1, 2]]);
				});

				it('? = id (parameter on the left of the comparison)', async () => {
					await expectMismatch('select * from t where ? = id', [[1, 2]]);
				});

				it('plain object (not array) bound to a scalar comparand', async () => {
					await expectMismatch('select * from t where id = ?', [{ lo: 1, hi: 2 }]);
				});
			});

			describe('does not over-fire on legitimate non-scalar uses', () => {
				it('id in (?, ?) with two scalar params still returns rows', async () => {
					const rows = await path.run('select * from t where id in (?, ?) order by id', [1, 2]);
					expect(rows.map(r => r.id)).to.deep.equal([1, 2]);
				});

				it('json_array_length(?) with an array arg', async () => {
					const rows = await path.run('select json_array_length(?) as n', [[1, 2, 3]]);
					expect(rows).to.have.length(1);
					expect(rows[0].n).to.equal(3);
				});

				it('projecting an array param (select ? as v)', async () => {
					const rows = await path.run('select ? as v', [[1, 2]]);
					expect(rows).to.have.length(1);
					expect(rows[0].v).to.deep.equal([1, 2]);
				});

				it('storing an array param into a JSON column', async () => {
					await db.exec('create table j (id integer primary key, data json) using memory');
					await db.exec('insert into j (id, data) values (?, ?)', [1, [1, 2, 3]]);
					const rows = await path.run('select data from j where id = ?', [1]);
					expect(rows).to.have.length(1);
					expect(rows[0].data).to.deep.equal([1, 2, 3]);
				});

				it('JSON-column = JSON-param comparison (OBJECT-vs-OBJECT)', async () => {
					await db.exec('create table j (id integer primary key, data json) using memory');
					await db.exec('insert into j (id, data) values (?, ?), (?, ?)', [1, [1, 2, 3], 2, [4, 5]]);
					const rows = await path.run('select id from j where data = ?', [[1, 2, 3]]);
					expect(rows.map(r => r.id)).to.deep.equal([1]);
				});

				it('explicit cast(textcol as json) = :p (user-written cast, not a coercion)', async () => {
					// The case the synthetic-only unwrap protects: the guard looks through the
					// casts the planner mints to reconcile a comparison's operand types, but a
					// cast the user wrote is a deliberate conversion — here a genuine
					// JSON-vs-JSON comparison that must keep matching rather than being
					// rejected as scalar-vs-array.
					await db.exec('create table jt (id integer primary key, doc text) using memory');
					await db.exec(`insert into jt (id, doc) values (1, '[1,2,3]'), (2, '[4,5]')`);
					const rows = await path.run('select id from jt where cast(doc as json) = :p', { p: [1, 2, 3] });
					expect(rows.map(r => r.id)).to.deep.equal([1]);
				});

				it('a null-bound scalar-comparison param executes without error', async () => {
					const rows = await path.run('select * from t where name = :needle', { needle: null });
					expect(rows).to.have.length(0);
				});
			});
		});
	}

	describe('respects a named parameter legitimately bound to null', () => {
		// Regression: the scalar-required-param guard resolved the value with
		// `boundArgs[key] ?? boundArgs[':'+key]`. A bare key bound to `null` fell
		// through the `??` to the `:`-prefixed alternate, so a real `null` binding was
		// masked by (and could wrongly adopt) an unrelated `:key` value. The fix uses
		// a presence check, so a bound `null` is honored.
		//
		// Eval-only by design: this binds both spellings of one name at once, and the
		// typed paths infer that parameter's *type* from the same map, where the array
		// alternate wins and the bound null then fails an ordinary parameter type check
		// before the guard is reached. That collision is about type inference over a
		// double-spelled key, not about this guard.
		it('honors a null bare binding rather than the :-prefixed alternate', async () => {
			// Both keys present: bare `needle` bound to null (a valid scalar), and the
			// `:needle` alternate bound to an array. The bound null must win — falling
			// through to the array would wrongly raise the array-valued-scalar mismatch.
			const rows = await collect('select * from t where name = :needle', {
				needle: null,
				':needle': [1, 2],
			});
			// `name = NULL` matches nothing, but crucially raises no error.
			expect(rows).to.have.length(0);
		});
	});
});
