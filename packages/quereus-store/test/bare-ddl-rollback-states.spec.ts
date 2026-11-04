/**
 * The bare store module (no isolation wrapper) vs. rollback, for the DDL that stays inside the
 * open transaction: `create [unique] index`, `add constraint … unique`, and a `set not null` that
 * sees no NULL.
 *
 * DDL survives a rollback while the rows it judged do not, and here those rows live in the
 * coordinator's op log. So each statement judges the committed rows and each open savepoint's
 * rows too, refusing with BUSY when one of them breaks the new rule — and a structure it builds
 * has to agree with whichever state the transaction ends in, or a restored row is unindexed and
 * a later duplicate of it is accepted silently.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, QuereusError, StatusCode, asyncIterableToArray } from '@quereus/quereus';
import {
	StoreModule,
	InMemoryKVStore,
	type KVStoreProvider,
} from '../src/index.js';

function createInMemoryProvider(): KVStoreProvider {
	const stores = new Map<string, InMemoryKVStore>();
	const get = (key: string): InMemoryKVStore => {
		if (!stores.has(key)) stores.set(key, new InMemoryKVStore());
		return stores.get(key)!;
	};
	return {
		async getStore(schemaName: string, tableName: string) {
			return get(`${schemaName}.${tableName}`);
		},
		async getIndexStore(schemaName: string, tableName: string, indexName: string) {
			return get(`${schemaName}.${tableName}_idx_${indexName}`);
		},
		async getStatsStore(schemaName: string, tableName: string) {
			return get(`${schemaName}.${tableName}.__stats__`);
		},
		async getCatalogStore() {
			return get('__catalog__');
		},
		async closeStore() { /* no-op for in-memory stores */ },
		async closeIndexStore() { /* no-op for in-memory stores */ },
		async closeAll() {
			for (const store of stores.values()) await store.close();
			stores.clear();
		},
	};
}

/** The statements that stay inside the transaction and judge rows for uniqueness. */
const UNIQUE_ARMS = [
	{ arm: 'create unique index', ddl: `create unique index ux on t (v)` },
	{ arm: 'add constraint unique', ddl: `alter table t add constraint uq unique (v)` },
] as const;

