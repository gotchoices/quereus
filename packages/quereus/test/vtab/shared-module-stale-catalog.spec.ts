/**
 * Two `Database`s can register one module instance and so share a physical table, but each
 * keeps its own catalog. When one ALTERs the table, the other's catalog entry goes stale; a
 * connect against it must fail with SCHEMA rather than read values under the wrong names or
 * write them into the wrong columns.
 */
import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import { QuereusError } from '../../src/common/errors.js';
import { StatusCode } from '../../src/common/types.js';

async function rows(db: Database, sql: string): Promise<Record<string, unknown>[]> {
	const out: Record<string, unknown>[] = [];
	for await (const row of db.eval(sql)) out.push({ ...row });
	return out;
}

async function codeOf(work: Promise<unknown>): Promise<StatusCode | undefined> {
	try {
		await work;
	} catch (e) {
		if (!(e instanceof QuereusError)) throw e;
		return e.code;
	}
	return undefined;
}

describe('Shared module, stale catalog in another Database', () => {
	let dbA: Database;
	let dbB: Database;

	beforeEach(async () => {
		const shared = new MemoryTableModule();
		dbA = new Database();
		dbB = new Database();
		dbA.registerModule('shared', shared);
		dbB.registerModule('shared', shared);
		await dbA.exec(`create table t (id integer primary key, x integer, z text) using shared`);
		await dbA.exec(`insert into t values (1, 1, 'zz')`);
		dbB.schemaManager.getMainSchema().addTable(dbA.schemaManager.getTable('main', 't')!);
	});

	afterEach(async () => {
		await dbA.close();
		await dbB.close();
	});

	it('fails reads and writes with SCHEMA after another connection drops a column, leaving the rows intact', async () => {
		await dbA.exec(`alter table t drop column x`);

		expect(await codeOf(rows(dbB, 'select * from t')), 'stale read').to.equal(StatusCode.SCHEMA);
		expect(await codeOf(dbB.exec(`insert into t (id, x, z) values (2, 2, 'w')`)), 'stale write').to.equal(StatusCode.SCHEMA);
		expect(await rows(dbA, 'select * from t')).to.deep.equal([{ id: 1, z: 'zz' }]);
	});

	it('keeps working after another connection changes only tags', async () => {
		await dbA.exec(`alter table t set tags (k = 'x')`);

		await dbB.exec(`insert into t values (2, 2, 'w')`);
		expect(await rows(dbB, 'select * from t order by id')).to.deep.equal([
			{ id: 1, x: 1, z: 'zz' },
			{ id: 2, x: 2, z: 'w' },
		]);
	});
});
