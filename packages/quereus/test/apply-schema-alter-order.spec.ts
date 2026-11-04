/**
 * `apply schema` alters tables in stages that span every table, so a statement does not fail
 * because it needs something a table written later has yet to change. See `pushTableAlters` and
 * docs/schema-declarative.md § Migration Order, which also lists the known limits.
 */

import { expect } from 'chai';
import { Database } from '../src/index.js';
import { collectSchemaCatalog } from '../src/schema/catalog.js';
import { renderCatalogForComparison } from '../src/schema/catalog-rendering.js';
import { orderDependenciesFirst } from '../src/schema/dependency-order.js';
import type { SqlValue } from '../src/common/types.js';

async function rows(db: Database, sql: string): Promise<Array<Record<string, SqlValue>>> {
	const out: Array<Record<string, SqlValue>> = [];
	for await (const r of db.eval(sql)) out.push(r);
	return out;
}

async function rejection(p: Promise<unknown>): Promise<Error> {
	try {
		await p;
	} catch (e) {
		return e as Error;
	}
	throw new Error('expected the statement to reject');
}

describe('apply schema: table alters run in stages across tables', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	async function applies(declaration: string): Promise<void> {
		await db.exec(declaration);
		await db.exec('apply schema main');
		expect(await rows(db, 'diff schema main')).to.deep.equal([]);
	}

	describe('a table referring to something another table is gaining, written first', () => {
		beforeEach(async () => {
			await applies(`declare schema main {
				table t { id integer primary key, b integer null }
				table u { id integer primary key, y integer null }
			}`);
		});

		const forms: Array<[string, string]> = [
			['a named foreign key', 'y integer null, constraint fu foreign key (y) references t(d)'],
			['a named CHECK', 'y integer null, constraint cu check (y > (select max(d) from t))'],
			['an inline foreign key', 'y integer null, z integer null references t(d)'],
			['a DEFAULT subquery', 'y integer null, z integer null default ((select max(d) from t))'],
			['a generated column', 'y integer null, g integer generated always as ((select max(d) from t))'],
			['a new DEFAULT on an existing column', 'y integer null default ((select max(d) from t))'],
		];

		for (const [form, uBody] of forms) {
			it(`applies ${form}`, async () => {
				await applies(`declare schema main {
					table u { id integer primary key, ${uBody} }
					table t { id integer primary key, b integer null, d integer null unique }
				}`);
			});
		}

		it('applies a foreign key naming a column the other table renames', async () => {
			await applies(`declare schema main {
				table u { id integer primary key, y integer null, constraint fu foreign key (y) references t(b2) }
				table t { id integer primary key, b2 integer null unique with tags ("quereus.previous_name" = 'b') }
			}`);
		});

		// The two inline foreign keys read as a cycle, so declaration order holds and `u` adds its column
		// first: only the rename running ahead of every `ADD COLUMN` gets `z` a `t.b2` to name.
		it('applies an inline foreign key naming a renamed column when the tables also refer to each other', async () => {
			await applies(`declare schema main {
				table u { id integer primary key, y integer null, z integer null references t(b2) }
				table t { id integer primary key, b2 integer null with tags ("quereus.previous_name" = 'b'), x integer null references u(id) }
			}`);
		});

		it('applies two named foreign keys pointing at each other\'s new columns', async () => {
			await applies(`declare schema main {
				table t { id integer primary key, b integer null, d integer null unique, constraint ft foreign key (b) references u(w) }
				table u { id integer primary key, y integer null, w integer null unique, constraint fu foreign key (y) references t(d) }
			}`);
		});

		// A view follows the alters unless an added column reads it, as this DEFAULT does.
		it('applies a DEFAULT reading a view the same plan creates', async () => {
			await applies(`declare schema main {
				table u { id integer primary key, y integer null, z integer null default ((select m from w)) }
				view w as select max(b) as m from t
				table t { id integer primary key, b integer null }
			}`);
		});

		it('applies a DEFAULT reading a new view over a column its own table already has', async () => {
			await applies(`declare schema main {
				table t { id integer primary key, b integer null, z integer null default ((select m from w)) }
				view w as select max(b) as m from t
				table u { id integer primary key, y integer null }
			}`);
		});
	});

	describe('a new view reading what the plan changes', () => {
		beforeEach(async () => {
			await applies(`declare schema main {
				table t { id integer primary key, b integer null }
				table u { id integer primary key, y integer null }
			}`);
		});

		it('applies a view reading a column its table gains', async () => {
			await applies(`declare schema main {
				table t { id integer primary key, b integer null, d integer null }
				table u { id integer primary key, y integer null }
				view v as select d from t
			}`);
		});

		it('applies an edited view naming a column renamed in the same apply', async () => {
			await db.exec('create view v as select b from t');
			await applies(`declare schema main {
				table t { id integer primary key, b2 integer null with tags ("quereus.previous_name" = 'b') }
				table u { id integer primary key, y integer null }
				view v as select b2 from t where id > 0
			}`);
		});

		it('applies a view written before the new view it reads', async () => {
			await applies(`declare schema main {
				table t { id integer primary key, b integer null }
				table u { id integer primary key, y integer null }
				view c as select b from w
				view w as select b from t
			}`);
		});

		// `t` is not named by `v2`, and following `v1` to it would need a catalog `diff schema` lacks.
		it('applies a view reading a new column through an existing view', async () => {
			await db.exec('create view v1 as select * from t');
			await applies(`declare schema main {
				view v2 as select d from v1
				view v1 as select * from t
				table t { id integer primary key, b integer null, d integer null }
				table u { id integer primary key, y integer null }
			}`);
		});

		// `u` names only `v1`, but `v1` cannot be planned until the edited `v2` is back.
		it('applies a DEFAULT reading an existing view over a view the plan recreates', async () => {
			await db.exec('create view v2 as select b from t');
			await db.exec('create view v1 as select b from v2');
			await applies(`declare schema main {
				table t { id integer primary key, b integer null }
				table u { id integer primary key, y integer null, z integer null default ((select max(b) from v1)) }
				view v2 as select b from t where id > 0
				view v1 as select b from v2
			}`);
		});

		// `r1` has no need to follow `t`, and doing so must not stop `r2` following `u`.
		const readsNothingNew = 'view r1 as select max(id) as m from k';
		const readsGainedColumn = 'view r2 as select max(d) as m from u';
		const viewOrders: Array<[string, string]> = [['first', `${readsGainedColumn} ${readsNothingNew}`], ['second', `${readsNothingNew} ${readsGainedColumn}`]];

		for (const [position, views] of viewOrders) {
			it(`applies a view reading what one table gains while another table reads it, written ${position}`, async () => {
				await db.exec('create table k (id integer primary key)');
				await applies(`declare schema main {
					table k { id integer primary key }
					table t { id integer primary key, b integer null, z integer null default ((select m from r2)) }
					table u { id integer primary key, y integer null, d integer null, w integer null default ((select m from r1)) }
					${views}
				}`);
			});
		}

		const reader = 'table u { id integer primary key, y integer null, z integer null default ((select m from w)) }';
		const gainer = 'table t { id integer primary key, b integer null, d integer null }';
		const writtenOrders: Array<[string, string]> = [['the reader', `${reader} ${gainer}`], ['the gaining table', `${gainer} ${reader}`]];

		for (const [first, tables] of writtenOrders) {
			it(`applies a DEFAULT reading a view over a column another table gains, ${first} written first`, async () => {
				await applies(`declare schema main {
					${tables}
					view w as select max(d) as m from t
				}`);
			});
		}
	});

	describe('a table giving up something another table still refers to, written first', () => {
		const declareWithout = `declare schema main {
			table t { id integer primary key, b integer null }
			table u { id integer primary key, y integer null }
		}`;

		const forms: Array<[string, string]> = [
			['a named foreign key', 'constraint fu foreign key (y) references t(d)'],
			['a named CHECK', 'constraint cu check (y > (select max(d) from t))'],
			['an inline foreign key', 'z integer null references t(d)'],
			['a DEFAULT subquery', 'z integer null default ((select max(d) from t))'],
			['a generated column', 'g integer generated always as ((select max(d) from t))'],
		];

		for (const [form, uMember] of forms) {
			it(`applies when ${form} goes with the column`, async () => {
				await applies(`declare schema main {
					table t { id integer primary key, b integer null, d integer null unique }
					table u { id integer primary key, y integer null, ${uMember} }
				}`);
				await applies(declareWithout);
			});
		}

		it('orders the drops when the table a dropped default reads is also renamed', async () => {
			await applies(`declare schema main {
				table t { id integer primary key, d integer null }
				table u { id integer primary key, z integer null default ((select max(d) from t)) }
			}`);
			await applies(`declare schema main {
				table t2 { id integer primary key } with tags ("quereus.previous_name" = 't')
				table u { id integer primary key }
			}`);
		});
	});

	describe('a column added ahead of the key change it relies on, parent written first', () => {
		it('applies an inline foreign key naming the implicit key of a table changing its key width', async () => {
			await applies(`declare schema main {
				table t { a integer, b integer, d integer, primary key (a, b) }
				table u { id integer primary key }
			}`);
			await applies(`declare schema main {
				table t { a integer, b integer, d integer primary key }
				table u { id integer primary key, z integer null references t }
			}`);
		});

		it('validates an inline foreign key\'s default against the new key', async () => {
			await applies(`declare schema main {
				table t { id integer primary key, d integer }
				table u { id integer primary key }
			}`);
			await db.exec('insert into t (id, d) values (1, 50)');
			await db.exec('insert into u (id) values (1)');
			await applies(`declare schema main {
				table t { id integer, d integer primary key }
				table u { id integer primary key, z integer null default 50 references t }
			}`);
		});
	});

	it('a failure in a later stage reports its own error and restores the catalog', async () => {
		await applies(`declare schema main {
			table t { id integer primary key, b integer null }
			table u { id integer primary key, y integer null }
		}`);
		await db.exec('insert into t (id, b) values (1, 1), (2, 1)');
		const before = renderCatalogForComparison(collectSchemaCatalog(db, 'main'));

		await db.exec(`declare schema main {
			table u { id integer primary key, y integer null, constraint fu foreign key (y) references t(d) }
			table t { id integer primary key, b integer null, d integer null unique, constraint ub unique (b) }
		}`);
		const error = await rejection(db.exec('apply schema main'));

		expect(error.message).to.match(/ub/).and.not.match(/could not be restored/);
		expect(renderCatalogForComparison(collectSchemaCatalog(db, 'main'))).to.equal(before);
	});
});

