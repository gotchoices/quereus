/**
 * Predicate-pushdown tests for StoreModule.getBestAccessPlan.
 *
 * Regression: getBestAccessPlan must only mark range filters as `handled`
 * when they target the leading PK column, because the legacy access-path
 * planner only forwards range bounds for primaryKeyDefinition[0]. Marking a
 * non-leading PK range as handled would cause the residual predicate to be
 * silently dropped — particularly visible on tables without an explicit
 * PRIMARY KEY (where every column becomes a PK column).
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, asyncIterableToArray } from '@quereus/quereus';
import {
	StoreModule,
	InMemoryKVStore,
	type KVStoreProvider,
} from '../src/index.js';

function createInMemoryProvider(): KVStoreProvider {
	const stores = new Map<string, InMemoryKVStore>();

	return {
		async getStore(schemaName: string, tableName: string) {
			const key = `${schemaName}.${tableName}`;
			if (!stores.has(key)) {
				stores.set(key, new InMemoryKVStore());
			}
			return stores.get(key)!;
		},
		async getIndexStore(schemaName: string, tableName: string, indexName: string) {
			const key = `${schemaName}.${tableName}_idx_${indexName}`;
			if (!stores.has(key)) {
				stores.set(key, new InMemoryKVStore());
			}
			return stores.get(key)!;
		},
		async getStatsStore(schemaName: string, tableName: string) {
			const key = `${schemaName}.${tableName}.__stats__`;
			if (!stores.has(key)) {
				stores.set(key, new InMemoryKVStore());
			}
			return stores.get(key)!;
		},
		async getCatalogStore() {
			const key = '__catalog__';
			if (!stores.has(key)) {
				stores.set(key, new InMemoryKVStore());
			}
			return stores.get(key)!;
		},
		async closeStore(_schemaName: string, _tableName: string) {},
		async closeIndexStore(_schemaName: string, _tableName: string, _indexName: string) {},
		async closeAll() {
			for (const store of stores.values()) {
				await store.close();
			}
			stores.clear();
		},
	};
}

describe('StoreModule predicate pushdown', () => {
	let db: Database;
	let provider: KVStoreProvider;

	beforeEach(() => {
		db = new Database();
		provider = createInMemoryProvider();
		const storeModule = new StoreModule(provider);
		db.registerModule('store', storeModule);
	});

	afterEach(async () => {
		await provider.closeAll();
	});

	describe('explicit PRIMARY KEY (id)', () => {
		beforeEach(async () => {
			await db.exec(`
				create table users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER) using store
			`);
			await db.exec(`insert into users values (1, 'Alice', 30), (2, 'Bob', 25), (3, 'Carol', 35)`);
		});

		it('range on PK column id returns correct rows (range-scan path)', async () => {
			const rows = await asyncIterableToArray(db.eval(`select id, name from users where id > 1 order by id`));
			expect(rows).to.deep.equal([
				{ id: 2, name: 'Bob' },
				{ id: 3, name: 'Carol' },
			]);
		});

		it('range on non-PK column age returns correct rows (residual on full scan)', async () => {
			const rows = await asyncIterableToArray(db.eval(`select age, name from users where age > 25 order by age`));
			expect(rows).to.deep.equal([
				{ age: 30, name: 'Alice' },
				{ age: 35, name: 'Carol' },
			]);
		});
	});

	describe('table without explicit PRIMARY KEY', () => {
		beforeEach(async () => {
			// No PK declared — every column becomes part of the implicit PK.
			await db.exec(`
				create table users (id INTEGER, name TEXT, age INTEGER) using store
			`);
			await db.exec(`insert into users values (1, 'Alice', 30), (2, 'Bob', 25), (3, 'Carol', 35)`);
		});

		it('range on first column id returns correct rows', async () => {
			const rows = await asyncIterableToArray(db.eval(`select id, name from users where id > 1 order by id`));
			expect(rows).to.deep.equal([
				{ id: 2, name: 'Bob' },
				{ id: 3, name: 'Carol' },
			]);
		});

		// Regression: under the old behavior, getBestAccessPlan would mark this
		// range as handled even though the legacy planner only forwards ranges
		// on the first PK column — so the predicate was silently dropped and
		// every row was returned.
		it('range on non-first column age returns correct rows', async () => {
			const rows = await asyncIterableToArray(db.eval(`select age, name from users where age > 25 order by age`));
			expect(rows).to.deep.equal([
				{ age: 30, name: 'Alice' },
				{ age: 35, name: 'Carol' },
			]);
		});

		it('compound predicate (range + LIKE) on non-first column returns correct rows', async () => {
			const rows = await asyncIterableToArray(db.eval(
				`select age, name from users where age > 25 and name like 'A%' order by age`
			));
			expect(rows).to.deep.equal([
				{ age: 30, name: 'Alice' },
			]);
		});
	});

	// Regression for `store-range-seek-collation-bounds`: the store advertises
	// `honorsCollatedRangeBounds` (its post-fetch row filter compares pushed range
	// bounds under the column's declared collation), so a collation-matched
	// non-BINARY PK range/BETWEEN now uses the index seek — and, because the MATCH
	// cover drops the residual Filter, StoreTable.compareValues alone must
	// reproduce the predicate's collation semantics.
	describe('collated PK range seek (store-range-seek-collation-bounds)', () => {
		async function planOps(query: string): Promise<string> {
			const rows = await asyncIterableToArray(
				db.eval(`select json_group_array(op) as ops from query_plan(?)`, [query]),
			);
			expect(rows).to.have.lengthOf(1);
			return rows[0].ops as string;
		}

		async function values(query: string): Promise<unknown[]> {
			const rows = await asyncIterableToArray(db.eval(query));
			return rows.map(r => r.n);
		}

		describe('NOCASE primary key', () => {
			beforeEach(async () => {
				// NOCASE-distinct values whose BINARY order ('Banana','CHERRY','apple',
				// 'date') differs from NOCASE order — a BINARY bound filter under-fetches.
				await db.exec(`create table fruits (name text collate NOCASE primary key, n integer) using store`);
				await db.exec(`insert into fruits values ('apple', 1), ('Banana', 2), ('CHERRY', 3), ('date', 4)`);
			});

			it('range uses the PK seek and returns NOCASE-correct rows', async () => {
				const q = `select n from fruits where name > 'banana' order by n`;
				expect(await planOps(q)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
				expect(await values(q)).to.deep.equal([3, 4]);
			});

			it('BETWEEN uses the PK seek and honours NOCASE on both bounds', async () => {
				const q = `select n from fruits where name between 'banana' and 'cherry' order by n`;
				expect(await planOps(q)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
				expect(await values(q)).to.deep.equal([2, 3]);
			});

			it('collation-mismatched bound still declines to scan + residual', async () => {
				const q = `select n from fruits where name > 'banana' collate BINARY order by n`;
				const ops = await planOps(q);
				expect(ops).to.not.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
				expect(ops).to.match(/SEQSCAN|SEQ SCAN|SeqScan/i);
				// BINARY: only 'date' is greater than 'banana'.
				expect(await values(q)).to.deep.equal([4]);
			});
		});

		describe('RTRIM primary key', () => {
			beforeEach(async () => {
				await db.exec(`create table pets (val text collate RTRIM primary key, n integer) using store`);
				await db.exec(`insert into pets values ('ant', 1), ('cat ', 2), ('dog', 3)`);
			});

			it("> excludes the RTRIM-equal trailing-space variant", async () => {
				const q = `select n from pets where val > 'cat' order by n`;
				expect(await planOps(q)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
				// 'cat ' RTRIM-equals 'cat' (a raw BINARY compare would over-fetch it).
				expect(await values(q)).to.deep.equal([3]);
			});

			it('>= with a trailing-space bound includes the RTRIM-equal row', async () => {
				const q = `select n from pets where val >= 'cat  ' order by n`;
				expect(await planOps(q)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
				// A raw BINARY compare would under-fetch 'cat ' ('cat ' < 'cat  ' in bytes).
				expect(await values(q)).to.deep.equal([2, 3]);
			});

			it('point lookup matches the RTRIM-equal stored row', async () => {
				// The RTRIM key encoding maps 'cat' to the stored 'cat ' entry, so the
				// post-fetch EQ re-check in matchesFilters must also compare under RTRIM —
				// the old raw `a === b` EQ would have silently dropped the fetched row.
				expect(await values(`select n from pets where val = 'cat'`)).to.deep.equal([2]);
			});
		});

		describe('blob primary key point lookup', () => {
			it('EQ re-check compares blob content, not reference', async () => {
				// The point lookup fetches by key, then matchesFilters re-checks the EQ
				// constraint. The old raw `a === b` EQ compared Uint8Array references,
				// silently dropping every fetched blob row; compareSqlValues compares bytes.
				await db.exec(`create table blobs (b blob primary key, n integer) using store`);
				await db.exec(`insert into blobs values (x'0102', 1), (x'0103', 2)`);
				expect(await values(`select n from blobs where b = x'0102'`)).to.deep.equal([1]);
			});
		});

		describe('explicit BINARY primary key (negative control)', () => {
			it('range seeks and keeps plain BINARY semantics', async () => {
				// Explicit BINARY so the store does not reconcile the PK column to its
				// NOCASE key-collation default.
				await db.exec(`create table bins (name text collate BINARY primary key, n integer) using store`);
				await db.exec(`insert into bins values ('Banana', 1), ('apple', 2), ('CHERRY', 3), ('date', 4)`);
				const q = `select n from bins where name > 'CHERRY' order by n`;
				expect(await planOps(q)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
				// BINARY: uppercase sorts before lowercase, so 'apple' and 'date' qualify.
				expect(await values(q)).to.deep.equal([2, 4]);
			});
		});
	});
});
