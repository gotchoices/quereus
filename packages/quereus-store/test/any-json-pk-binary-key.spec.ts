/**
 * A store PK column whose declared type can hold text but is not `isTextual` — `any`, `json`,
 * and the temporal types — is keyed under hard-coded BINARY.
 *
 * These types supply their own `logicalType.compare`, and every one of them discards the
 * collation argument `createTypedComparator` hands it, comparing under BINARY unconditionally.
 * `TEXT_TYPE` supplies no `compare` and so falls to the collation-honoring
 * `compareSqlValuesFast`. The store used to leave such a member's key collation `undefined`,
 * which `encodeValue` reads as "fall back to the table key collation K" (default NOCASE) —
 * enforcing PK uniqueness under NOCASE while the engine compared under BINARY. `'A'` and `'a'`
 * are distinct BINARY values that collided at one NOCASE key, so the second `insert` was
 * rejected and an `insert or replace` silently destroyed the first row.
 *
 * A memory table is the oracle throughout: it compares PK values purely through
 * `createTypedComparator`, which is the behavior the store must reproduce physically.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, asyncIterableToArray, type SqlValue } from '@quereus/quereus';
import { StoreModule, InMemoryKVStore, type KVStoreProvider } from '../src/index.js';

function createInMemoryProvider(): KVStoreProvider {
	const stores = new Map<string, InMemoryKVStore>();
	const get = (key: string) => {
		if (!stores.has(key)) stores.set(key, new InMemoryKVStore());
		return stores.get(key)!;
	};
	return {
		async getStore(s, t) { return get(`${s}.${t}`); },
		async getIndexStore(s, t, i) { return get(`${s}.${t}_idx_${i}`); },
		async getStatsStore(s, t) { return get(`${s}.${t}.__stats__`); },
		async getCatalogStore() { return get('__catalog__'); },
		async closeStore() {},
		async closeIndexStore() {},
		async closeAll() {
			for (const store of stores.values()) await store.close();
			stores.clear();
		},
	};
}

/** Every value of `column` produced by `sql`, in emission order. */
async function column(db: Database, sql: string, name: string): Promise<SqlValue[]> {
	return (await asyncIterableToArray(db.eval(sql))).map(r => r[name] as SqlValue);
}

/** The JSON array of physical operator names for `query`'s plan. */
async function planOps(db: Database, query: string): Promise<string> {
	const rows = await asyncIterableToArray(
		db.eval(`select json_group_array(op) as ops from query_plan(?)`, [query]),
	);
	expect(rows).to.have.lengthOf(1);
	return rows[0].ops as string;
}

/** Runs `sql`, returning the thrown error or null. */
async function attempt(db: Database, sql: string): Promise<Error | null> {
	try {
		await db.exec(sql);
		return null;
	} catch (e) {
		return e as Error;
	}
}

const SEEK = /INDEXSEEK|INDEX SEEK|IndexSeek/i;

