import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { MisuseError } from '../src/common/errors.js';
import type { SqlParameters, SqlValue } from '../src/common/types.js';
import type { WatchScope } from '../src/planner/analysis/change-scope.js';

type Params = SqlValue[] | Record<string, SqlValue>;

/**
 * One parameter, many spellings (ticket
 * `bug-colon-prefixed-parameter-bindings-never-resolve`).
 *
 * A caller may name a parameter `:p`, `$p` or the bare `p`, and a positional slot
 * `1`, `'1'`, `':1'` or `':01'`. Each of those names ONE parameter, at every
 * ingress and for every reader downstream of it. That used to be untrue: the key
 * entered `boundArgs` verbatim and five readers each guessed differently at what
 * counted as the same parameter, so a statement whose only binding was `:p` typed
 * and validated fine and then died at run time with "Parameter with name 'p' not
 * found."
 *
 * The matrix below is the point of the fix: it crosses every spelling with every
 * ingress, so a sixth reader (or a new entry point) that invents its own key rule
 * fails here rather than in a caller's query.
 */

/** Value every case binds and expects back. */
const VALUE = 9;

interface Ingress {
	readonly name: string;
	/**
	 * Binds `params` through this entry point against a statement using `paramExpr`
	 * as its sole parameter, and returns the value the engine actually resolved.
	 */
	readonly run: (db: Database, paramExpr: string, params: Params) => Promise<SqlValue>;
}

async function firstValue(rows: AsyncIterable<Record<string, SqlValue>>): Promise<SqlValue> {
	for await (const row of rows) return row.v;
	throw new Error('statement produced no rows');
}

/** Reads back the row a write-shaped ingress inserted. */
async function readProbe(db: Database): Promise<SqlValue> {
	const row = await db.get('select v from probe where id = 1');
	if (!row) throw new Error('insert produced no row');
	return row.v;
}

const INGRESSES: readonly Ingress[] = [
	{
		name: 'db.prepare(sql, params)',
		run: async (db, expr, params) => {
			const stmt = db.prepare(`select ${expr} as v`, params);
			try {
				return await firstValue(stmt.all());
			} finally {
				await stmt.finalize();
			}
		},
	},
	{
		name: 'db.get(sql, params)',
		run: async (db, expr, params) => {
			const row = await db.get(`select ${expr} as v`, params);
			if (!row) throw new Error('statement produced no rows');
			return row.v;
		},
	},
	{
		name: 'db.eval(sql, params)',
		run: (db, expr, params) => firstValue(db.eval(`select ${expr} as v`, params)),
	},
	{
		name: 'db.exec(sql, params)',
		run: async (db, expr, params) => {
			await db.exec(`insert into probe (id, v) values (1, ${expr})`, params as SqlParameters);
			return readProbe(db);
		},
	},
	{
		name: 'stmt.bind(key, value)',
		run: async (db, expr, params) => {
			const stmt = db.prepare(`select ${expr} as v`);
			try {
				if (Array.isArray(params)) {
					params.forEach((value, index) => stmt.bind(index + 1, value));
				} else {
					for (const [key, value] of Object.entries(params)) stmt.bind(key, value);
				}
				return await firstValue(stmt.all());
			} finally {
				await stmt.finalize();
			}
		},
	},
	{
		name: 'stmt.bindAll(params)',
		run: async (db, expr, params) => {
			const stmt = db.prepare(`select ${expr} as v`);
			try {
				stmt.bindAll(params);
				return await firstValue(stmt.all());
			} finally {
				await stmt.finalize();
			}
		},
	},
	{
		name: 'stmt.all(params)',
		run: async (db, expr, params) => {
			const stmt = db.prepare(`select ${expr} as v`);
			try {
				return await firstValue(stmt.all(params));
			} finally {
				await stmt.finalize();
			}
		},
	},
	{
		name: 'stmt.run(params)',
		run: async (db, expr, params) => {
			const stmt = db.prepare(`insert into probe (id, v) values (1, ${expr})`);
			try {
				await stmt.run(params);
			} finally {
				await stmt.finalize();
			}
			return readProbe(db);
		},
	},
];

/** A spelling of the one parameter in `paramExpr`, as a bound-parameter argument. */
interface Spelling {
	readonly name: string;
	readonly params: Params;
}

const NAMED_SPELLINGS: readonly Spelling[] = [
	{ name: `{ p: ${VALUE} }`, params: { p: VALUE } },
	{ name: `{ ':p': ${VALUE} }`, params: { ':p': VALUE } },
	{ name: `{ '$p': ${VALUE} }`, params: { $p: VALUE } },
];

