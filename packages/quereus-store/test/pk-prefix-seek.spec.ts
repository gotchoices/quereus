/**
 * The primary-key prefix window (`pkPrefixPlan` in store-module-access-plan.ts, served by
 * `StoreTableScan.analyzePKAccess` → `pkPrefixWindow`): an equality on a leading strict
 * prefix of a composite primary key, optionally bounded on the next member, read as one
 * contiguous window of the data store instead of a full scan.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import {
	Database,
	asyncIterableToArray,
	type BestAccessPlanResult,
	type OrderingSpec,
	type PredicateConstraint,
	type SqlValue,
} from '@quereus/quereus';
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

const eq = (columnIndex: number, value: SqlValue): PredicateConstraint =>
	({ columnIndex, op: '=', value, usable: true });
const gt = (columnIndex: number, value: SqlValue): PredicateConstraint =>
	({ columnIndex, op: '>', value, usable: true });
const asc = (columnIndex: number): OrderingSpec => ({ columnIndex, desc: false });

const SORT = /sort/i;

describe('primary-key prefix equality seek', () => {
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
		await db.close();
	});

	function planFor(filters: PredicateConstraint[], requiredOrdering?: OrderingSpec[]): BestAccessPlanResult {
		const table = db.schemaManager.getTable('main', 't')!;
		return storeModule.getBestAccessPlan(db, table, {
			columns: table.columns.map((col, index) => ({
				index,
				name: col.name,
				type: col.logicalType,
				isPrimaryKey: col.primaryKey || false,
				isUnique: col.primaryKey || false,
			})),
			filters,
			requiredOrdering,
			estimatedRows: 1000,
		});
	}

	/** Every value of `name` produced by `sql`, in emission order. */
	async function column(sql: string, name: string): Promise<SqlValue[]> {
		return (await asyncIterableToArray(db.eval(sql))).map(r => r[name] as SqlValue);
	}

	/** `query`'s physical operators and their details, one `op: detail` line per node. */
	async function planText(query: string): Promise<string> {
		const rows = await asyncIterableToArray(db.eval(`select op, detail from query_plan(?)`, [query]));
		return rows.map(r => `${String(r.op)}: ${String(r.detail)}`).join('\n');
	}

	it('advertises a _primary_ prefix seek that claims the prefix, the next member\'s bound, and its order', async () => {
		await db.exec(`create table t (a integer, b integer, v text, primary key (a, b)) using store`);

		const prefix = planFor([eq(0, 1)]);
		expect(prefix.indexName).to.equal('_primary_');
		expect(prefix.seekColumnIndexes).to.deep.equal([0]);
		expect(prefix.handledFilters).to.deep.equal([true]);

		expect(planFor([eq(0, 1)], [asc(1)]).providesOrdering).to.deep.equal([asc(1)]);

		const prefixRange = planFor([eq(0, 1), gt(1, 2)]);
		expect(prefixRange.indexName).to.equal('_primary_');
		expect(prefixRange.seekColumnIndexes).to.deep.equal([0, 1]);
		expect(prefixRange.handledFilters).to.deep.equal([true, true]);
	});

	it('serves order by the next member backwards from the prefix window, with no Sort', async () => {
		await db.exec(`create table t (a integer, b integer, v text, primary key (a, b)) using store`);
		await db.exec(`insert into t values (1, 1, 'x'), (2, 3, 'x'), (2, 1, 'x'), (2, 2, 'x'), (3, 9, 'x')`);
		const q = `select b from t where a = 2 order by b desc`;

		const plan = await planText(q);
		expect(plan).to.not.match(SORT);
		expect(plan).to.match(/INDEX SEEK t USING primary\b/);
		expect(await column(q, 'b')).to.deep.equal([3, 2, 1]);
	});

	it('leaves a plan that chose a secondary index on the leading key member to that index', async () => {
		// Enough rows that `ic`'s free order outranks the primary-key window plus a sort;
		// `c` is scrambled against `b` so primary-key order is visibly not `c` order.
		await db.exec(`create table t (a integer, b integer, c integer, primary key (a, b)) using store`);
		await db.exec(`create index ic on t (a, c desc)`);
		await db.exec(`insert into t select value % 2 + 1, value, (value * 7919) % 1009 from generate_series(1, 1200)`);
		await db.exec(`analyze t`);
		const q = `select b, c from t where a = 2 order by c`;

		const plan = await planText(q);
		expect(plan, 'the plan must choose ic for this test to guard anything').to.match(/USING ic\b/);
		expect(plan).to.not.match(SORT);
		const c = (await column(q, 'c')) as number[];
		expect(c).to.have.lengthOf(600);
		expect(c).to.deep.equal([...c].sort((x, y) => x - y));
	});

	it('swaps the window ends for a bound on a DESC member', async () => {
		await db.exec(`create table t (a integer, b integer, primary key (a, b desc)) using store`);
		await db.exec(`insert into t values (1, 5), (2, 1), (2, 2), (2, 3), (2, 4), (3, 0), (3, 7)`);
		const q = `select b from t where a = 2 and b > 2 order by b desc`;

		const plan = await planText(q);
		expect(plan).to.not.match(SORT);
		expect(plan).to.match(/USING primary\b/);
		expect(await column(q, 'b')).to.deep.equal([4, 3]);
	});
});