describe('PK columns that can hold text but are not textual are keyed under BINARY', () => {
	let db: Database;
	let provider: KVStoreProvider;

	beforeEach(() => {
		db = new Database();
		provider = createInMemoryProvider();
		db.registerModule('store', new StoreModule(provider));
	});

	afterEach(async () => {
		await provider.closeAll();
		await db.close();
	});

	describe('uniqueness is enforced under the collation the engine compares under', () => {
		it("admits both 'A' and 'a' in an `any` PK, as a memory table does", async () => {
			await db.exec(`create table t (k any primary key, v text) using store`);
			await db.exec(`create table m (k any primary key, v text)`);

			for (const t of ['t', 'm']) {
				await db.exec(`insert into ${t} values ('A', 'upper')`);
				expect(await attempt(db, `insert into ${t} values ('a', 'lower')`), `${t} must accept both`)
					.to.be.null;
			}

			expect((await db.get(`select count(*) as cnt from t`))?.cnt).to.equal(2);
			expect((await db.get(`select v from t where k = 'A'`))?.v).to.equal('upper');
			expect((await db.get(`select v from t where k = 'a'`))?.v).to.equal('lower');
		});

		it('admits two `json` PK values that differ only in the case of an object key', async () => {
			await db.exec(`create table t (j json primary key, v text) using store`);
			await db.exec(`create table m (j json primary key, v text)`);

			for (const t of ['t', 'm']) {
				await db.exec(`insert into ${t} values ('{"A":1}', 'upper')`);
				expect(await attempt(db, `insert into ${t} values ('{"a":1}', 'lower')`), `${t} must accept both`)
					.to.be.null;
			}

			expect((await db.get(`select count(*) as cnt from t`))?.cnt).to.equal(2);
			expect((await db.get(`select count(*) as cnt from m`))?.cnt).to.equal(2);
		});

		it('lets an UPDATE move an `any` PK to a value distinct only by case', async () => {
			await db.exec(`create table t (k any primary key, v text) using store`);
			await db.exec(`insert into t values ('A', 'upper'), ('B', 'other')`);

			expect(await attempt(db, `update t set k = 'a' where v = 'other'`)).to.be.null;
			expect((await db.get(`select count(*) as cnt from t`))?.cnt).to.equal(2);
			expect((await db.get(`select v from t where k = 'a'`))?.v).to.equal('other');
			expect((await db.get(`select v from t where k = 'A'`))?.v).to.equal('upper');
		});

		it('does not let `insert or replace` destroy the row at a case-distinct `any` PK', async () => {
			// The data-loss direction: no error, one row silently gone.
			await db.exec(`create table t (k any primary key, v text) using store`);
			await db.exec(`create table m (k any primary key, v text)`);

			for (const t of ['t', 'm']) {
				await db.exec(`insert into ${t} values ('A', 'upper')`);
				await db.exec(`insert or replace into ${t} values ('a', 'lower')`);
			}

			expect((await db.get(`select count(*) as cnt from t`))?.cnt).to.equal(2);
			expect((await db.get(`select count(*) as cnt from m`))?.cnt).to.equal(2);
			expect((await db.get(`select v from t where k = 'A'`))?.v).to.equal('upper');
		});
	});

	describe('the read-side gate that BINARY keying un-declines', () => {
		it('seeks a range over a `date` PK, and returns the comparator-correct rows', async () => {
			await db.exec(`create table t (d date primary key, v text) using store`);
			await db.exec(`create table m (d date primary key, v text)`);
			for (const t of ['t', 'm']) {
				await db.exec(`insert into ${t} values ('2024-01-15', 'jan'), ('2024-06-01', 'jun')`);
			}

			const q = `select v from t where d > '2024-03-01'`;
			expect(await column(db, q, 'v')).to.deep.equal(['jun']);
			expect(await column(db, q, 'v'))
				.to.deep.equal(await column(db, `select v from m where d > '2024-03-01'`, 'v'));
			expect(await planOps(db, q), 'a date PK keys under BINARY, so the seek is sound').to.match(SEEK);
		});

		it('advertises PK order for a mixed-type `any` PK, matching the memory table', async () => {
			// The encoder's type tags order NULL(0x00) < NUMERIC(0x01) < TEXT(0x03) < BLOB(0x04)
			// < OBJECT(0x05), matching the engine's storage-class order used by
			// `compareSqlValuesFast` for cross-class comparison.
			await db.exec(`create table t (k any primary key) using store`);
			await db.exec(`create table m (k any primary key)`);
			for (const t of ['t', 'm']) {
				await db.exec(`insert into ${t} values ('B'), (2), ('aa'), (x'01')`);
			}

			const q = `select k from t order by k`;
			expect(await column(db, q, 'k')).to.deep.equal(await column(db, `select k from m order by k`, 'k'));
			expect(await planOps(db, q), 'byte order is comparator order here').to.not.match(/sort/i);
		});

		it('advertises PK order for a `json` PK, matching the memory table', async () => {
			await db.exec(`create table t (j json primary key) using store`);
			await db.exec(`create table m (j json primary key)`);
			for (const t of ['t', 'm']) {
				await db.exec(`insert into ${t} values ('{"b":1}'), ('{"A":1}'), ('{"a":1}')`);
			}

			const q = `select json_quote(j) as j from t order by j`;
			expect(await column(db, q, 'j'))
				.to.deep.equal(await column(db, `select json_quote(j) as j from m order by j`, 'j'));
			expect(await planOps(db, `select j from t order by j`)).to.not.match(/sort/i);
		});
	});
});
