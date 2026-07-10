/**
 * The store physically orders rows by memcmp of each text key's NORMALIZED bytes, but the
 * engine orders and filters them with the collation's COMPARATOR. `db.registerCollation`
 * promises only that a normalizer partitions strings the way its comparator calls them
 * equal — it says nothing about order. Three store decisions used to assume order anyway:
 *
 *   - the PK byte-range window (`StoreTable.analyzePKAccess` → `buildPKRangeBounds`),
 *   - the secondary-index byte-range window (`StoreTable.analyzeIndexAccess`),
 *   - the PK-order advertisement (`StoreModule.buildPkOrderingAdvertisement`), which elides
 *     the Sort above an `order by <pk>`.
 *
 * Under a normalizer that agrees on equality but disagrees on order, the first two silently
 * DROPPED rows and the third returned them in byte order. All three now consult
 * `Database._isCollationOrderPreserving` and degrade to a full scan / a retained Sort.
 *
 * The probe collation below is a legal registration today: `NOCASE` may be overridden (only
 * `BINARY` is protected). Its normalizer is `toLowerCase`, exactly matching its comparator's
 * equality classes; its comparator orders SHORTER strings first, which byte order does not.
 * A memory table — which orders and filters purely by comparator — is the oracle.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, asyncIterableToArray, type SqlValue } from '@quereus/quereus';
import { StoreModule, InMemoryKVStore, type KVStoreProvider } from '../src/index.js';

/** Lowercase-equal, but SHORTER-first: `'aa' > 'b'` under the comparator, `'aa' < 'b'` in bytes. */
const lower = (s: string): string => s.toLowerCase();
const lengthFirst = (a: string, b: string): number => {
	if (a.length !== b.length) return a.length - b.length;
	const [la, lb] = [lower(a), lower(b)];
	return la < lb ? -1 : la > lb ? 1 : 0;
};

/** Ignores spaces. Its comparator IS the byte order of its normalized forms. */
const stripSpaces = (s: string): string => s.replace(/ /g, '');
const noSpace = (a: string, b: string): number => {
	const [sa, sb] = [stripSpaces(a), stripSpaces(b)];
	return sa < sb ? -1 : sa > sb ? 1 : 0;
};

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

const SEEK = /INDEXSEEK|INDEX SEEK|IndexSeek/i;