describe('dependency ordering', () => {
	const key = (s: string): string => s;
	const edges = (from: Record<string, string[]>) => (s: string): string[] => from[s] ?? [];

	it('earliest ready goes first, and an order that already fits does not move', () => {
		expect(orderDependenciesFirst(['a', 'b', 'c'], key, edges({ a: ['c'] }))).to.deep.equal(['b', 'c', 'a']);
		expect(orderDependenciesFirst(['c', 'b', 'a'], key, edges({ a: ['c'] }))).to.deep.equal(['c', 'b', 'a']);
	});

	it('keeps a cycle in input order and orders everything else around it', () => {
		const inCycle = { x: ['a'], a: ['b'], b: ['a'] };
		expect(orderDependenciesFirst(['x', 'a', 'c', 'b'], key, edges(inCycle))).to.deep.equal(['a', 'x', 'c', 'b']);
		// `a` also waits on `d`, outside the cycle; `b` must not overtake it while it waits.
		expect(orderDependenciesFirst(['a', 'b', 'd'], key, edges({ a: ['b', 'd'], b: ['a'] }))).to.deep.equal(['d', 'a', 'b']);
	});

	// A column added to `a` reads view `v`, and `v` reads a column added to `b`. Keeping the cycle in
	// input order would run `v` before `b`, and creating `v` would then fail.
	it('a preferred dependency outranks a cycle\'s input order', () => {
		const inCycle = edges({ a: ['b', 'v'], b: ['a'] });
		expect(orderDependenciesFirst(['a', 'b', 'v'], key, inCycle, [edges({ v: ['b'] })])).to.deep.equal(['b', 'v', 'a']);
	});

	it('a preferred dependency orders items, and is skipped when it would close a cycle', () => {
		expect(orderDependenciesFirst(['v', 't'], key, edges({}), [edges({ v: ['t'] })])).to.deep.equal(['t', 'v']);
		expect(orderDependenciesFirst(['v', 't'], key, edges({ t: ['v'] }), [edges({ v: ['t'] })])).to.deep.equal(['v', 't']);
	});

	// Each preferred edge passes when checked against the required edges alone, but all of them
	// together would leave nothing ready to place.
	it('a preferred dependency is also skipped when it would close a cycle with other preferred ones', () => {
		const required = { t: ['v2'], s: ['v1'] };
		const preferred = { v1: ['t'], v2: ['s'] };
		expect(orderDependenciesFirst(['v1', 'v2', 't', 's'], key, edges(required), [edges(preferred)])).to.deep.equal(['v2', 't', 'v1', 's']);
	});
});
