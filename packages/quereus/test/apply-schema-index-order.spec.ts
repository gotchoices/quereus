/**
 * `apply schema` creates indexes AFTER the table-alter block (see `generateMigrationPlan` and
 * docs/schema.md § Migration Order), so one round can add or rename a column and index it.
 * Before, the index create ran ahead of `ADD COLUMN` / `RENAME COLUMN` and failed with
 * "Column ... not found".
 */

import { expect } from 'chai';
import { Database } from '../src/index.js';
import { collectSchemaCatalog } from '../src/schema/catalog.js';
import { renderCatalogForComparison } from '../src/schema/catalog-rendering.js';
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

function indexNames(db: Database, table: string): string[] {
	return collectSchemaCatalog(db, 'main').indexes.filter(i => i.tableName === table).map(i => i.name);
}

describe('apply schema: index creates run after the table-alter block', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it('adds a nullable column and an index on it in one apply', async () => {
		await db.exec('declare schema main { table t { id integer primary key } }');
		await db.exec('apply schema main');
		await db.exec('insert into t (id) values (1)');

		await db.exec('declare schema main { table t { id integer primary key, b text null } index t_b on t (b) }');
		await db.exec('apply schema main');

		expect(indexNames(db, 't')).to.deep.equal(['t_b']);
		expect(await rows(db, 'select id, b from t')).to.deep.equal([{ id: 1, b: null }]);
		await db.exec("insert into t (id, b) values (2, 'x')");
		expect(await rows(db, "select id from t where b = 'x'")).to.deep.equal([{ id: 2 }]);
		expect(await rows(db, 'diff schema main')).to.deep.equal([]);
	});

	it('renames a column (hinted) and indexes the new name in one apply', async () => {
		await db.exec('declare schema main { table t { id integer primary key, oldc text null } }');
		await db.exec('apply schema main');
		await db.exec("insert into t (id, oldc) values (1, 'a')");

		await db.exec(`declare schema main {
			table t { id integer primary key, newc text null with tags ("quereus.previous_name" = 'oldc') }
			index t_newc on t (newc)
		}`);
		await db.exec('apply schema main');

		expect(indexNames(db, 't')).to.deep.equal(['t_newc']);
		expect(await rows(db, "select id from t where newc = 'a'")).to.deep.equal([{ id: 1 }]);
		expect(await rows(db, 'diff schema main')).to.deep.equal([]);
	});

	it('a version that drops an index together with its column still applies', async () => {
		await db.exec('declare schema main { table t { id integer primary key, b text null } index t_b on t (b) }');
		await db.exec('apply schema main');

		await db.exec('declare schema main { table t { id integer primary key } }');
		await db.exec('apply schema main');

		expect(indexNames(db, 't')).to.deep.equal([]);
	});

	it('a failure after the moved index create restores the pre-apply catalog', async () => {
		await db.exec('declare schema main { table t { id integer primary key, c integer } }');
		await db.exec('apply schema main');
		await db.exec('insert into t (id, c) values (1, 7), (2, 7)');
		const before = renderCatalogForComparison(collectSchemaCatalog(db, 'main'));

		// Plan: ADD COLUMN b, CREATE INDEX t_b (succeeds), then CREATE UNIQUE INDEX t_c — which the duplicate c values violate.
		await db.exec(`declare schema main {
			table t { id integer primary key, c integer, b text null }
			index t_b on t (b)
			unique index t_c on t (c)
		}`);
		const plan = (await rows(db, 'diff schema main')).map(r => String(r.ddl));
		const at = (re: RegExp): number => plan.findIndex(s => re.test(s));
		expect(at(/ADD COLUMN/i)).to.be.lessThan(at(/index t_b/i));
		expect(at(/index t_b/i)).to.be.lessThan(at(/index t_c/i));

		await rejection(db.exec('apply schema main'));

		expect(renderCatalogForComparison(collectSchemaCatalog(db, 'main'))).to.equal(before);
		expect(indexNames(db, 't')).to.deep.equal([]);
		expect(await rows(db, 'select id from t order by id')).to.deep.equal([{ id: 1 }, { id: 2 }]);
	});
});
