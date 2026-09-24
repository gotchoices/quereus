import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { QuereusError } from '../src/common/errors.js';
import { StatusCode } from '../src/common/types.js';
import type { SqlValue } from '../src/common/types.js';
import { CastNode, LiteralNode } from '../src/planner/nodes/scalar.js';
import { wrapInCast } from '../src/planner/building/coercion.js';
import { EmptyScope } from '../src/planner/scopes/empty.js';
import type { Scope } from '../src/planner/scopes/scope.js';
import type * as AST from '../src/parser/ast.js';

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

				it('bare textcol = :p, even where JSON coercion could have matched', async () => {
					// The deliberate pessimism of reading through the coercion cast: on a
					// typed path `doc = :p` builds as `cast(doc as json) = :p`, which would
					// have matched row 1. It is rejected anyway so that `db.eval` — which
					// plans `:p` as ANY, mints no coercion, and genuinely cannot match —
					// gives the same answer. `cast(doc as json) = :p` is the spelling that
					// opts into the JSON comparison; see the over-fire group below.
					await db.exec('create table jt (id integer primary key, doc text) using memory');
					await db.exec(`insert into jt (id, doc) values (1, '[1,2,3]'), (2, '[4,5]')`);
					await expectMismatch('select id from jt where doc = :p', { p: [1, 2, 3] });
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

	describe('db.eval carrying execution options', () => {
		// Options make `eval` route through `prepare`, so its parameters are typed and
		// the comparison gets the coercion cast — the third entry point the original
		// ticket named as silently returning nothing. One case rather than a fourth
		// `paths` entry: the property that distinguishes an entry point here is only
		// whether the plan knows the parameter's type, which this shares with
		// `db.prepare`, so replaying all 17 cases would discriminate nothing.
		it('throws on id = ? with an array-bound parameter', async () => {
			let error: Error | undefined;
			try {
				for await (const _row of db.eval('select * from t where id = ?', [[1, 2]], { readConcurrency: 'committed' })) {
					// no rows expected — the bind is rejected before execution
				}
			} catch (e) {
				error = e as Error;
			}
			expect(error).to.be.instanceof(QuereusError);
			expect((error as QuereusError).code).to.equal(StatusCode.MISMATCH);
			expect(error!.message).to.include('scalar comparison');
		});
	});

	describe('CastNode.synthetic', () => {
		// The guard reads this flag to tell a coercion cast the planner minted from a
		// `cast(x as t)` the user wrote, and nothing re-derives it — so a rebuild that
		// dropped it would silently disable the guard on every typed path again, with
		// the end-to-end cases above still passing on the unrebuilt plan.
		const scope = EmptyScope.instance as unknown as Scope;

		function literal(value: SqlValue): LiteralNode {
			return new LiteralNode(scope, { type: 'literal', value } as AST.LiteralExpr);
		}

		it('is false for a user-written cast and true for a coercion cast', () => {
			const operand = literal(1);
			const written = new CastNode(scope, { type: 'cast', expr: operand.expression, targetType: 'json' }, operand);
			expect(written.synthetic).to.equal(false);
			expect(wrapInCast(scope, operand, 'json').synthetic).to.equal(true);
		});

		it('survives withChildren, in both states', () => {
			for (const original of [wrapInCast(scope, literal(1), 'json'), new CastNode(scope, { type: 'cast', expr: literal(1).expression, targetType: 'json' }, literal(1))]) {
				const rebuilt = original.withChildren([literal(2)]) as CastNode;
				expect(rebuilt).to.not.equal(original);
				expect(rebuilt.synthetic).to.equal(original.synthetic);
			}
		});
	});

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
