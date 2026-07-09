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
import { Database, asyncIterableToArray, IndexConstraintOp, type SqlValue } from '@quereus/quereus';
import {
	StoreModule,
	StoreTable,
	InMemoryKVStore,
	type KVStoreProvider,
	type IterateOptions,
	type KVEntry,
} from '../src/index.js';

/**
 * In-memory data store that tallies how many entries its `iterate` actually
 * yields. Lets a test prove a selective PK range SEEKS a narrow window rather
 * than full-scanning and post-filtering (both return identical rows, so only the
 * visit count distinguishes them).
 */
class CountingKVStore extends InMemoryKVStore {
	public iterateEntryCount = 0;
	override async *iterate(options?: IterateOptions): AsyncIterable<KVEntry> {
		for await (const entry of super.iterate(options)) {
			this.iterateEntryCount++;
			yield entry;
		}
	}
}

/**
 * Provider whose DATA stores are {@link CountingKVStore}s (recorded in the
 * supplied `dataStores` map, keyed `schema.table`); index/stats/catalog stores
 * stay plain so only data-row iteration is counted.
 */
function createCountingProvider(dataStores: Map<string, CountingKVStore>): KVStoreProvider {
	const auxStores = new Map<string, InMemoryKVStore>();
	const aux = (key: string): InMemoryKVStore => {
		let s = auxStores.get(key);
		if (!s) { s = new InMemoryKVStore(); auxStores.set(key, s); }
		return s;
	};
	return {
		async getStore(schemaName: string, tableName: string) {
			const key = `${schemaName}.${tableName}`;
			let s = dataStores.get(key);
			if (!s) { s = new CountingKVStore(); dataStores.set(key, s); }
			return s;
		},
		async getIndexStore(schemaName: string, tableName: string, indexName: string) {
			return aux(`${schemaName}.${tableName}_idx_${indexName}`);
		},
		async getStatsStore(schemaName: string, tableName: string) {
			return aux(`${schemaName}.${tableName}.__stats__`);
		},
		async getCatalogStore() {
			return aux('__catalog__');
		},
		async closeStore() {},
		async closeIndexStore() {},
		async closeAll() {
			for (const s of dataStores.values()) await s.close();
			for (const s of auxStores.values()) await s.close();
			dataStores.clear();
			auxStores.clear();
		},
	};
}

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

		// DESC + non-BINARY collation on the SAME leading PK column: buildPKRangeBounds
		// must apply BOTH the lower/upper byte-bound SWAP (DESC) and the NOCASE encoder
		// to each bound. A bug in either dimension under-fetches (missing rows).
		describe('DESC NOCASE primary key', () => {
			beforeEach(async () => {
				await db.exec(`create table dfruits (name text collate NOCASE primary key desc, n integer) using store`);
				await db.exec(`insert into dfruits values ('apple', 1), ('Banana', 2), ('CHERRY', 3), ('date', 4)`);
			});

			it('range seeks under both DESC and NOCASE and returns the correct rows', async () => {
				const q = `select n from dfruits where name > 'banana' order by n`;
				expect(await planOps(q)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
				expect(await values(q)).to.deep.equal([3, 4]);
			});

			it('BETWEEN seeks under both DESC and NOCASE and honours both bounds', async () => {
				const q = `select n from dfruits where name between 'banana' and 'cherry' order by n`;
				expect(await planOps(q)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
				expect(await values(q)).to.deep.equal([2, 3]);
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

	// DESC leading PK: buildPKRangeBounds' lower/upper byte-bound assignment SWAPS
	// (a `>` seeks the smaller-bytes window). A wrong swap that under-fetches would
	// show up as missing rows here.
	describe('DESC leading primary key', () => {
		beforeEach(async () => {
			await db.exec(`create table d (id integer primary key desc, n integer) using store`);
			await db.exec(`insert into d values (1, 10), (2, 20), (3, 30), (4, 40)`);
		});

		it('> k seeks and returns the correct rows', async () => {
			const rows = await asyncIterableToArray(db.eval(`select n from d where id > 2 order by id`));
			expect(rows.map(r => r.n)).to.deep.equal([30, 40]);
		});

		it('between a and b seeks and returns the correct rows', async () => {
			const rows = await asyncIterableToArray(db.eval(`select n from d where id between 2 and 3 order by id`));
			expect(rows.map(r => r.n)).to.deep.equal([20, 30]);
		});
	});

	// Regression for `store-blob-key-varint-not-memcmp-ordered`: a BLOB primary key
	// must encode so its stored bytes sort element-by-element (matching SQL blob
	// comparison). The old length-prefix layout sorted a shorter blob before a
	// longer one regardless of content, so a leading-PK range seek silently dropped
	// qualifying rows the mis-ordered window skipped (matchesFilters can only
	// re-filter rows the seek already yielded — it cannot recover a skipped one).
	describe('blob primary key range seek (store-blob-key-varint-not-memcmp-ordered)', () => {
		// x'0102' < x'03' element-wise (0x01 < 0x03), yet a length-first byte layout
		// sorts the shorter x'03' (len 1) before x'0102' (len 2). x'0102ff' also
		// exercises prefix < extension (a proper prefix must sort before its
		// extensions). Ordered by b: x'0102'(1), x'0102ff'(3), x'03'(2).
		async function seedBlobs(name: string, using: string): Promise<void> {
			await db.exec(`create table ${name} (b blob primary key, n integer) ${using}`);
			await db.exec(`insert into ${name} values (x'0102', 1), (x'03', 2), (x'0102ff', 3)`);
		}

		it('ASC: b >= x\'0102\' matches the memory-vtab oracle (no under-fetch)', async () => {
			await seedBlobs('bstore', 'using store');
			await seedBlobs('bmem', ''); // default in-memory vtab = full-scan oracle
			const q = (t: string) => `select n from ${t} where b >= x'0102' order by b`;
			const storeRows = (await asyncIterableToArray(db.eval(q('bstore')))).map(r => r.n);
			const memRows = (await asyncIterableToArray(db.eval(q('bmem')))).map(r => r.n);
			// Oracle and store agree, and both equal the element-wise order.
			expect(memRows).to.deep.equal([1, 3, 2]);
			expect(storeRows).to.deep.equal(memRows);
		});

		it('ASC: b > x\'0102\' excludes the equal blob', async () => {
			await seedBlobs('bstore2', 'using store');
			const rows = await asyncIterableToArray(db.eval(`select n from bstore2 where b > x'0102' order by b`));
			expect(rows.map(r => r.n)).to.deep.equal([3, 2]);
		});

		// DESC blob PK: encodeCompositeKey bit-inverts each component's bytes; the
		// variable-length + terminator scheme must stay order-correct under inversion.
		it('DESC: b >= x\'0102\' seeks under inversion and returns correct rows', async () => {
			await db.exec(`create table bdesc (b blob primary key desc, n integer) using store`);
			await db.exec(`insert into bdesc values (x'0102', 1), (x'03', 2), (x'0102ff', 3)`);
			const rows = await asyncIterableToArray(db.eval(`select n from bdesc where b >= x'0102' order by b desc`));
			// order by b desc: x'03'(2), x'0102ff'(3), x'0102'(1)
			expect(rows.map(r => r.n)).to.deep.equal([2, 3, 1]);
		});
	});

	// Regression for `store-numeric-key-mixed-int-real-sort-order`: a numeric primary
	// key that mixes whole and fractional values must encode so its stored bytes sort
	// by numeric VALUE, not by JS runtime shape. The old per-shape TYPE_INTEGER(0x01) <
	// TYPE_REAL(0x02) tag made every whole number sort below every fractional one, so a
	// leading-PK range seek built a byte window that skipped qualifying whole numbers
	// the mis-ordered layout placed outside it (matchesFilters can only re-filter rows
	// the seek already yielded — it cannot recover a skipped one).
	describe('numeric primary key mixed int/real range seek (store-numeric-key-mixed-int-real-sort-order)', () => {
		// Whole numbers (2, 3) interleave with fractional (2.5, 3.5); the whole ones
		// must NOT all sort before the fractional ones. Ordered by x: 2, 2.5, 3, 3.5.
		async function seedNums(name: string, using: string): Promise<void> {
			await db.exec(`create table ${name} (x real primary key, n integer) ${using}`);
			await db.exec(`insert into ${name} values (2, 20), (2.5, 25), (3, 30), (3.5, 35)`);
		}

		it("ASC: x >= 2.5 matches the memory-vtab oracle (no under-fetch)", async () => {
			await seedNums('nstore', 'using store');
			await seedNums('nmem', ''); // default in-memory vtab = full-scan oracle
			const q = (t: string) => `select n from ${t} where x >= 2.5 order by x`;
			const storeRows = (await asyncIterableToArray(db.eval(q('nstore')))).map(r => r.n);
			const memRows = (await asyncIterableToArray(db.eval(q('nmem')))).map(r => r.n);
			expect(memRows).to.deep.equal([25, 30, 35]); // 2.5, 3, 3.5 — includes whole 3
			expect(storeRows).to.deep.equal(memRows);     // FAILS pre-fix: store drops n=30
		});

		it('BETWEEN spanning the int/real boundary matches the oracle', async () => {
			await seedNums('nstore2', 'using store');
			await seedNums('nmem2', '');
			const q = (t: string) => `select n from ${t} where x between 2.5 and 3 order by x`;
			const storeRows = (await asyncIterableToArray(db.eval(q('nstore2')))).map(r => r.n);
			const memRows = (await asyncIterableToArray(db.eval(q('nmem2')))).map(r => r.n);
			expect(memRows).to.deep.equal([25, 30]); // 2.5, 3
			expect(storeRows).to.deep.equal(memRows);
		});

		// DESC numeric PK: encodeCompositeKey bit-inverts the whole 17-byte component;
		// the fixed-width layout must stay order-correct under inversion.
		it('DESC: x >= 2.5 seeks under inversion and matches the oracle', async () => {
			await db.exec(`create table ndesc (x real primary key desc, n integer) using store`);
			await db.exec(`insert into ndesc values (2, 20), (2.5, 25), (3, 30), (3.5, 35)`);
			const rows = await asyncIterableToArray(db.eval(`select n from ndesc where x >= 2.5 order by x desc`));
			// order by x desc: 3.5(35), 3(30), 2.5(25)
			expect(rows.map(r => r.n)).to.deep.equal([35, 30, 25]);
		});

		// NOTE: an end-to-end SQL range seek over |int| >= 2^53 through the store
		// (the "gap 1" combined test) is now unblocked — the upstream change-log
		// crash on a bigint PK (serializeKeyTuple -> canonicalJsonString ->
		// JSON.stringify) was fixed under txn-changelog-bigint-key (the change log
		// now keys via the reversible key-tuple-codec). The STORE encoding of large
		// ints is proven at the unit level in encoding.spec.ts (byte order + exact
		// roundtrip across the shared-double boundary); the combined store-path SQL
		// test is not yet written — tracked in
		// backlog/debt-bigint-pk-store-range-seek-test.
	});

	// A leading PK key collation with NO registered byte encoder must NOT produce a
	// narrowed window — `encodeText` silently falls back to NOCASE bytes that do not
	// track the column's logical order, so a derived window could under-fetch.
	// `matchesFilters` (collation-aware) stays authoritative on the full scan.
	//
	// The engine restricts TEXT column collations to BINARY/NOCASE/RTRIM (all of
	// which DO have a byte encoder), so this branch is defensive and unreachable via
	// DDL today; we exercise it white-box by setting the key collation directly.
	describe('comparator-only collation falls back to full scan (buildPKRangeBounds)', () => {
		// Structural view of the protected surface under test.
		interface RangeBoundsProbe {
			pkKeyCollations: (string | undefined)[];
			buildPKRangeBounds(access: {
				type: 'range';
				columnIndex: number;
				constraints: Array<{ columnIndex: number; op: IndexConstraintOp; value?: SqlValue }>;
			}): IterateOptions;
		}

		const gtBananaBounds = (table: StoreTable): IterateOptions =>
			(table as unknown as RangeBoundsProbe).buildPKRangeBounds({
				type: 'range',
				columnIndex: 0,
				constraints: [{ columnIndex: 0, op: IndexConstraintOp.GT, value: 'banana' }],
			});

		it('returns full-scan bounds when the leading PK collation has no byte encoder', async () => {
			await db.exec(`create table sorted (name text collate NOCASE primary key, n integer) using store`);
			const table = storeModule.getTable('main', 'sorted');
			expect(table, 'store table should be registered after create').to.exist;

			// Force a comparator-only key collation (no registered byte encoder).
			(table as unknown as RangeBoundsProbe).pkKeyCollations = ['CUSTOMSORT'];

			const bounds = gtBananaBounds(table!);
			// Full-scan bounds: empty gte, no lt — NOT a narrowed window.
			expect(bounds.lt, 'comparator-only PK must not narrow the upper bound').to.be.undefined;
			expect(bounds.gte, 'comparator-only PK must keep an unbounded lower bound').to.have.lengthOf(0);
		});

		it('a registered-encoder (NOCASE) PK DOES narrow (positive control)', async () => {
			await db.exec(`create table plain (name text collate NOCASE primary key, n integer) using store`);
			const table = storeModule.getTable('main', 'plain');
			expect(table).to.exist;

			const bounds = gtBananaBounds(table!);
			expect(bounds.gte, 'NOCASE PK should seek to a lower bound').to.exist;
			expect(bounds.gte!.length, 'NOCASE PK should seek to a non-empty lower bound').to.be.greaterThan(0);
		});
	});

	// Distinguish a real seek from full-scan + filter: only the latter visits every
	// row. Uses a CountingKVStore data store and asserts the visit count.
	describe('window narrowing (real seek, not full-scan + filter)', () => {
		let cdb: Database;
		let cprovider: KVStoreProvider;
		let dataStores: Map<string, CountingKVStore>;

		async function seed(table: string, pkClause: string): Promise<CountingKVStore> {
			await cdb.exec(`create table ${table} (id integer primary key ${pkClause}, n integer) using store`);
			const vals = Array.from({ length: 100 }, (_, i) => `(${i}, ${i})`).join(', ');
			await cdb.exec(`insert into ${table} values ${vals}`);
			const store = dataStores.get(`main.${table}`);
			expect(store, `data store for ${table} should exist`).to.exist;
			store!.iterateEntryCount = 0;
			return store!;
		}

		beforeEach(() => {
			dataStores = new Map();
			cprovider = createCountingProvider(dataStores);
			cdb = new Database();
			cdb.registerModule('store', new StoreModule(cprovider));
		});

		afterEach(async () => {
			await cprovider.closeAll();
		});

		it('a selective ASC range visits far fewer entries than the full row count', async () => {
			const store = await seed('nums', '');
			const rows = await asyncIterableToArray(cdb.eval(`select n from nums where id > 95 order by id`));
			expect(rows.map(r => r.n)).to.deep.equal([96, 97, 98, 99]);
			// Seek lands just past id=95 and early-terminates: ~4 entries visited, not
			// 100. A full-scan + post-filter implementation would visit all 100.
			expect(store.iterateEntryCount, 'seek should visit only the in-window slice').to.be.lessThanOrEqual(5);
		});

		it('a selective DESC range narrows (proves the swap over-fetches nothing)', async () => {
			const store = await seed('dnums', 'desc');
			const rows = await asyncIterableToArray(cdb.eval(`select n from dnums where id > 95 order by id`));
			expect(rows.map(r => r.n)).to.deep.equal([96, 97, 98, 99]);
			// DESC `> 95` seeks the lt = lo(95) window (smaller bytes ⇒ larger values).
			expect(store.iterateEntryCount, 'DESC seek should visit only the in-window slice').to.be.lessThanOrEqual(5);
		});

		it('an empty / contradictory window yields no rows without error', async () => {
			const store = await seed('nums', '');
			const rows = await asyncIterableToArray(cdb.eval(`select n from nums where id > 10 and id < 5`));
			expect(rows).to.deep.equal([]);
			// gte > lt ⇒ the KVStore iterate yields nothing; no throw, no visits.
			expect(store.iterateEntryCount).to.equal(0);
		});

		it('reads-own-writes: an uncommitted row inside the window surfaces', async () => {
			await seed('nums', '');
			await cdb.exec('begin');
			await cdb.exec(`insert into nums values (200, 200)`);
			await cdb.exec(`update nums set n = 970 where id = 97`);
			const rows = await asyncIterableToArray(cdb.eval(`select n from nums where id > 95 order by id`));
			await cdb.exec('commit');
			// 96, 97(updated→970), 98, 99, 200(pending insert) — all within id>95.
			expect(rows.map(r => r.n)).to.deep.equal([96, 970, 98, 99, 200]);
		});
	});

	// Secondary-index scan arm (store-index-scan-read-primitive): StoreTable.query
	// derives an encoded window over the chosen secondary index and resolves each
	// entry to its base row, and getBestAccessPlan advertises the index with
	// honestly-handled filters — subject to the collation-safety guard.
	describe('secondary-index scan (store-index-scan-read-primitive)', () => {
		async function planOps(query: string): Promise<string> {
			const rows = await asyncIterableToArray(
				db.eval(`select json_group_array(op) as ops from query_plan(?)`, [query]),
			);
			expect(rows).to.have.lengthOf(1);
			return rows[0].ops as string;
		}

		it('EQ on an indexed non-text column seeks the index and returns correct rows', async () => {
			await db.exec(`create table t (id integer primary key, name text, age integer) using store`);
			await db.exec(`create index ix_age on t (age)`);
			await db.exec(`insert into t values (1, 'Alice', 30), (2, 'Bob', 25), (3, 'Carol', 30)`);

			const q = `select id from t where age = 30 order by id`;
			expect(await planOps(q)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
			expect(await asyncIterableToArray(db.eval(q))).to.deep.equal([{ id: 1 }, { id: 3 }]);
		});

		it('range on an indexed non-text column seeks the index and returns correct rows', async () => {
			await db.exec(`create table t (id integer primary key, name text, age integer) using store`);
			await db.exec(`create index ix_age on t (age)`);
			await db.exec(`insert into t values (1, 'Alice', 30), (2, 'Bob', 25), (3, 'Carol', 35)`);

			const q = `select id from t where age > 25 order by age`;
			expect(await planOps(q)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
			expect(await asyncIterableToArray(db.eval(q))).to.deep.equal([{ id: 1 }, { id: 3 }]);
		});

		it('text EQ on a NOCASE column (declared == K) seeks and matches case-insensitively', async () => {
			// The column is declared COLLATE NOCASE so matchesFilters compares under
			// NOCASE, matching the store's default key collation K = NOCASE (declared ==
			// K → collation-safe seek). Without the explicit COLLATE the column would be
			// BINARY and `= 'alice'` would match nothing (a distinct, correct behavior).
			await db.exec(`create table t (id integer primary key, name text collate nocase) using store`);
			await db.exec(`create index ix_name on t (name)`);
			await db.exec(`insert into t values (1, 'Alice'), (2, 'bob'), (3, 'ALICE')`);

			const q = `select id from t where name = 'alice' order by id`;
			expect(await planOps(q)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
			expect(await asyncIterableToArray(db.eval(q))).to.deep.equal([{ id: 1 }, { id: 3 }]);
		});

		it('composite index: full-prefix EQ and leading-only EQ both return correct rows', async () => {
			await db.exec(`create table t (id integer primary key, a integer, b integer) using store`);
			await db.exec(`create index ix_ab on t (a, b)`);
			await db.exec(`insert into t values (1, 5, 10), (2, 5, 20), (3, 6, 10)`);

			// Full prefix (a, b) → single-entry point.
			const q1 = `select id from t where a = 5 and b = 20`;
			expect(await planOps(q1)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
			expect(await asyncIterableToArray(db.eval(q1))).to.deep.equal([{ id: 2 }]);

			// Leading column only → prefix window over both a = 5 rows.
			const q2 = `select id from t where a = 5 order by id`;
			expect(await planOps(q2)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
			expect(await asyncIterableToArray(db.eval(q2))).to.deep.equal([{ id: 1 }, { id: 2 }]);
		});

		it('DESC index column seeks under byte inversion and returns correct rows', async () => {
			await db.exec(`create table t (id integer primary key, v integer) using store`);
			await db.exec(`create index ix_v on t (v desc)`);
			await db.exec(`insert into t values (1, 10), (2, 20), (3, 30)`);

			const q = `select id from t where v > 15 order by v`;
			expect(await planOps(q)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
			expect(await asyncIterableToArray(db.eval(q))).to.deep.equal([{ id: 2 }, { id: 3 }]);
		});

		it('a partial index is NOT chosen for a seek (no predicate-implication check); rows stay correct', async () => {
			await db.exec(`create table t (id integer primary key, v integer) using store`);
			await db.exec(`create index ix_pos on t (v) where v > 0`);
			await db.exec(`insert into t values (1, 10), (2, 20), (3, -5)`);

			// A partial index physically omits out-of-scope rows; since nothing checks
			// that the query's WHERE implies the index predicate, the store must NOT seek
			// it (it would drop rows an out-of-scope query needs). It full-scans +
			// residual instead — no index seek, correct rows.
			const inScope = `select id from t where v = 20`;
			expect(await planOps(inScope), 'partial index not chosen for a seek').to.not.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
			expect(await asyncIterableToArray(db.eval(inScope))).to.deep.equal([{ id: 2 }]);

			// An out-of-scope query (needs the row the partial index omits) is correct.
			const outScope = `select id from t where v = -5`;
			expect(await asyncIterableToArray(db.eval(outScope))).to.deep.equal([{ id: 3 }]);
		});

		// Collation-safety guard against under-fetch: a BINARY-config store (K = BINARY)
		// with an index on a NOCASE-declared column would MISS a case-variant row if the
		// BINARY window were trusted, so the plan must NOT mark the filter handled — no
		// index seek, residual retained, and the result stays NOCASE-correct.
		it('collation-unsafe index (K=BINARY over a NOCASE column) declines the seek but stays correct', async () => {
			await db.exec(`create table t (id integer primary key, v text collate nocase) using store (collation = binary)`);
			await db.exec(`create index ix_v on t (v)`);
			await db.exec(`insert into t values (1, 'Apple'), (2, 'apple'), (3, 'Banana')`);

			const q = `select id from t where v = 'apple' order by id`;
			expect(await planOps(q), 'guard leaves the filter unhandled — no index seek').to.not.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
			// NOCASE-correct: both 'Apple' and 'apple' match.
			expect(await asyncIterableToArray(db.eval(q))).to.deep.equal([{ id: 1 }, { id: 2 }]);
		});
	});
});
