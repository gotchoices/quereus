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

		// View creates run ahead of the alters, so an added column's DEFAULT can read one. Moving view
		// creates after the alters has to keep this applying.
		it('applies a DEFAULT reading a view the same plan creates', async () => {
			await applies(`declare schema main {
				table u { id integer primary key, y integer null, z integer null default ((select m from w)) }
				view w as select max(b) as m from t
				table t { id integer primary key, b integer null }
			}`);
		});
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
	});
});