const POSITIONAL_SPELLINGS: readonly Spelling[] = [
	{ name: `[${VALUE}]`, params: [VALUE] },
	{ name: `{ '1': ${VALUE} }`, params: { 1: VALUE } },
	{ name: `{ ':1': ${VALUE} }`, params: { ':1': VALUE } },
	{ name: `{ ':01': ${VALUE} }`, params: { ':01': VALUE } },
];

describe('Parameter key spellings', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('pragma default_vtab_module=memory');
		await db.exec('create table probe (id integer primary key, v integer)');
	});

	afterEach(async () => {
		await db.close();
	});

	describe('spelling × ingress matrix', () => {
		const matrix: readonly { readonly label: string; readonly exprs: readonly string[]; readonly spellings: readonly Spelling[] }[] = [
			{ label: 'named', exprs: [':p', '$p'], spellings: NAMED_SPELLINGS },
			{ label: 'positional', exprs: [':1', '?'], spellings: POSITIONAL_SPELLINGS },
		];

		for (const { label, exprs, spellings } of matrix) {
			describe(label, () => {
				for (const expr of exprs) {
					for (const spelling of spellings) {
						for (const ingress of INGRESSES) {
							it(`${expr} bound as ${spelling.name} via ${ingress.name}`, async () => {
								expect(await ingress.run(db, expr, spelling.params)).to.equal(VALUE);
							});
						}
					}
				}
			});
		}
	});

	// `$1` is a legal spelling of a positional slot for the same reason `$p` is a
	// legal spelling of a name — the parser treats `:` and `$` as interchangeable
	// prefixes — but it is rare enough not to earn a row in the matrix above.
	it('accepts a $-prefixed positional index', async () => {
		expect(await db.get('select :1 as v', { $1: VALUE })).to.deep.equal({ v: VALUE });
	});

	// `@` is NOT a Quereus parameter prefix (the lexer has no `@` token), so `@p`
	// names a parameter no statement can reference — it must not be normalized into
	// a binding for `:p`.
	it('does not treat @name as a spelling of name', async () => {
		let error: Error | undefined;
		try {
			await db.get('select :p as v', { '@p': VALUE });
		} catch (e) {
			error = e as Error;
		}
		expect(error, 'expected the unbound :p to be reported').to.exist;
		expect(error!.message).to.include(`Parameter with name 'p' not found`);
	});

	describe('rejects two spellings of one parameter in a single object', () => {
		/** Every object-shaped ingress; `stmt.bind` is excluded by design (see below). */
		const objectIngresses: readonly { readonly name: string; readonly run: (db: Database, params: Params) => Promise<unknown> }[] = [
			{ name: 'db.prepare', run: async (db, params) => { await db.prepare('select :p as v', params).finalize(); } },
			{ name: 'db.get', run: (db, params) => db.get('select :p as v', params) },
			{ name: 'db.eval', run: (db, params) => firstValue(db.eval('select :p as v', params)) },
			{ name: 'db.exec', run: (db, params) => db.exec('insert into probe (id, v) values (1, :p)', params as SqlParameters) },
			{
				name: 'stmt.bindAll',
				run: async (db, params) => {
					const stmt = db.prepare('select :p as v');
					try { stmt.bindAll(params); } finally { await stmt.finalize(); }
				},
			},
			{
				name: 'stmt.all',
				run: async (db, params) => {
					const stmt = db.prepare('select :p as v');
					try { await firstValue(stmt.all(params)); } finally { await stmt.finalize(); }
				},
			},
			{
				name: 'stmt.run',
				run: async (db, params) => {
					const stmt = db.prepare('insert into probe (id, v) values (1, :p)');
					try { await stmt.run(params); } finally { await stmt.finalize(); }
				},
			},
			{
				name: 'stmt.getChangeScope',
				run: async (db, params) => {
					const stmt = db.prepare('select * from probe where id = :p');
					try { stmt.getChangeScope(params); } finally { await stmt.finalize(); }
				},
			},
		];

		const collisions: readonly { readonly name: string; readonly params: Record<string, SqlValue> }[] = [
			{ name: `bare and ':'-prefixed`, params: { p: 1, ':p': 2 } },
			{ name: `':'- and '$'-prefixed`, params: { ':p': 1, $p: 2 } },
			{ name: 'positional index and its leading-zero form', params: { 1: 1, ':01': 2 } },
		];

		for (const ingress of objectIngresses) {
			for (const collision of collisions) {
				it(`${ingress.name} — ${collision.name}`, async () => {
					let error: Error | undefined;
					try {
						await ingress.run(db, collision.params);
					} catch (e) {
						error = e as Error;
					}
					expect(error, 'expected the duplicate binding to be rejected').to.exist;
					expect(error).to.be.instanceof(MisuseError);
					expect(error!.message).to.match(/bound twice/);
				});
			}
		}

		// The rule is per-object, not per-parameter-lifetime: each bind() call is a
		// separate statement of intent, and overwriting is what a second bind of the
		// same key already did.
		it('but repeated bind() calls stay last-wins', async () => {
			const stmt = db.prepare('select :p as v');
			try {
				stmt.bind('p', 1);
				stmt.bind(':p', 2);
				expect(await firstValue(stmt.all())).to.equal(2);
			} finally {
				await stmt.finalize();
			}
		});
	});

	describe('bind() index range', () => {
		// ':0' normalizes to positional slot 0, which does not exist — `?` indices are
		// 1-based — so it must be rejected exactly as bind(0, …) is.
		for (const key of [0, '0', ':0', ':00'] as const) {
			it(`rejects bind(${JSON.stringify(key)})`, async () => {
				const stmt = db.prepare('select ? as v');
				try {
					expect(() => stmt.bind(key, VALUE)).to.throw(RangeError, /out of range/);
				} finally {
					await stmt.finalize();
				}
			});
		}
	});

	describe('a rejected bindAll leaves the previous bindings in place', () => {
		it('keeps the earlier value after a collision', async () => {
			const stmt = db.prepare('select :p as v');
			try {
				stmt.bindAll({ ':p': VALUE });
				expect(() => stmt.bindAll({ p: 1, ':p': 2 })).to.throw(MisuseError);
				expect(await firstValue(stmt.all())).to.equal(VALUE);
			} finally {
				await stmt.finalize();
			}
		});
	});

	describe('getChangeScope', () => {
		/**
		 * The arm that failed SILENTLY before the fix: `bindParameters` stripped the
		 * prefix from the plan-side id (already bare, so the strip was inert) instead
		 * of from the caller's key, so a `:p` binding was never found. No error — the
		 * parameter just stayed in `unboundParameters`, and a caller watching the scope
		 * watched the whole table instead of one row without ever learning.
		 */
		for (const spelling of NAMED_SPELLINGS) {
			it(`substitutes a named parameter bound as ${spelling.name}`, async () => {
				const stmt = db.prepare('select * from probe where id = :p');
				try {
					const scope = stmt.getChangeScope(spelling.params);
					expect(scope.unboundParameters).to.deep.equal([]);
					const watched = scope.watches[0].scope as Extract<WatchScope, { kind: 'rows' }>;
					expect(watched.kind).to.equal('rows');
					expect(watched.values).to.deep.equal([[VALUE]]);
				} finally {
					await stmt.finalize();
				}
			});
		}

		for (const spelling of POSITIONAL_SPELLINGS) {
			it(`substitutes a positional parameter bound as ${spelling.name}`, async () => {
				const stmt = db.prepare('select * from probe where id = ?');
				try {
					const scope = stmt.getChangeScope(spelling.params);
					expect(scope.unboundParameters).to.deep.equal([]);
					const watched = scope.watches[0].scope as Extract<WatchScope, { kind: 'rows' }>;
					expect(watched.values).to.deep.equal([[VALUE]]);
				} finally {
					await stmt.finalize();
				}
			});
		}
	});
	/**
	 * A parameter name is caller text, so it can collide with an `Object.prototype`
	 * member. Bound args used to be a plain `{}`, which answers `:toString` with an
	 * inherited function: `select :toString` returned a JS function as a SQL value
	 * instead of reporting the parameter unbound.
	 */
	describe('parameters named after Object.prototype members', () => {
		for (const name of ['toString', 'constructor', 'valueOf', 'hasOwnProperty'] as const) {
			it(`reports :${name} unbound when nothing was bound`, async () => {
				let error: Error | undefined;
				try {
					await db.get(`select :${name} as v`);
				} catch (e) {
					error = e as Error;
				}
				expect(error, `expected the unbound :${name} to be reported`).to.exist;
				expect(error!.message).to.include(`Parameter with name '${name}' not found`);
			});

			it(`resolves :${name} when it IS bound`, async () => {
				expect(await db.get(`select :${name} as v`, { [`:${name}`]: VALUE })).to.deep.equal({ v: VALUE });
			});
		}

		it('reports an unbound prototype-named parameter through db.exec too', async () => {
			let error: Error | undefined;
			try {
				await db.exec('insert into probe (id, v) values (1, :toString)', { other: VALUE });
			} catch (e) {
				error = e as Error;
			}
			expect(error, 'expected the unbound :toString to be reported').to.exist;
			expect(error!.message).to.include(`Parameter with name 'toString' not found`);
		});

		it('leaves a prototype-named parameter in unboundParameters for getChangeScope', async () => {
			const stmt = db.prepare('select * from probe where id = :toString');
			try {
				expect(stmt.getChangeScope({}).unboundParameters).to.deep.equal(['toString']);
				expect(stmt.getChangeScope({ ':toString': VALUE }).unboundParameters).to.deep.equal([]);
			} finally {
				await stmt.finalize();
			}
		});
	});
});