describe('Bare store DDL vs. the states a rollback could restore', () => {
	let db: Database;
	let provider: KVStoreProvider;
	let storeModule: StoreModule;

	beforeEach(() => {
		db = new Database();
		provider = createInMemoryProvider();
		storeModule = new StoreModule(provider);
		db.registerModule('store', storeModule);
	});

	afterEach(async () => {
		await provider.closeAll();
	});

	async function refusal(sql: string): Promise<QuereusError> {
		try {
			await db.exec(sql);
		} catch (e) {
			if (e instanceof QuereusError) return e;
			throw e;
		}
		return expect.fail(`expected a refusal of: ${sql}`);
	}

	async function expectRefusedBusy(sql: string): Promise<void> {
		const error = await refusal(sql);
		expect(error.code, error.message).to.equal(StatusCode.BUSY);
		expect(error.message).to.match(/commit the pending writes first/i);
	}

	const ids = async (sql: string): Promise<number[]> =>
		(await asyncIterableToArray(db.eval(sql))).map(row => row.id as number);

	for (const { arm, ddl } of UNIQUE_ARMS) {
		describe(arm, () => {
			beforeEach(async () => {
				await db.exec(`create table t (id integer primary key, v text) using store`);
			});

			it('refuses when a committed duplicate would come back on rollback', async () => {
				await db.exec(`insert into t values (1, 'a'), (2, 'a')`);

				await db.exec(`begin`);
				await db.exec(`delete from t where id = 2`);
				await expectRefusedBusy(ddl);

				// The transaction is intact and the same statement is legal once the write is durable.
				expect(await ids(`select id from t`)).to.deep.equal([1]);
				await db.exec(`commit`);
				await db.exec(ddl);
				const conflict = await refusal(`insert into t values (9, 'a')`);
				expect(conflict.code).to.equal(StatusCode.CONSTRAINT);
			});

			it('refuses when only an open savepoint holds the duplicate', async () => {
				await db.exec(`insert into t values (1, 'a')`);

				await db.exec(`begin`);
				await db.exec(`insert into t values (2, 'a')`);
				await db.exec(`savepoint s`);
				await db.exec(`delete from t where id = 2`);
				await expectRefusedBusy(ddl);

				await db.exec(`rollback to s`);
				expect(await ids(`select id from t order by id`)).to.deep.equal([1, 2]);
				await db.exec(`rollback`);
				await db.exec(ddl);
			});

			it('stops refusing once the savepoint holding the duplicate is released', async () => {
				await db.exec(`insert into t values (1, 'a')`);

				await db.exec(`begin`);
				await db.exec(`insert into t values (2, 'a')`);
				await db.exec(`savepoint s`);
				await db.exec(`delete from t where id = 2`);
				await db.exec(`release s`);
				await db.exec(ddl);
				await db.exec(`commit`);
				expect(await ids(`select id from t`)).to.deep.equal([1]);
			});

			it('keeps CONSTRAINT for a duplicate the transaction can see', async () => {
				await db.exec(`insert into t values (1, 'a'), (2, 'a')`);

				await db.exec(`begin`);
				await db.exec(`insert into t values (3, 'b')`);
				const error = await refusal(ddl);
				expect(error.code, error.message).to.equal(StatusCode.CONSTRAINT);
				await db.exec(`commit`);
			});

			it('accepts a deleted row that breaks no rule, and enforces against it after rollback', async () => {
				await db.exec(`insert into t values (1, 'a'), (2, 'b')`);

				await db.exec(`begin`);
				await db.exec(`delete from t where id = 2`);
				await db.exec(ddl);
				await db.exec(`rollback`);

				expect(await ids(`select id from t order by id`)).to.deep.equal([1, 2]);
				const conflict = await refusal(`insert into t values (3, 'b')`);
				expect(conflict.code, conflict.message).to.equal(StatusCode.CONSTRAINT);
			});

			it('enforces the rows of the savepoint a rollback-to restores', async () => {
				await db.exec(`insert into t values (1, 'a')`);

				await db.exec(`begin`);
				await db.exec(`insert into t values (2, 'b')`);
				await db.exec(`savepoint s`);
				await db.exec(`delete from t where id = 2`);
				await db.exec(ddl);

				// 'b' is free while the delete stands…
				await db.exec(`insert into t values (3, 'b')`);
				await db.exec(`rollback to s`);
				// …and taken again once it is undone. Row 3 went with it.
				const conflict = await refusal(`insert into t values (4, 'b')`);
				expect(conflict.code, conflict.message).to.equal(StatusCode.CONSTRAINT);
				await db.exec(`commit`);
				expect(await ids(`select id from t order by id`)).to.deep.equal([1, 2]);
			});

			it('frees the value of a row the committed transaction deleted', async () => {
				await db.exec(`insert into t values (1, 'a'), (2, 'b')`);

				await db.exec(`begin`);
				await db.exec(`delete from t where id = 2`);
				await db.exec(ddl);
				await db.exec(`commit`);

				await db.exec(`insert into t values (3, 'b')`);
				expect(await ids(`select id from t order by id`)).to.deep.equal([1, 3]);
			});
		});
	}

	describe('create index over rows the transaction overwrote', () => {
		beforeEach(async () => {
			await db.exec(`create table t (id integer primary key, v text) using store`);
			await db.exec(`insert into t values (1, 'a'), (2, 'm')`);
			await db.exec(`begin`);
			await db.exec(`update t set v = 'b' where id = 1`);
			await db.exec(`delete from t where id = 2`);
			await db.exec(`create index ix on t (v)`);
		});

		it('finds the restored values after rollback', async () => {
			await db.exec(`rollback`);
			expect(await ids(`select id from t where v = 'a'`)).to.deep.equal([1]);
			expect(await ids(`select id from t where v = 'm'`)).to.deep.equal([2]);
			expect(await ids(`select id from t where v = 'b'`)).to.deep.equal([]);
		});

		it('leaves no second entry for an overwritten row after rollback', async () => {
			await db.exec(`rollback`);
			expect(await ids(`select id from t where v >= 'a' and v <= 'z' order by v`)).to.deep.equal([1, 2]);
		});

		it('leaves no second entry for an overwritten row after commit', async () => {
			await db.exec(`commit`);
			expect(await ids(`select id from t where v >= 'a' and v <= 'z' order by v`)).to.deep.equal([1]);
			expect(await ids(`select id from t where v = 'a'`)).to.deep.equal([]);
		});

		it('reads its own writes through the new index', async () => {
			expect(await ids(`select id from t where v >= 'a' and v <= 'z' order by v`)).to.deep.equal([1]);
			await db.exec(`rollback`);
		});
	});

	describe('alter column … set not null', () => {
		beforeEach(async () => {
			await db.exec(`create table t (id integer primary key, v text null) using store`);
		});

		it('refuses when a committed NULL the transaction overwrote or deleted would come back', async () => {
			await db.exec(`insert into t values (1, null), (2, null)`);

			await db.exec(`begin`);
			await db.exec(`update t set v = 'x' where id = 1`);
			await db.exec(`delete from t where id = 2`);
			await expectRefusedBusy(`alter table t alter column v set not null`);

			expect(await asyncIterableToArray(db.eval(`select id, v from t`))).to.deep.equal([{ id: 1, v: 'x' }]);
			await db.exec(`commit`);
			await db.exec(`alter table t alter column v set not null`);
		});

		it('refuses when only an open savepoint holds the NULL', async () => {
			await db.exec(`insert into t values (1, 'x')`);

			await db.exec(`begin`);
			await db.exec(`insert into t values (2, null)`);
			await db.exec(`savepoint s`);
			await db.exec(`delete from t where id = 2`);
			await expectRefusedBusy(`alter table t alter column v set not null`);
			await db.exec(`rollback`);
		});

		it('keeps CONSTRAINT for a NULL the transaction can see', async () => {
			await db.exec(`insert into t values (1, null)`);

			await db.exec(`begin`);
			await db.exec(`insert into t values (2, 'x')`);
			const error = await refusal(`alter table t alter column v set not null`);
			expect(error.code, error.message).to.equal(StatusCode.CONSTRAINT);
			await db.exec(`rollback`);
		});

		it('takes the committing backfill when a DEFAULT can fill a restorable NULL', async () => {
			await db.exec(`create table d (id integer primary key, v text null default 'filled') using store`);
			await db.exec(`insert into d values (1, null)`);

			await db.exec(`begin`);
			await db.exec(`update d set v = 'x' where id = 1`);
			await db.exec(`alter table d alter column v set not null`);
			// The backfill flushed the transaction, so no rollback can bring the NULL back.
			await db.exec(`rollback`);
			expect(await db.get(`select v from d where id = 1`)).to.deep.equal({ v: 'x' });
		});

		it('accepts when no state holds a NULL, and stays inside the transaction', async () => {
			await db.exec(`insert into t values (1, 'x')`);

			await db.exec(`begin`);
			await db.exec(`update t set v = 'y' where id = 1`);
			await db.exec(`alter table t alter column v set not null`);
			await db.exec(`rollback`);
			expect(await db.get(`select v from t where id = 1`)).to.deep.equal({ v: 'x' });
		});
	});

	describe('an arm whose flush leaves no rollback state to judge', () => {
		it('retypes past a deleted row that could not convert', async () => {
			await db.exec(`create table t (id integer primary key, v text) using store`);
			await db.exec(`insert into t values (1, 'not a number'), (2, '7')`);

			await db.exec(`begin`);
			await db.exec(`delete from t where id = 1`);
			await db.exec(`alter table t alter column v set data type integer`);
			await db.exec(`rollback`);
			expect(await asyncIterableToArray(db.eval(`select id, v from t`))).to.deep.equal([{ id: 2, v: 7 }]);
		});

		it('recollates past a deleted row that would collide', async () => {
			await db.exec(`create table t (id integer primary key, v text collate binary unique) using store`);
			await db.exec(`insert into t values (1, 'a'), (2, 'A')`);

			await db.exec(`begin`);
			await db.exec(`delete from t where id = 2`);
			await db.exec(`alter table t alter column v set collate nocase`);
			await db.exec(`rollback`);
			expect(await ids(`select id from t`)).to.deep.equal([1]);
		});
	});

	it('a failed create index leaves nothing queued against its torn-down store', async () => {
		await db.exec(`create table t (id integer primary key, v text) using store`);
		await db.exec(`insert into t values (1, 'a')`);

		await db.exec(`begin`);
		await db.exec(`insert into t values (2, 'b')`);

		const saveTableDDL = storeModule.saveTableDDL.bind(storeModule);
		storeModule.saveTableDDL = async () => { throw new Error('catalog write refused'); };
		const error = await refusal(`create index ix on t (v)`).finally(() => {
			storeModule.saveTableDDL = saveTableDDL;
		});
		expect(error.message).to.match(/catalog write refused/);

		// Commit would write a surviving op into a store the failure closed and deleted.
		await db.exec(`commit`);
		expect(await ids(`select id from t order by id`)).to.deep.equal([1, 2]);
	});
});