describe('Store range seeks and PK-order advertisements under a non-order-preserving collation', () => {
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

	describe('a normalizer that preserves equality but inverts order', () => {
		beforeEach(() => {
			db.registerCollation('NOCASE', lengthFirst, { normalizer: lower });
		});

		it('keeps a text-PK range correct by declining the byte window', async () => {
			await db.exec(`create table t (k text collate nocase primary key, v text) using store`);
			await db.exec(`insert into t values ('aa', 'one'), ('b', 'two')`);

			// Comparator order: 'b' (length 1) < 'aa' (length 2). Byte order: 'aa' < 'b'.
			// A byte window at `> 'b'` would start past 'aa' and yield nothing.
			const q = `select k from t where k > 'b'`;
			expect(await column(db, q, 'k')).to.deep.equal(['aa']);
			expect(await planOps(db, q), 'the PK seek must be declined').to.not.match(SEEK);
		});

		it('keeps a secondary-index range correct by declining the byte window', async () => {
			await db.exec(`create table t (id integer primary key, k text collate nocase) using store`);
			await db.exec(`create index ix_k on t (k)`);
			await db.exec(`insert into t values (1, 'aa'), (2, 'b')`);

			const q = `select id from t where k > 'b'`;
			expect(await column(db, q, 'id')).to.deep.equal([1]);
			expect(await planOps(db, q), 'the index seek must be declined').to.not.match(SEEK);
		});

		it('keeps `order by <text pk>` in comparator order by retaining the Sort', async () => {
			await db.exec(`create table t (k text collate nocase primary key, v text) using store`);
			await db.exec(`insert into t values ('aa', 'one'), ('b', 'two')`);

			// Rows are stored (and iterated) as 'aa' then 'b'; the comparator says 'b' first.
			const q = `select k from t order by k`;
			expect(await column(db, q, 'k')).to.deep.equal(['b', 'aa']);
			expect(await planOps(db, q), 'the Sort must not be elided').to.match(/sort/i);
		});

		it('still answers a point PK seek, which needs only the equality guarantee', async () => {
			await db.exec(`create table t (k text collate nocase primary key, v text) using store`);
			await db.exec(`insert into t values ('aa', 'one'), ('b', 'two')`);

			expect((await db.get(`select v from t where k = 'B'`))?.v).to.equal('two');
			expect((await db.get(`select v from t where k = 'AA'`))?.v).to.equal('one');
		});

		it('agrees with a memory table on every one of the above', async () => {
			// The oracle: memory tables compare and order purely by the comparator.
			await db.exec(`create table m (k text collate nocase primary key, v text)`);
			await db.exec(`create table mi (id integer primary key, k text collate nocase)`);
			await db.exec(`create index ix_mk on mi (k)`);
			await db.exec(`insert into m values ('aa', 'one'), ('b', 'two')`);
			await db.exec(`insert into mi values (1, 'aa'), (2, 'b')`);

			await db.exec(`create table t (k text collate nocase primary key, v text) using store`);
			await db.exec(`create table ti (id integer primary key, k text collate nocase) using store`);
			await db.exec(`create index ix_tk on ti (k)`);
			await db.exec(`insert into t values ('aa', 'one'), ('b', 'two')`);
			await db.exec(`insert into ti values (1, 'aa'), (2, 'b')`);

			expect(await column(db, `select k from t where k > 'b'`, 'k'))
				.to.deep.equal(await column(db, `select k from m where k > 'b'`, 'k'));
			expect(await column(db, `select id from ti where k > 'b'`, 'id'))
				.to.deep.equal(await column(db, `select id from mi where k > 'b'`, 'id'));
			expect(await column(db, `select k from t order by k`, 'k'))
				.to.deep.equal(await column(db, `select k from m order by k`, 'k'));
			expect((await db.get(`select v from t where k = 'B'`))?.v)
				.to.equal((await db.get(`select v from m where k = 'B'`))?.v);
		});
	});

	describe('a normalizer asserted order-preserving', () => {
		it('keeps the PK range seek and returns comparator-correct rows', async () => {
			db.registerCollation('NOCASE', noSpace, { normalizer: stripSpaces, orderPreserving: true });
			await db.exec(`create table t (k text collate nocase primary key, v text) using store`);
			await db.exec(`insert into t values ('a b', 'one'), ('c d', 'two'), ('e', 'three')`);

			// 'ab' < 'cd' < 'e' both by comparator and by normalized bytes.
			const q = `select k from t where k > 'ab'`;
			expect(await column(db, q, 'k')).to.deep.equal(['c d', 'e']);
			expect(await planOps(db, q), 'the PK seek must be kept').to.match(SEEK);
		});

		it('advertises PK order, eliding the Sort', async () => {
			db.registerCollation('NOCASE', noSpace, { normalizer: stripSpaces, orderPreserving: true });
			await db.exec(`create table t (k text collate nocase primary key, v text) using store`);
			await db.exec(`insert into t values ('c d', 'two'), ('a b', 'one'), ('e', 'three')`);

			const q = `select k from t order by k`;
			expect(await column(db, q, 'k')).to.deep.equal(['a b', 'c d', 'e']);
			expect(await planOps(db, q), 'byte order is comparator order here').to.not.match(/sort/i);
		});

		it('returns identical rows without the assertion — the gate costs speed, never rows', async () => {
			// Same comparator + normalizer pair, registered WITHOUT `orderPreserving`.
			db.registerCollation('NOCASE', noSpace, stripSpaces);
			await db.exec(`create table t (k text collate nocase primary key, v text) using store`);
			await db.exec(`insert into t values ('a b', 'one'), ('c d', 'two'), ('e', 'three')`);

			const q = `select k from t where k > 'ab'`;
			expect(await column(db, q, 'k')).to.deep.equal(['c d', 'e']);
			expect(await planOps(db, q), 'no assertion ⇒ no seek').to.not.match(SEEK);
			expect(await column(db, `select k from t order by k`, 'k')).to.deep.equal(['a b', 'c d', 'e']);
		});
	});

	describe('shapes the gate must leave alone', () => {
		it('keeps an integer-PK range seek — non-text key bytes are collation-independent', async () => {
			db.registerCollation('NOCASE', lengthFirst, { normalizer: lower });
			await db.exec(`create table t (id integer primary key, v text) using store`);
			await db.exec(`insert into t values (1, 'a'), (2, 'b'), (3, 'c')`);

			const q = `select id from t where id > 1`;
			expect(await column(db, q, 'id')).to.deep.equal([2, 3]);
			expect(await planOps(db, q)).to.match(SEEK);
		});

		it('keeps the built-in NOCASE text-PK range seek', async () => {
			await db.exec(`create table t (k text collate nocase primary key) using store`);
			await db.exec(`insert into t values ('apple'), ('Banana'), ('cherry')`);

			const q = `select k from t where k > 'banana'`;
			expect(await column(db, q, 'k')).to.deep.equal(['cherry']);
			expect(await planOps(db, q)).to.match(SEEK);
		});

		it('keeps the equality index seek even when K is coarser than the column collation', async () => {
			// K = NOCASE (the store default), C = BINARY. Sound for EQUALITY — every
			// C-equal row normalizes into the window — and untouched by the range gate.
			await db.exec(`create table t (id integer primary key, v text) using store`);
			await db.exec(`create index ix_v on t (v)`);
			await db.exec(`insert into t values (1, 'x'), (2, 'y')`);

			const q = `select id from t where v = 'y'`;
			expect(await column(db, q, 'id')).to.deep.equal([2]);
			expect(await planOps(db, q)).to.match(SEEK);
		});

		it('declines the PK RANGE seek on an `any` PK, whose bytes key under K but compare under BINARY', async () => {
			// `resolvePkKeyCollations` leaves an ANY member undefined (it carries no `isTextual`
			// marker), so its key bytes fall back to K = NOCASE while the engine compares it
			// under BINARY. 'B' (0x42) < 'aa' (0x61…) by BINARY, but keys as 'b' (0x62) > 'aa'.
			await db.exec(`create table t (k any primary key, v text) using store`);
			await db.exec(`insert into t values ('aa', 'one'), ('B', 'two')`);

			const q = `select v from t where k > 'B'`;
			expect(await column(db, q, 'v')).to.deep.equal(['one']);
			expect(await planOps(db, q), 'the PK seek must be declined').to.not.match(SEEK);
		});

		it('declines the index RANGE seek when K is merely coarser, and still returns every row', async () => {
			// K = NOCASE, C = BINARY. 'K' (U+212A KELVIN SIGN) is > 'z' under BINARY, but its
			// index bytes are `toLowerCase('K') = 'k'`, which sorts BEFORE 'z' — a K-window at
			// `> 'z'` would drop it. The gate declines the seek; the residual finds the row.
			await db.exec(`create table t (id integer primary key, v text) using store`);
			await db.exec(`create index ix_v on t (v)`);
			await db.exec(`insert into t values (1, 'K'), (2, 'a')`);

			const q = `select id from t where v > 'z'`;
			expect(await column(db, q, 'id')).to.deep.equal([1]);
			expect(await planOps(db, q), 'the index range seek must be declined').to.not.match(SEEK);
		});
	});
});
